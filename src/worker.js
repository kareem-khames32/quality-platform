/**
 * Worker: two independent lanes over the calls table.
 *
 *   STT lane : queued      -> recording from the branch -> speech-to-text -> banned words
 *                           -> awaiting_ai (banned words found and AI configured) | analyzed
 *   AI  lane : awaiting_ai -> AI verdict -> ticket decision -> analyzed
 *
 * Provider problems (no balance, bad key, storage quota, rate limit, outage) open that provider's circuit
 * (resilience.js): the lane pauses, calls keep their place in the queue and no retry is consumed; the lane
 * resumes by itself when the provider is back. Call-specific problems follow a per-call retry policy.
 * Audio is kept in memory only and dropped right after transcription.
 */
import { config } from './config.js';
import { db, q, bumpUsage, getSettings } from './db.js';
import { downloadRecording } from './gateway.js';
import { transcribe, sttReady, sonioxJanitor } from './stt/index.js';
import { analyzeCall, findBannedWords } from './analyzer.js';
import { llmReady } from './llm/index.js';
import { assignRoles } from './roles.js';
import { nowIso, sleep, stampIn } from './util.js';
import { classifyCallError, circuitAllows, circuitState, recordSuccess, recordFailure, releaseProbe, onRecover, beat, LEGACY_PROVIDER_ERROR_SQL } from './resilience.js';

const log = (...a) => console.log(new Date().toISOString(), '[worker]', ...a);
const active = { stt: new Set(), ai: new Set() };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
const short = (m) => String(m || '').slice(0, 500);
const MINUTE = process.env.CQ_TEST_FAST === '1' ? 1000 : 60000;   // test harness only: seconds instead of minutes

/* ----------------------------- retry policy for call-specific problems ----------------------------- */
function policy(kind, s) {
  if (kind === 'not_found') return { max: Math.max(1, Number(s.not_found_max_retries || 8)), delayMin: 15 };   // recording not on the branch yet
  if (kind === 'recording_net') return { max: 12, delayMin: 5 };                                            // branch server unreachable
  return { max: Math.max(1, Number(config.worker.max_retries || 3)), delayMin: 3 };
}

const wantsAI = (hits, s) => llmReady() && (hits.length > 0 || !s.llm_only_flagged);

/* ----------------------------- STT lane ----------------------------- */
async function processSTT(callId, probe) {
  const call = q.one('SELECT * FROM calls WHERE id=?', callId);
  if (!call) return;
  try {
    let tr = q.one('SELECT text FROM transcripts WHERE call_id=?', callId);
    if (!tr) {
      q.run("UPDATE calls SET status='transcribing', error=NULL WHERE id=?", callId);
      // dev/demo path: with the mock STT and no gateway key we skip the real download
      const audio = (config.stt.provider === 'mock' && !config.gateway.api_key)
        ? { buffer: Buffer.alloc(0), contentType: 'audio/wav', filename: 'mock.wav' }
        : await downloadRecording(call);
      audio.ref = callId;
      const bytes = audio.buffer?.length || 0;   // the Soniox adapter releases the buffer right after upload
      const t = await transcribe(audio);
      recordSuccess('stt');
      const speakerMap = assignRoles(t.segments || [], call);
      db.prepare(`INSERT INTO transcripts(call_id,text,language,segments,speaker_map,provider,model,audio_bytes,took_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)
                  ON CONFLICT(call_id) DO UPDATE SET text=excluded.text, language=excluded.language, segments=excluded.segments, speaker_map=excluded.speaker_map, provider=excluded.provider,
                  model=excluded.model, audio_bytes=excluded.audio_bytes, took_ms=excluded.took_ms, created_at=excluded.created_at`)
        .run(callId, t.text || '', t.language || null, JSON.stringify(t.segments || []), JSON.stringify(speakerMap), t.provider, t.model, bytes, t.took_ms, nowIso());
      bumpUsage('transcribed', call.billsec || 0);
      tr = { text: t.text || '' };
    }
    if (wantsAI(findBannedWords(tr.text), getSettings())) {
      await analyzeCall(callId, { provisional: true });   // keyword result saved, status -> awaiting_ai
      kick('ai');
    } else {
      await analyzeCall(callId, { skipLLM: true });
      bumpUsage('analyzed');
    }
    q.run('UPDATE calls SET retries=0, retry_after=NULL WHERE id=?', callId);
  } catch (e) {
    onSTTError(call, e);
  } finally {
    if (probe) releaseProbe('stt');
  }
}

function onSTTError(call, e) {
  const cls = classifyCallError(e);
  if (cls.scope === 'provider') {
    // the provider is the problem, not this call: pause the lane, keep the call's place, consume no retry
    recordFailure(cls.provider || 'stt', e);
    q.run("UPDATE calls SET status='queued', error=? WHERE id=?", short(`⏸ مؤقت (${cls.kind}): ${e.message}`), call.id);
    if (cls.kind === 'quota' && (cls.provider || 'stt') === 'stt') {
      sonioxJanitor({ minAgeSec: 60 }).then((r) => log('janitor after quota error:', JSON.stringify(r))).catch((x) => log('janitor failed:', x.message));
    }
    return;
  }
  if (cls.kind === 'bad_audio') {
    q.run("UPDATE calls SET status='skipped', skip_reason='empty_audio', error=? WHERE id=?", short(e.message), call.id);
    return;
  }
  const pol = policy(cls.kind, getSettings());
  const retries = (call.retries || 0) + 1;
  if (retries >= pol.max) {
    q.run("UPDATE calls SET status='failed', error=?, retries=?, retry_after=NULL WHERE id=?", short(`✖ ${e.message}`), retries, call.id);
    log(`call ${call.id} FAILED after ${retries} tries (${cls.kind}): ${e.message}`);
  } else {
    q.run("UPDATE calls SET status='queued', error=?, retries=?, retry_after=? WHERE id=?", short(e.message), retries, stampIn(pol.delayMin * MINUTE), call.id);
  }
}

/* ----------------------------- AI lane ----------------------------- */
async function processAI(callId, probe) {
  const call = q.one('SELECT * FROM calls WHERE id=?', callId);
  if (!call) return;
  try {
    q.run("UPDATE calls SET status='analyzing', error=NULL WHERE id=?", callId);
    if (!llmReady()) {
      await analyzeCall(callId, { skipLLM: true });   // AI switched off in settings: decide on keywords
    } else {
      const r = await analyzeCall(callId, { requireLLM: true });
      recordSuccess('llm');
      log(`call ${callId} AI: ${r.bannedHits.length} banned hits, complaint=${r.llm?.is_complaint ?? '-'}, violation=${r.llm?.agent_violation ?? '-'}, ticket=${r.ticketId ?? '-'}`);
    }
    q.run('UPDATE calls SET ai_retries=0, ai_since=NULL, retry_after=NULL WHERE id=?', callId);
    bumpUsage('analyzed');
  } catch (e) {
    await onAIError(call, e);
  } finally {
    if (probe) releaseProbe('llm');
  }
}

async function onAIError(call, e) {
  const cls = classifyCallError(e);
  if (cls.scope === 'provider') {
    recordFailure('llm', e);
    q.run("UPDATE calls SET status='awaiting_ai', error=? WHERE id=?", short(`⏸ مؤقت (${cls.kind}): ${e.message}`), call.id);
    return;
  }
  const n = (call.ai_retries || 0) + 1;
  if (n < 3) {
    q.run("UPDATE calls SET status='awaiting_ai', ai_retries=?, retry_after=?, error=? WHERE id=?", n, stampIn(3 * MINUTE), short(e.message), call.id);
    return;
  }
  try {
    await analyzeCall(call.id, { skipLLM: true, fallbackNote: `تعذر تحليل الذكاء الاصطناعي لهذه المكالمة بعد ${n} محاولات (${short(e.message).slice(0, 150)})، فتم الحكم بالكلمات المحظورة.` });
    q.run('UPDATE calls SET ai_retries=?, ai_since=NULL WHERE id=?', n, call.id);
  } catch (x) {
    q.run("UPDATE calls SET status='failed', error=? WHERE id=?", short(`✖ ${x.message}`), call.id);
  }
}

/** AI down for longer than ai_fallback_hours: decide those calls on keywords now, re-check them with AI when it returns. */
let lastChore = 0;
async function aiChores() {
  if (Date.now() - lastChore < MINUTE) return;
  lastChore = Date.now();
  const hours = Number(getSettings().ai_fallback_hours ?? 24);
  if (!hours || !llmReady() || circuitState('llm') === 'closed') return;
  const ids = q.all("SELECT id FROM calls WHERE status='awaiting_ai' AND ai_since IS NOT NULL AND ai_since <= ? ORDER BY calldate LIMIT 100", stampIn(-hours * 60 * MINUTE));
  for (const { id } of ids) {
    try {
      await analyzeCall(id, { skipLLM: true, fallbackMark: true, fallbackNote: `⚠️ حُكم عليها بالكلمات المحظورة فقط لأن الذكاء الاصطناعي متوقف أكثر من ${hours} ساعة؛ هتتراجع بالـ AI تلقائياً أول ما يرجع.` });
    } catch (e) { log(`fallback analysis failed for ${id}: ${e.message}`); }
  }
  if (ids.length) log(`AI down > ${hours}h: ${ids.length} calls decided on keywords (will be re-checked by AI on recovery)`);
}

/* ----------------------------- picking work ----------------------------- */
function pickSTT(n, exclude) {
  const now = nowIso(), ex = exclude.length ? exclude.join(',') : '-1';
  // manual requests first (no waiting), oldest request first
  const manual = q.all(`SELECT id FROM calls WHERE status='queued' AND queued_by IS NOT NULL AND (retry_after IS NULL OR retry_after <= ?) AND id NOT IN (${ex}) ORDER BY queued_at LIMIT ?`, now, n);
  if (manual.length >= n) return manual.map((r) => r.id);
  // then newest calls first (fresh calls are what the quality team acts on; the backlog drains with spare capacity);
  // auto-queued calls wait 10 minutes after the call so the branch has stored the recording
  const auto = q.all(`SELECT id FROM calls WHERE status='queued' AND queued_by IS NULL AND calldate <= ? AND (retry_after IS NULL OR retry_after <= ?) AND id NOT IN (${ex}) ORDER BY calldate DESC LIMIT ?`,
    stampIn(-10 * MINUTE), now, n - manual.length);
  return [...manual, ...auto].map((r) => r.id);
}
function pickAI(n, exclude) {
  const ex = exclude.length ? exclude.join(',') : '-1';
  return q.all(`SELECT id FROM calls WHERE status='awaiting_ai' AND (retry_after IS NULL OR retry_after <= ?) AND id NOT IN (${ex})
                ORDER BY CASE WHEN queued_by IS NULL THEN 1 ELSE 0 END, calldate DESC LIMIT ?`, nowIso(), n).map((r) => r.id);
}

/* ----------------------------- lanes ----------------------------- */
const LANES = {
  stt: { provider: 'stt', ready: () => sttReady(), usesCircuit: () => true, max: () => clamp(Number(getSettings().stt_concurrency || config.worker.concurrency || 20), 1, 80), pick: pickSTT, run: processSTT },
  ai: { provider: 'llm', ready: () => true, usesCircuit: () => llmReady(), max: () => clamp(Number(getSettings().ai_concurrency || 6), 1, 30), pick: pickAI, run: processAI },
};

const wakers = { stt: null, ai: null };
/** Wake a lane (or both) so new work starts within milliseconds instead of waiting for the next poll. */
export function kick(lane) {
  for (const k of lane ? [lane] : ['stt', 'ai']) { const w = wakers[k]; if (w) { wakers[k] = null; w(); } }
}
function waitForWork(lane, ms) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(() => { if (wakers[lane] === done) wakers[lane] = null; resolve(); }, ms);
    wakers[lane] = done;
  });
}

async function runLane(name) {
  const L = LANES[name];
  const pollMs = (config.worker.poll_sec || 10) * 1000;
  for (;;) {
    let dispatched = 0;
    try {
      beat(name);
      if (L.ready()) {
        const free = L.max() - active[name].size;
        if (free > 0) {
          const circuit = L.usesCircuit();
          for (const id of L.pick(free, [...active[name]])) {
            if (circuit && !circuitAllows(L.provider)) break;      // provider paused: calls wait in the queue
            const probe = circuit && circuitState(L.provider) === 'half_open';
            active[name].add(id); dispatched++;
            L.run(id, probe).catch((e) => log(`${name} run error:`, e)).finally(() => { active[name].delete(id); kick(name); });
            if (probe) break;                                     // one probe at a time while the provider is being re-checked
          }
        }
      }
      if (name === 'ai') await aiChores();
    } catch (e) { log(`${name} lane error:`, e); }
    if (dispatched) { await sleep(50); continue; }
    await waitForWork(name, pollMs);
  }
}

/* ----------------------------- recovery ----------------------------- */
/** Put everything a crash, an outage or the old retry logic left behind back where it belongs. Idempotent. */
export function recoverOnStartup() {
  const now = nowIso();
  const inFlightNoText = q.run(`UPDATE calls SET status='queued', retry_after=NULL WHERE status='transcribing'
      OR (status IN ('transcribed','analyzing') AND NOT EXISTS (SELECT 1 FROM transcripts t WHERE t.call_id=calls.id))`).changes;
  const inFlightText = q.run(`UPDATE calls SET status='awaiting_ai', retry_after=NULL, ai_since=COALESCE(ai_since, ?) WHERE status IN ('transcribed','analyzing')
      AND EXISTS (SELECT 1 FROM transcripts t WHERE t.call_id=calls.id)`, now).changes;
  // calls that the old code marked failed because of provider problems (Soniox quota/balance, network...) -> back to the queue
  const providerFailed = q.run(`UPDATE calls SET status='queued', retries=0, retry_after=NULL, error='↻ أُعيدت للطابور: ' || substr(COALESCE(error,''),1,200)
      WHERE status='failed' AND COALESCE(error,'') NOT LIKE '✖%' AND COALESCE(error,'') NOT LIKE '↻%' AND ${LEGACY_PROVIDER_ERROR_SQL}`).changes;
  const emptyAudio = q.run(`UPDATE calls SET status='skipped', skip_reason='empty_audio' WHERE status='failed' AND (error LIKE '%invalid_audio_file%' OR error LIKE '%No audio found%')`).changes;
  const aiMissing = llmReady() ? requeueFlaggedWithoutAI() : 0;
  if (inFlightNoText + inFlightText + providerFailed + emptyAudio + aiMissing) {
    log(`recovery: ${inFlightNoText + inFlightText} in-flight restored, ${providerFailed} provider-failed re-queued, ${emptyAudio} empty-audio marked skipped, ${aiMissing} flagged calls sent to AI`);
  }
  return { in_flight: inFlightNoText + inFlightText, provider_failed: providerFailed, empty_audio: emptyAudio, ai_missing: aiMissing };
}

/** Flagged calls that never got an AI verdict (AI was down / failed / decided on keywords) -> AI lane. */
export function requeueFlaggedWithoutAI() {
  const n = q.run(`UPDATE calls SET status='awaiting_ai', ai_retries=0, retry_after=NULL, ai_since=COALESCE(ai_since, ?) WHERE status='analyzed' AND id IN (
      SELECT a.call_id FROM analyses a WHERE a.banned_hits <> '[]' AND (a.provider IN ('keywords_fallback','pending_ai') OR (a.provider='keywords_only' AND a.summary LIKE '(تعذر التحليل%')))`, nowIso()).changes;
  if (n) kick('ai');
  return n;
}

onRecover('stt', () => kick('stt'));
onRecover('llm', () => { const n = requeueFlaggedWithoutAI(); if (n) log(`AI recovered: ${n} calls decided on keywords go back to the AI lane`); kick('ai'); });

let started = false;
export function runWorkerLoop() {
  if (started) return;
  started = true;
  try { recoverOnStartup(); } catch (e) { log('recovery failed:', e); }
  runLane('stt');
  runLane('ai');
}

/** Process one call end-to-end right now (CLI / debugging): speech-to-text, then the AI lane step if it needs one. */
export async function processCall(callId) {
  await processSTT(callId, false);
  if (q.one('SELECT status FROM calls WHERE id=?', callId)?.status === 'awaiting_ai') await processAI(callId, false);
}

/* ----------------------------- actions used by the UI ----------------------------- */
/** Queue a call for transcription now (manual button). retranscribe=true drops the old transcript first. */
export function queueCall(callId, userId = null, { retranscribe = false } = {}) {
  if (retranscribe) q.run('DELETE FROM transcripts WHERE call_id=? AND NOT EXISTS (SELECT 1 FROM calls WHERE id=? AND status IN (\'transcribing\',\'analyzing\'))', callId, callId);
  q.run("UPDATE calls SET status='queued', error=NULL, retries=0, retry_after=NULL, queued_by=?, queued_at=? WHERE id=? AND status NOT IN ('transcribing','analyzing')", userId, nowIso(), callId);
  kick('stt');
}

/** Send an already-transcribed call to the AI lane (manual re-analysis / bulk review). */
export function queueForAI(callId, userId = null) {
  const n = q.run(`UPDATE calls SET status='awaiting_ai', error=NULL, ai_retries=0, retry_after=NULL, queued_by=COALESCE(?, queued_by), ai_since=COALESCE(ai_since, ?)
      WHERE id=? AND status NOT IN ('transcribing','analyzing') AND EXISTS (SELECT 1 FROM transcripts t WHERE t.call_id=calls.id)`, userId, nowIso(), callId).changes;
  kick('ai');
  return n;
}

const FAILED_FILTERS = {
  all: '1=1',
  not_found: "error LIKE '%recording not found%'",
  network: "(error LIKE '%EHOST%' OR error LIKE '%ECONN%' OR error LIKE '%ETIMEDOUT%' OR error LIKE '%timeout%' OR error LIKE '%login failed%' OR error LIKE '%fetch failed%')",
  provider: LEGACY_PROVIDER_ERROR_SQL,
};
/** Admin: send failed calls back to the queue (all, or by reason). */
export function retryFailed(which = 'all') {
  const cond = FAILED_FILTERS[which] || FAILED_FILTERS.all;
  const n = q.run(`UPDATE calls SET status='queued', retries=0, retry_after=NULL, error='↻ ' || substr(COALESCE(error,''),1,200) WHERE status='failed' AND ${cond}`).changes;
  kick('stt');
  return n;
}

let statsCache = { at: 0, v: null };
/** Live queue numbers for the UI (cached 3s: every open tab polls this). */
export function queueStats() {
  if (!statsCache.v || Date.now() - statsCache.at > 3000) {
    const rows = q.all("SELECT status, COUNT(*) c FROM calls WHERE status IN ('queued','awaiting_ai','transcribing','analyzing','failed') GROUP BY status");
    const m = Object.fromEntries(rows.map((r) => [r.status, r.c]));
    const doneToday = q.one('SELECT COUNT(*) c FROM transcripts WHERE created_at >= ?', nowIso().slice(0, 10) + ' 00:00:00').c;
    statsCache = { at: Date.now(), v: { queued: m.queued || 0, awaiting_ai: m.awaiting_ai || 0, working: (m.transcribing || 0) + (m.analyzing || 0), failed: m.failed || 0, done_today: doneToday } };
  }
  return { ...statsCache.v, in_flight: active.stt.size + active.ai.size };
}

export function laneInfo() {
  return { stt: { active: active.stt.size, max: LANES.stt.max(), ready: LANES.stt.ready() }, ai: { active: active.ai.size, max: LANES.ai.max(), llm: llmReady() } };
}
