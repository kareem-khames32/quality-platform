/**
 * Resilience core: error classification, per-provider circuit breakers, loop heartbeats and admin alerts.
 *
 * Provider-level problems (no balance, bad key, storage/quota full, rejected configuration, rate limit, provider
 * outage, network to the provider) must never be charged to individual calls. They open the provider's circuit:
 * the lane pauses, every call stays queued, and after a back-off one "probe" call is let through. A success from a
 * call dispatched after the outage began closes the circuit and the lane resumes; failure re-opens it with a longer
 * back-off. State is persisted so a restart does not hammer a broken provider. Admins are alerted when a person has
 * to act (balance, key, quota, configuration) - with a reminder every 6 hours - and told when it recovers.
 */
import { q, getSettings, setSetting } from './db.js';
import { nowIso } from './util.js';

const log = (...a) => console.log(new Date().toISOString(), '[resilience]', ...a);

/* ============================== errors ============================== */

export class ProviderError extends Error {
  /**
   * @param {'stt'|'llm'} provider
   * @param {'billing'|'auth'|'quota'|'config'|'rate_limit'|'provider_down'|'network'} kind
   */
  constructor(provider, kind, message) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.kind = kind;
  }
}

export const KIND_AR = {
  billing: 'الرصيد نفد أو حد الإنفاق/الميزانية انتهى عند المزود',
  auth: 'مفتاح الـ API غير صحيح أو موقوف',
  quota: 'تم تجاوز حد التخزين أو عدد الطلبات عند المزود',
  config: 'المزود بيرفض الإعدادات (موديل / لغة / باراميتر غير صحيح)',
  rate_limit: 'تجاوز معدل الطلبات المسموح مؤقتاً',
  provider_down: 'خدمة المزود متعطلة أو بطيئة جداً مؤقتاً',
  network: 'تعذر الاتصال بالمزود (شبكة / إنترنت)',
};
export const PROVIDER_AR = { stt: 'تحويل الصوت لنص (Soniox)', llm: 'الذكاء الاصطناعي (Claude)' };
const HUMAN_KINDS = new Set(['billing', 'auth', 'quota', 'config']);   // somebody has to act

/**
 * Classify any error thrown while processing one call.
 * scope 'provider' = pause the lane; scope 'call' = this call's own retry policy.
 */
export function classifyCallError(e) {
  if (e && (e instanceof ProviderError || e.name === 'ProviderError')) return { scope: 'provider', kind: e.kind, provider: e.provider };
  const m = String(e?.message || e || '');
  if (/invalid_audio_file|No audio found|audio (is )?(too short|empty)/i.test(m)) return { scope: 'call', kind: 'bad_audio' };
  if (/branch unreachable|EHOSTUNREACH|ECONNREFUSED|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|ENETUNREACH|socket hang up|gateway timeout|timeout http|login failed|branch returned 5\d\d|upstream 5\d\d|search \d{3}/i.test(m)) return { scope: 'call', kind: 'recording_net' };
  if (/recording not found/i.test(m)) return { scope: 'call', kind: 'not_found' };
  if (/LLM (refused|returned no)|ZodError|Unexpected token|JSON/i.test(m)) return { scope: 'call', kind: 'llm_output' };
  return { scope: 'call', kind: 'other' };
}

/** Legacy error texts (before this module existed) that were really provider problems, not call problems. */
export const LEGACY_PROVIDER_ERROR_SQL = `(
  error LIKE 'Soniox upload 429%' OR error LIKE 'Soniox create 429%' OR error LIKE '%limit_exceeded%'
  OR error LIKE '%organization_balance_exhausted%' OR error LIKE '%budget_exhausted%'
  OR error LIKE 'Soniox % 5__:%' OR error LIKE 'Soniox % 401%' OR error LIKE 'Soniox % 402%'
  OR error LIKE '%fetch failed%' OR error LIKE '%EHOSTUNREACH%' OR error LIKE '%ECONNRESET%'
  OR error LIKE '%ETIMEDOUT%' OR error LIKE '%ECONNREFUSED%' OR error LIKE 'STT provider is not configured%'
  OR error LIKE '%credit balance%' OR error LIKE '%overloaded%' OR error LIKE 'Soniox timeout%'
)`;

/* ============================== circuits ============================== */

const FAST = process.env.CQ_TEST_FAST === '1';   // test harness only: seconds instead of minutes
// back-off per failure kind (seconds), one step per consecutive trip
const BACKOFF = {
  billing: [120, 300, 600, 900],
  auth: [120, 300, 600, 900],
  config: [120, 300, 600, 900],
  quota: [30, 90, 300, 600],
  rate_limit: [20, 60, 180, 300],
  provider_down: [30, 90, 300, 600],
  network: [30, 90, 300, 600],
};
const blank = () => ({ state: 'closed', kind: null, message: null, since: null, openedAt: 0, until: 0, trips: 0, probing: false, alerted: false, last_ok_at: null, lastOkMs: 0, last_error_at: null });

function restore(p) {
  try {
    const s = getSettings()[`circuit_${p}`];
    // a restart re-checks a broken provider after 15s instead of trusting the old back-off
    if (s && s.state && s.state !== 'closed') return { ...blank(), ...s, state: 'open', until: Date.now() + (FAST ? 1000 : 15000), probing: false, openedAt: s.openedAt || Date.now() };
  } catch {}
  return blank();
}
const circuits = { stt: restore('stt'), llm: restore('llm') };
const recoverHooks = { stt: [], llm: [] };
// timeouts / 5xx / 429 on single requests among dozens in parallel are blips, not outages: while the provider works,
// the circuit opens only after TRANSIENT_TRIP of them within a minute (billing / auth / quota / config open at once)
const TRANSIENT = new Set(['network', 'provider_down', 'rate_limit']);
const TRANSIENT_TRIP = 3;
const blips = { stt: [], llm: [] };

function persist(p) {
  const c = circuits[p];
  try { setSetting(`circuit_${p}`, { state: c.state, kind: c.kind, message: c.message, since: c.since, openedAt: c.openedAt, until: c.until, trips: c.trips, alerted: c.alerted, last_ok_at: c.last_ok_at, last_error_at: c.last_error_at }); }
  catch (e) { log('persist failed', e.message); }
}

/** Register a callback that runs when the provider recovers (circuit closes). */
export function onRecover(p, fn) { recoverHooks[p].push(fn); }

export function circuitState(p) { return circuits[p].state; }
/** How long the provider has been paused (0 when working). */
export function circuitOpenForMs(p) { const c = circuits[p]; return c.state === 'closed' ? 0 : Date.now() - (c.openedAt || Date.now()); }
/** Wall-clock ms of the provider's last successful call (0 = none since start). */
export function lastSuccessMs(p) { return circuits[p].lastOkMs || 0; }

/**
 * May the lane dispatch one more call to this provider right now?
 * closed -> yes; open -> no until the back-off expires, then exactly one probe (half-open).
 * Only call this when there is a call ready to dispatch, otherwise the probe slot would be taken for nothing.
 */
export function circuitAllows(p) {
  const c = circuits[p];
  if (c.state === 'closed') return true;
  if (c.probing) return false;
  if (Date.now() >= c.until) {
    c.state = 'half_open'; c.probing = true;
    log(`${p}: back-off expired, sending one probe call`);
    return true;
  }
  return false;
}

/**
 * A call to the provider succeeded. `dispatchedAt` is when that call was sent: a success from a call that was sent
 * BEFORE the outage started proves nothing (it was accepted while the provider still worked), so it doesn't close.
 */
export function recordSuccess(p, dispatchedAt = Date.now()) {
  const c = circuits[p];
  c.last_ok_at = nowIso(); c.lastOkMs = Date.now();
  if (c.state === 'closed' || dispatchedAt < c.openedAt) return;
  const was = { kind: c.kind, since: c.since, alerted: c.alerted };
  Object.assign(c, { state: 'closed', kind: null, message: null, until: 0, trips: 0, probing: false, alerted: false, openedAt: 0 });
  persist(p);
  log(`${p}: provider recovered, lane resumes`);
  // only announce recovery when admins were told it was down (no all-clear spam for short rate-limit blips)
  if (was.alerted) notifyAdminsLazy({ kind: 'system', subject: `${PROVIDER_AR[p]} رجع يشتغل`, text: `✅ ${PROVIDER_AR[p]} رجع يشتغل تلقائياً بعد توقف (${KIND_AR[was.kind] || was.kind}) منذ ${was.since}. المكالمات المنتظرة بتكمل دلوقتي.` });
  for (const fn of recoverHooks[p]) { try { fn(); } catch (e) { log('recover hook failed', e.message); } }
}

export function recordFailure(p, err) {
  const c = circuits[p];
  const kind = err?.kind || 'provider_down';
  const msg = String(err?.message || err).slice(0, 400);
  c.last_error_at = nowIso();
  if (c.state === 'closed' && TRANSIENT.has(kind)) {
    const now = Date.now(), win = FAST ? 5000 : 60000;
    blips[p] = blips[p].filter((t) => now - t < win);
    blips[p].push(now);
    if (blips[p].length < TRANSIENT_TRIP) { log(`${p}: ${kind} on one request (${blips[p].length}/${TRANSIENT_TRIP} in a minute), lane keeps running — ${msg}`); return; }
    blips[p] = [];
  }
  // several in-flight calls usually fail together: only the first one moves the circuit
  if (c.state === 'open' && Date.now() < c.until) {
    c.message = msg;
    if (HUMAN_KINDS.has(kind) && c.kind !== kind) { c.kind = kind; maybeAlert(p, c, kind, msg, false); persist(p); }
    return;
  }
  const wasClosed = c.state === 'closed';
  c.trips = wasClosed ? 1 : c.trips + 1;
  const steps = BACKOFF[kind] || BACKOFF.provider_down;
  const sec = FAST ? 2 : steps[Math.min(c.trips - 1, steps.length - 1)];
  Object.assign(c, {
    state: 'open', kind, message: msg, until: Date.now() + sec * 1000, probing: false,
    since: wasClosed ? nowIso() : (c.since || nowIso()), openedAt: wasClosed ? Date.now() : (c.openedAt || Date.now()),
  });
  maybeAlert(p, c, kind, msg, wasClosed);
  persist(p);
  log(`${p}: circuit OPEN (${kind}) for ${sec}s — ${msg}`);
}

function maybeAlert(p, c, kind, msg, wasClosed) {
  let send, everyMin = 60;
  if (HUMAN_KINDS.has(kind)) { send = true; everyMin = 360; }   // needs a person: alert now (also when the kind changes), remind every 6 h
  else if (kind === 'rate_limit') send = c.trips >= 3;           // short rate limits are normal under load
  else send = wasClosed || c.trips === 3;                        // outage / network: once, and again if it persists
  if (!send) return;
  const sent = alertOnce(`paused:${p}:${kind}`, everyMin, () => notifyAdminsLazy({ kind: 'system', subject: `${PROVIDER_AR[p]} متوقف مؤقتاً`,
    text: `⚠️ ${PROVIDER_AR[p]} متوقف مؤقتاً: ${KIND_AR[kind] || kind}.\nالمكالمات محفوظة في الانتظار ومش هتفشل، والنظام بيعيد المحاولة تلقائياً ويكمل أول ما المزود يرجع.${HUMAN_KINDS.has(kind) ? '\nمحتاج تدخل منكم (رصيد / مفتاح / إعدادات).' : ''}\nالتفاصيل: ${msg}` }));
  if (sent) c.alerted = true;
}

/** A probe call ended without reaching the provider (e.g. recording missing): let the next call probe. */
export function releaseProbe(p) {
  const c = circuits[p];
  if (c.state === 'half_open' && c.probing) c.probing = false;
}

/** Admin "try now": expire the back-off so the next dispatch probes immediately. */
export function forceProbe(p) {
  const c = circuits[p];
  if (c.state !== 'closed') { c.until = 0; c.probing = false; c.state = 'open'; persist(p); }
}

export function circuitView(p) {
  const c = circuits[p];
  const left = c.state === 'closed' ? 0 : Math.max(0, Math.ceil((c.until - Date.now()) / 1000));
  return { provider: p, label: PROVIDER_AR[p], state: c.state, kind: c.kind, reason: c.kind ? (KIND_AR[c.kind] || c.kind) : null, message: c.message, since: c.since, retry_in_sec: left, trips: c.trips, last_ok_at: c.last_ok_at, last_error_at: c.last_error_at };
}

/* ============================== heartbeats & health ============================== */

export const heartbeat = { stt: 0, ai: 0, collector: 0, startedAt: Date.now(), enabled: { stt: false, ai: false, collector: false } };
export function beat(k) { heartbeat[k] = Date.now(); heartbeat.enabled[k] = true; }

export function health({ collectorIntervalSec = 300 } = {}) {
  const now = Date.now();
  let dbOk = true;
  try { q.one('SELECT 1 AS ok'); } catch { dbOk = false; }
  const age = (k) => (heartbeat.enabled[k] ? Math.round((now - heartbeat[k]) / 1000) : null);
  const ages = { stt: age('stt'), ai: age('ai'), collector: age('collector') };
  const collectorLimit = Math.max(1200, collectorIntervalSec * 3);
  const problems = [];
  if (!dbOk) problems.push('database');
  if (ages.stt !== null && ages.stt > 180) problems.push('stt_lane_stalled');
  if (ages.ai !== null && ages.ai > 180) problems.push('ai_lane_stalled');
  if (ages.collector !== null && ages.collector > collectorLimit) problems.push('collector_stalled');
  return { ok: problems.length === 0, problems, uptime_sec: Math.round((now - heartbeat.startedAt) / 1000), db: dbOk, heartbeat_age_sec: ages, circuits: { stt: circuits.stt.state, llm: circuits.llm.state }, memory_mb: Math.round(process.memoryUsage().rss / 1048576), node: process.version };
}

/* ============================== alerts ============================== */

const lastAlert = new Map();
/** Run fn at most once per `minutes` for the same key (across the whole process). Returns true when it ran. */
export function alertOnce(key, minutes, fn) {
  const t = lastAlert.get(key) || 0;
  if (Date.now() - t < minutes * 60000) return false;
  lastAlert.set(key, Date.now());
  try { fn(); } catch (e) { log(`alert ${key} failed:`, e.message); }
  return true;
}

// notify.js imports auth/db; load it lazily to keep this module free of import cycles
let _notify = null;
function notifyAdminsLazy(payload) {
  const go = (m) => { try { m.notifyAdmins(payload); } catch (e) { log('notifyAdmins failed', e.message); } };
  if (_notify) return go(_notify);
  import('./notify.js').then((m) => { _notify = m; go(m); }).catch((e) => log('notify import failed', e.message));
}
export { notifyAdminsLazy as notifyAdmins };
