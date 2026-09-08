/**
 * Worker: takes queued calls -> resolves recording via gateway -> STT -> analysis.
 * Audio is fetched into memory and dropped right after transcription (never written to disk).
 */
import { config } from './config.js';
import { db, q, bumpUsage } from './db.js';
import { downloadRecording } from './gateway.js';
import { transcribe, sttReady } from './stt/index.js';
import { analyzeCall } from './analyzer.js';
import { assignRoles } from './roles.js';
import { nowIso, sleep } from './util.js';

const log = (...a) => console.log(new Date().toISOString(), '[worker]', ...a);
const inFlight = new Set();

export async function processCall(callId) {
  const call = q.one('SELECT * FROM calls WHERE id=?', callId);
  if (!call) return;
  try {
    if (!q.one('SELECT 1 FROM transcripts WHERE call_id=?', callId)) {
      if (!sttReady()) throw new Error('STT provider is not configured');
      db.prepare("UPDATE calls SET status='transcribing', error=NULL WHERE id=?").run(callId);
      // dev/demo path: with the mock STT and no gateway key we skip the real download so the pipeline can be exercised end-to-end
      const audio = (config.stt.provider === 'mock' && !config.gateway.api_key)
        ? { buffer: Buffer.alloc(0), contentType: 'audio/wav', filename: 'mock.wav' }
        : await downloadRecording(call);
      const t = await transcribe(audio);
      const speakerMap = assignRoles(t.segments || [], call);
      db.prepare(`INSERT INTO transcripts(call_id,text,language,segments,speaker_map,provider,model,audio_bytes,took_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)
                  ON CONFLICT(call_id) DO UPDATE SET text=excluded.text, language=excluded.language, segments=excluded.segments, speaker_map=excluded.speaker_map, provider=excluded.provider,
                  model=excluded.model, audio_bytes=excluded.audio_bytes, took_ms=excluded.took_ms, created_at=excluded.created_at`)
        .run(callId, t.text || '', t.language || null, JSON.stringify(t.segments || []), JSON.stringify(speakerMap), t.provider, t.model, audio.buffer.length, t.took_ms, nowIso());
      bumpUsage('transcribed', call.billsec || 0);
      db.prepare("UPDATE calls SET status='transcribed' WHERE id=?").run(callId);
    }
    db.prepare("UPDATE calls SET status='analyzing' WHERE id=?").run(callId);
    const r = await analyzeCall(callId);
    bumpUsage('analyzed');
    log(`call ${callId} done: ${r.bannedHits.length} banned hits, complaint=${r.llm?.is_complaint ?? '-'}, ticket=${r.ticketId ?? '-'}`);
  } catch (e) {
    const retries = (call.retries || 0) + 1;
    const notFound = /not found/i.test(e.message);
    // recordings can take a while to land on the branch server: retry every 15 minutes up to 6 times (~1.5 h) before giving up
    const maxRetries = notFound ? 6 : (config.worker.max_retries || 3);
    const giveUp = retries >= maxRetries;
    const retryAfter = new Date(Date.now() + (notFound ? 15 : 2) * 60000);
    const p = (n) => String(n).padStart(2, '0');
    const ra = `${retryAfter.getFullYear()}-${p(retryAfter.getMonth() + 1)}-${p(retryAfter.getDate())} ${p(retryAfter.getHours())}:${p(retryAfter.getMinutes())}:${p(retryAfter.getSeconds())}`;
    db.prepare('UPDATE calls SET status=?, error=?, retries=?, retry_after=? WHERE id=?').run(giveUp ? 'failed' : 'queued', e.message, retries, giveUp ? null : ra, callId);
    log(`call ${callId} ${giveUp ? 'FAILED' : `retry at ${ra}`}: ${e.message}`);
  }
}

/* wake-up signal so a manual "حوّل لنص" starts within milliseconds instead of waiting for the next poll */
let wake = null;
export function kick() { if (wake) { const w = wake; wake = null; w(); } }
function waitForWork(ms) { return new Promise((r) => { wake = r; setTimeout(() => { if (wake === r) wake = null; r(); }, ms); }); }

export async function runWorkerLoop() {
  const poll = (config.worker.poll_sec || 10) * 1000;
  // crash recovery: anything left mid-flight by a previous process goes back to the queue
  const stuck = db.prepare("UPDATE calls SET status='queued', retry_after=NULL WHERE status IN ('transcribing','analyzing')").run().changes;
  if (stuck) log(`released ${stuck} calls left in-flight by the previous run`);
  for (;;) {
    try {
      const conc = config.worker.concurrency || 4;
      if (inFlight.size < conc) {
        const free = conc - inFlight.size;
        // manual requests (queued_by set) go first, then oldest auto-queued
        // auto-queued calls wait 10 minutes after the call ended so the branch has time to store the recording;
        // manual requests (queued_by set) go first and immediately
        const rows = q.all(`SELECT id FROM calls WHERE status='queued' AND id NOT IN (${[...inFlight, -1].join(',')})
                            AND (retry_after IS NULL OR retry_after <= datetime('now','localtime'))
                            AND (queued_by IS NOT NULL OR calldate <= datetime('now','localtime','-10 minutes'))
                            ORDER BY CASE WHEN queued_by IS NULL THEN 1 ELSE 0 END, queued_at ASC, id ASC LIMIT ?`, free);
        for (const r of rows) {
          inFlight.add(r.id);
          processCall(r.id).finally(() => { inFlight.delete(r.id); kick(); });
        }
        if (rows.length) { await sleep(200); continue; }
      }
    } catch (e) { log('loop error', e); }
    await waitForWork(poll);
  }
}

/** Requeue a call (manual button / retry) and start it right away. */
export function queueCall(callId, userId = null) {
  db.prepare("UPDATE calls SET status='queued', error=NULL, retries=0, queued_by=?, queued_at=? WHERE id=? AND status NOT IN ('transcribing','analyzing')").run(userId, nowIso(), callId);
  kick();
}

/** Live queue numbers for the UI. */
export function queueStats() {
  const r = q.one(`SELECT SUM(status='queued') queued, SUM(status IN ('transcribing','analyzing')) working, SUM(status='failed') failed,
                   SUM(status='analyzed' AND date(created_at)=date('now','localtime')) done_today FROM calls`);
  return { queued: r.queued || 0, working: r.working || 0, failed: r.failed || 0, done_today: r.done_today || 0, in_flight: inFlight.size };
}
