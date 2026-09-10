/**
 * Resilience core: error classification, per-provider circuit breakers, loop heartbeats and admin alerts.
 *
 * Provider-level problems (no balance, bad key, storage/quota full, rate limit, provider outage, network to the
 * provider) must never be charged to individual calls. They open the provider's circuit: the lane pauses, every
 * call stays queued, and after a back-off one "probe" call is let through. Success closes the circuit and the
 * lane resumes at full speed; failure re-opens it with a longer back-off. State is persisted so a restart does
 * not hammer a provider that is known to be broken, and admins are alerted once per incident.
 */
import { db, q, getSettings, setSetting } from './db.js';
import { nowIso } from './util.js';

const log = (...a) => console.log(new Date().toISOString(), '[resilience]', ...a);

/* ============================== errors ============================== */

export class ProviderError extends Error {
  /**
   * @param {'stt'|'llm'} provider
   * @param {'billing'|'auth'|'quota'|'rate_limit'|'provider_down'|'network'} kind
   */
  constructor(provider, kind, message) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.kind = kind;
  }
}

export const KIND_AR = {
  billing: 'الرصيد نفد أو الميزانية انتهت عند المزود',
  auth: 'مفتاح الـ API غير صحيح أو موقوف',
  quota: 'تم تجاوز حد التخزين أو عدد الطلبات عند المزود',
  rate_limit: 'تجاوز معدل الطلبات المسموح مؤقتاً',
  provider_down: 'خدمة المزود متعطلة مؤقتاً',
  network: 'تعذر الاتصال بالمزود (شبكة / إنترنت)',
};
export const PROVIDER_AR = { stt: 'تحويل الصوت لنص (Soniox)', llm: 'الذكاء الاصطناعي (Claude)' };

/**
 * Classify any error thrown while processing one call.
 * scope 'provider' = pause the lane; scope 'call' = this call's own retry policy.
 */
export function classifyCallError(e) {
  if (e && (e instanceof ProviderError || e.name === 'ProviderError')) return { scope: 'provider', kind: e.kind, provider: e.provider };
  const m = String(e?.message || e || '');
  if (/invalid_audio_file|No audio found|audio (is )?(too short|empty)/i.test(m)) return { scope: 'call', kind: 'bad_audio' };
  if (/recording not found/i.test(m)) return { scope: 'call', kind: 'not_found' };
  if (/EHOSTUNREACH|ECONNREFUSED|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|ENETUNREACH|socket hang up|gateway timeout|timeout http|login failed|branch returned 5\d\d|upstream 5\d\d|search \d{3}/i.test(m)) return { scope: 'call', kind: 'recording_net' };
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
  quota: [30, 90, 300, 600],
  rate_limit: [20, 60, 180, 300],
  provider_down: [30, 90, 300, 600],
  network: [30, 90, 300, 600],
};
const blank = () => ({ state: 'closed', kind: null, message: null, since: null, until: 0, trips: 0, probing: false, last_ok_at: null, last_error_at: null });

function restore(p) {
  try {
    const s = getSettings()[`circuit_${p}`];
    // a restart re-checks a broken provider after 15s instead of trusting the old back-off
    if (s && s.state && s.state !== 'closed') return { ...blank(), ...s, state: 'open', until: Date.now() + (FAST ? 1000 : 15000), probing: false };
  } catch {}
  return blank();
}
const circuits = { stt: restore('stt'), llm: restore('llm') };
const recoverHooks = { stt: [], llm: [] };

function persist(p) {
  const c = circuits[p];
  try { setSetting(`circuit_${p}`, { state: c.state, kind: c.kind, message: c.message, since: c.since, until: c.until, trips: c.trips, last_ok_at: c.last_ok_at, last_error_at: c.last_error_at }); }
  catch (e) { log('persist failed', e.message); }
}

/** Register a callback that runs when the provider recovers (circuit closes). */
export function onRecover(p, fn) { recoverHooks[p].push(fn); }

export function circuitState(p) { return circuits[p].state; }

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

export function recordSuccess(p) {
  const c = circuits[p];
  c.last_ok_at = nowIso();
  if (c.state === 'closed') return;
  const was = { kind: c.kind, since: c.since };
  Object.assign(c, { state: 'closed', kind: null, message: null, until: 0, trips: 0, probing: false });
  persist(p);
  log(`${p}: provider recovered, lane resumes`);
  alertOnce(`recovered:${p}`, 1, () => notifyAdminsLazy({ kind: 'system', subject: `${PROVIDER_AR[p]} رجع يشتغل`, text: `✅ ${PROVIDER_AR[p]} رجع يشتغل تلقائياً بعد توقف (${KIND_AR[was.kind] || was.kind}) منذ ${was.since}. المكالمات المنتظرة بتكمل دلوقتي.` }));
  for (const fn of recoverHooks[p]) { try { fn(); } catch (e) { log('recover hook failed', e.message); } }
}

export function recordFailure(p, err) {
  const c = circuits[p];
  const kind = err?.kind || 'provider_down';
  const msg = String(err?.message || err).slice(0, 400);
  c.last_error_at = nowIso();
  // several in-flight calls usually fail together: only the first one moves the circuit
  if (c.state === 'open' && Date.now() < c.until) { c.message = msg; return; }
  const wasClosed = c.state === 'closed';
  c.trips = wasClosed ? 1 : c.trips + 1;
  const steps = BACKOFF[kind] || BACKOFF.provider_down;
  const sec = FAST ? 2 : steps[Math.min(c.trips - 1, steps.length - 1)];
  Object.assign(c, { state: 'open', kind, message: msg, until: Date.now() + sec * 1000, probing: false, since: wasClosed ? nowIso() : (c.since || nowIso()) });
  persist(p);
  log(`${p}: circuit OPEN (${kind}) for ${sec}s — ${msg}`);
  // alert once per incident (rate limits are noisy: only after repeated trips)
  if (wasClosed && kind !== 'rate_limit' || (kind === 'rate_limit' && c.trips === 3)) {
    alertOnce(`paused:${p}:${kind}`, 60, () => notifyAdminsLazy({ kind: 'system', subject: `${PROVIDER_AR[p]} متوقف مؤقتاً`,
      text: `⚠️ ${PROVIDER_AR[p]} متوقف مؤقتاً: ${KIND_AR[kind] || kind}.\nالمكالمات محفوظة في الانتظار ومش هتفشل، والنظام بيعيد المحاولة تلقائياً ويكمل أول ما المزود يرجع.\nالتفاصيل: ${msg}` }));
  }
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
  const left = c.state === 'closed' ? 0 : Math.max(0, Math.round((c.until - Date.now()) / 1000));
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
/** Run fn at most once per `minutes` for the same key (across the whole process). */
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
