/**
 * Speech-to-text adapters. Every adapter takes {buffer, contentType, filename, ref} and returns
 * { text, language, segments:[{start,end,text,speaker?}], provider, model }.
 *
 * Provider-level failures (balance, key, quota/storage, rate limit, outage, network) are thrown as ProviderError
 * so the STT lane pauses as a whole instead of failing calls one by one (see resilience.js).
 *
 * providers:
 *   soniox             - async file API (upload -> transcription -> poll -> transcript). Every upload is tagged
 *                        client_reference_id "cq-<callId>" and ALWAYS deleted afterwards (success or failure);
 *                        a janitor removes any leftovers so the 1,000-file / 2,000-transcription limits never fill up.
 *   openai_compatible  - POST {base_url}/audio/transcriptions (OpenAI Whisper / gpt-4o-transcribe, Groq, etc.)
 *   deepgram           - POST https://api.deepgram.com/v1/listen
 *   elevenlabs         - POST https://api.elevenlabs.io/v1/speech-to-text (Scribe)
 *   custom_http        - any HTTP endpoint described in config.stt.custom
 *   mock               - returns a canned Arabic transcript (development only)
 */
import { config } from '../config.js';
import { q } from '../db.js';
import { getPath, nowIso, sleep } from '../util.js';
import { ProviderError } from '../resilience.js';

const cfg = () => config.stt;
const log = (...a) => console.log(new Date().toISOString(), '[stt]', ...a);

/* ============================== shared HTTP helpers ============================== */

/** Map an HTTP failure from an STT provider to ProviderError (pause the lane) or a plain call-level Error. */
function httpFail(status, text, label, errorType = '') {
  const body = String(text || '');
  const msg = `${label} ${status}: ${errorType ? errorType + ' ' : ''}${body.slice(0, 300)}`.trim();
  const both = `${errorType} ${body}`;
  if (status === 402 || /balance_exhausted|budget_exhausted|insufficient_(funds|balance|credit)|credit balance|payment required/i.test(both)) return new ProviderError('stt', 'billing', msg);
  if (status === 401 || status === 403) return new ProviderError('stt', 'auth', msg);
  if (status === 429) return new ProviderError('stt', /limit_exceeded/i.test(both) && /file|storage|transcription|pending/i.test(body) ? 'quota' : 'rate_limit', msg);
  if (status >= 500) return new ProviderError('stt', 'provider_down', msg);
  const e = new Error(msg); e.status = status; return e;
}

/** fetch with a timeout; a network failure talking to the provider is a provider-level problem. */
async function netFetch(url, opts, label, timeoutMs = 120000) {
  try { return await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) }); }
  catch (e) { throw new ProviderError('stt', 'network', `${label}: ${e.cause?.code || e.name} ${e.message}`); }
}

/** Read the body inside the same "network" umbrella: a socket dropped mid-body is a provider problem, not a call problem. */
async function readBody(res, label) {
  try { return await res.text(); }
  catch (e) { throw new ProviderError('stt', 'network', `${label}: connection dropped while reading the response (${e.cause?.code || e.name} ${e.message})`); }
}

async function postForm(url, headers, form, label) {
  const res = await netFetch(url, { method: 'POST', headers, body: form }, label, 300000);
  const txt = await readBody(res, label);
  if (!res.ok) throw httpFail(res.status, txt, label);
  try { return JSON.parse(txt); } catch { return { text: txt }; }
}

/* ============================== Soniox ============================== */

// Issabel recording names (out-DST-EXT-YYYYMMDD-HHMMSS-UNIQUEID.wav): only this platform uploads files like these,
// so the janitor can clean legacy (untagged) leftovers without touching anything else in the Soniox project.
const OUR_FILE = /^(out|in|exten|q|rg|force|g|ext)-.*\d{9,10}\.\d+\.(wav|mp3|gsm)$/i;
const isOurs = (x) => String(x?.client_reference_id || '').startsWith('cq-') || OUR_FILE.test(String(x?.filename || ''));
// resources of calls currently being processed: the janitor never deletes these
const active = { files: new Set(), transcriptions: new Set() };

function sonioxBase() {
  const c = cfg();
  return (c.soniox_base_url || (c.base_url && /soniox/i.test(c.base_url) ? c.base_url : 'https://api.soniox.com/v1')).replace(/\/$/, '');
}

async function sonioxJson(method, path, { body, form, timeoutMs } = {}, label = path) {
  const headers = { Authorization: `Bearer ${cfg().api_key}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await netFetch(`${sonioxBase()}${path}`, { method, headers, body: form || (body !== undefined ? JSON.stringify(body) : undefined) }, `Soniox ${label}`, timeoutMs);
  if (res.status === 204) return {};
  const txt = await readBody(res, `Soniox ${label}`);
  let j = {}; try { j = txt ? JSON.parse(txt) : {}; } catch {}
  if (!res.ok) throw httpFail(res.status, j.message || txt, `Soniox ${label}`, j.error_type || '');
  return j;
}

/**
 * GET that survives short blips while a job is running: network / provider_down / rate_limit are retried with back-off
 * until the deadline, so one failed poll never abandons a job Soniox is still processing (and billing). Billing/auth rethrow at once.
 */
async function sonioxGetPatient(path, label, deadline) {
  let wait = 2000;
  for (;;) {
    try { return await sonioxJson('GET', path, { timeoutMs: 60000 }, label); }
    catch (e) {
      const transient = e?.name === 'ProviderError' && ['network', 'provider_down', 'rate_limit'].includes(e.kind);
      if (!transient || Date.now() + wait > deadline) throw e;
      await sleep(wait);
      wait = Math.min(wait * 2, 30000);
    }
  }
}

/** Delete one Soniox resource; failures are remembered in soniox_leftovers and retried by the janitor. */
async function sonioxDelete(kind, id) {
  try {
    const res = await fetch(`${sonioxBase()}/${kind}/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${cfg().api_key}` }, signal: AbortSignal.timeout(20000) });
    if (res.ok || res.status === 404) { q.run('DELETE FROM soniox_leftovers WHERE kind=? AND id=?', kind, id); return true; }
  } catch {}
  try { q.run('INSERT OR IGNORE INTO soniox_leftovers(kind, id, created_at) VALUES(?,?,?)', kind, id, nowIso()); } catch {}
  return false;
}

async function listAll(kind) {
  const out = [];
  let cursor = null;
  for (let i = 0; i < 50; i++) {
    const j = await sonioxJson('GET', `/${kind}?limit=1000${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`, {}, `list ${kind}`);
    out.push(...(j[kind] || []));
    cursor = j.next_page_cursor;
    if (!cursor) break;
  }
  return out;
}

async function pool(items, n, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) { const it = items[i++]; await fn(it); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

async function transcribeSoniox(audio) {
  const c = cfg();
  const ref = `cq-${audio.ref ?? 'x'}-${Date.now().toString(36)}`;
  let fileId = null, trId = null;
  try {
    // 1) upload (tagged so our uploads are always identifiable)
    let form = new FormData();
    form.append('file', new Blob([audio.buffer], { type: audio.contentType || 'audio/wav' }), audio.filename || 'call.wav');
    form.append('client_reference_id', ref);
    const file = await sonioxJson('POST', '/files', { form, timeoutMs: 300000 }, 'upload');
    fileId = file.id;
    if (fileId) active.files.add(fileId);
    // Soniox has the audio now: release both copies so 20-80 parallel jobs waiting on Soniox don't hold them in memory
    form = null;
    audio.buffer = null;

    // 2) create transcription
    const langs = (c.language || 'ar').split(',').map((s) => s.trim()).filter(Boolean);
    const body = {
      model: c.model && String(c.model).startsWith('stt-') ? c.model : 'stt-async-v5',
      file_id: fileId, language_hints: langs, enable_speaker_diarization: true, enable_language_identification: langs.length > 1, client_reference_id: ref,
    };
    const created = await sonioxJson('POST', '/transcriptions', { body }, 'create');
    trId = created.id;
    if (trId) active.transcriptions.add(trId);

    // 3) poll with gentle back-off (1.5s -> 10s); a single failed poll is retried, not treated as a failure
    const limitSec = c.poll_timeout_sec || 1800;
    const deadline = Date.now() + limitSec * 1000;
    let st = created, delay = 1500;
    while (st.status !== 'completed' && st.status !== 'error') {
      // Soniox not finishing jobs is a provider problem: pause the lane, keep the call's retries
      if (Date.now() > deadline) throw new ProviderError('stt', 'provider_down', `Soniox is not finishing jobs: transcription ${trId} still "${st.status}" after ${Math.round(limitSec / 60)} min`);
      await sleep(delay);
      delay = Math.min(Math.round(delay * 1.5), 10000);
      st = await sonioxGetPatient(`/transcriptions/${trId}`, 'status', deadline);
    }
    if (st.status === 'error') {
      const et = st.error_type || '';
      const msg = `Soniox error: ${et} ${st.error_message || ''}`.trim();
      if (/balance|budget/i.test(et)) throw new ProviderError('stt', 'billing', msg);
      throw new Error(msg);   // invalid_audio_file etc. are about this call only
    }

    // 4) transcript tokens -> speaker turns
    const tr = await sonioxGetPatient(`/transcriptions/${trId}/transcript`, 'transcript', Date.now() + 5 * 60000);
    const segments = [];
    for (const tk of tr.tokens || []) {
      const last = segments.at(-1);
      const spk = tk.speaker ?? null;
      if (last && last.speaker === spk && tk.start_ms - last.endMs < 1500) { last.text += tk.text; last.end = tk.end_ms / 1000; last.endMs = tk.end_ms; }
      else segments.push({ start: tk.start_ms / 1000, end: tk.end_ms / 1000, endMs: tk.end_ms, text: tk.text, speaker: spk });
    }
    for (const s of segments) { delete s.endMs; s.text = s.text.trim(); }
    const hasSpeakers = segments.some((s) => s.speaker != null);
    const text = hasSpeakers ? segments.map((s) => `[متحدث ${s.speaker}] ${s.text}`).join('\n') : (tr.text || segments.map((s) => s.text).join(' '));
    return { text, language: langs[0], segments, provider: 'soniox', model: body.model };
  } finally {
    // 5) ALWAYS clean up on Soniox - success, error, timeout or provider failure alike (we keep only the text)
    if (trId) { if (c.delete_after !== false) await sonioxDelete('transcriptions', trId); active.transcriptions.delete(trId); }
    if (fileId) { if (c.delete_after !== false) await sonioxDelete('files', fileId); active.files.delete(fileId); }
  }
}

let janitorRunning = null;
export let lastJanitor = null;

/** Remove this platform's leftover files/transcriptions on Soniox (never touches anything that is not ours or in use). */
export function sonioxJanitor(opts = {}) {
  if (janitorRunning) return janitorRunning;
  janitorRunning = runJanitor(opts).finally(() => { janitorRunning = null; });
  return janitorRunning;
}

async function runJanitor({ minAgeSec = 120 } = {}) {
  const c = cfg();
  if (c.provider !== 'soniox' || !c.api_key) return { skipped: 'soniox is not the active STT provider' };
  const t0 = Date.now();
  const age = (x) => (t0 - new Date(x.created_at).getTime()) / 1000;
  const res = { transcriptions_deleted: 0, files_deleted: 0, kept_not_ours: 0, kept_in_use: 0, delete_errors: 0 };

  // transcriptions first, so their files are no longer referenced
  const trs = await listAll('transcriptions');
  const trDel = [];
  const keepFiles = new Set();   // files referenced by a transcription we keep must stay (deleting them fails that job)
  for (const t of trs) {
    if (!isOurs(t)) { res.kept_not_ours++; if (t.file_id) keepFiles.add(t.file_id); continue; }
    const done = t.status === 'completed' || t.status === 'error';
    // in use here; or finished only recently (another poller may be about to read it); or still processing and < 30 min old
    if (active.transcriptions.has(t.id) || age(t) < (done ? Math.max(minAgeSec, 900) : 1800)) {
      res.kept_in_use++;
      if (t.file_id) keepFiles.add(t.file_id);
      continue;
    }
    trDel.push(t.id);
  }
  await pool(trDel, 8, async (id) => { (await sonioxDelete('transcriptions', id)) ? res.transcriptions_deleted++ : res.delete_errors++; });

  const files = await listAll('files');
  const fDel = [];
  for (const f of files) {
    if (!isOurs(f)) { res.kept_not_ours++; continue; }
    if (active.files.has(f.id) || keepFiles.has(f.id) || age(f) < minAgeSec) { res.kept_in_use++; continue; }
    fDel.push(f.id);
  }
  await pool(fDel, 8, async (id) => { (await sonioxDelete('files', id)) ? res.files_deleted++ : res.delete_errors++; });

  // ids whose delete failed earlier (e.g. network blip right after a transcription)
  const left = q.all('SELECT kind, id FROM soniox_leftovers ORDER BY created_at LIMIT 5000').filter((r) => !(r.kind === 'files' ? active.files : active.transcriptions).has(r.id));
  await pool(left, 8, async (r) => { await sonioxDelete(r.kind, r.id); });

  Object.assign(res, { files_remaining: files.length - res.files_deleted, transcriptions_remaining: trs.length - res.transcriptions_deleted, took_ms: Date.now() - t0, at: nowIso() });
  lastJanitor = res;
  if (res.files_deleted || res.transcriptions_deleted || res.delete_errors) log(`janitor: ${JSON.stringify(res)}`);
  return res;
}

/** Storage usage on Soniox versus its limits (for the system page). */
export async function sonioxInventory() {
  const c = cfg();
  if (c.provider !== 'soniox' || !c.api_key) return { skipped: 'soniox is not the active STT provider' };
  const [files, trs] = await Promise.all([listAll('files'), listAll('transcriptions')]);
  const byStatus = {};
  for (const t of trs) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  return {
    files: files.length, files_ours: files.filter(isOurs).length, files_mb: Math.round(files.reduce((a, f) => a + (f.size || 0), 0) / 1048576),
    transcriptions: trs.length, transcriptions_ours: trs.filter(isOurs).length, by_status: byStatus,
    limits: { files: 1000, storage_mb: 10240, transcriptions: 2000, pending: 100 },
    in_use: { files: active.files.size, transcriptions: active.transcriptions.size },
    leftovers_pending_delete: q.one('SELECT COUNT(*) c FROM soniox_leftovers').c, last_janitor: lastJanitor,
  };
}

/* ============================== adapters ============================== */

const adapters = {
  async mock(audio) {
    return {
      text: `[نص تجريبي] الموظف: السلام عليكم معاك من شركة مهارة. العميل: أنا عايز أقدم شكوى على الخدمة، الموظف اللي كلمني قبل كده كان قليل الأدب. الموظف: حاضر يا فندم هنسجل الشكوى ونرجعلك. (حجم الملف ${audio.buffer?.length || 0} بايت)`,
      language: 'ar', segments: [], provider: 'mock', model: 'mock',
    };
  },

  soniox: transcribeSoniox,

  async openai_compatible(audio) {
    const c = cfg();
    const form = new FormData();
    form.append('file', new Blob([audio.buffer], { type: audio.contentType }), audio.filename || 'call.wav');
    form.append('model', c.model || 'whisper-1');
    if (c.language) form.append('language', c.language);
    form.append('response_format', 'verbose_json');
    const j = await postForm(`${c.base_url.replace(/\/$/, '')}/audio/transcriptions`, { Authorization: `Bearer ${c.api_key}` }, form, 'STT');
    return {
      text: j.text || '', language: j.language || c.language,
      segments: (j.segments || []).map((s) => ({ start: s.start, end: s.end, text: s.text })),
      provider: 'openai_compatible', model: c.model,
    };
  },

  async deepgram(audio) {
    const c = cfg();
    const params = new URLSearchParams({ model: c.model || 'nova-3', smart_format: 'true', diarize: 'true', punctuate: 'true', utterances: 'true' });
    if (c.language) params.set('language', c.language);
    const res = await netFetch(`${(c.base_url || 'https://api.deepgram.com/v1').replace(/\/$/, '')}/listen?${params}`, {
      method: 'POST', headers: { Authorization: `Token ${c.api_key}`, 'Content-Type': audio.contentType || 'audio/wav' }, body: audio.buffer,
    }, 'Deepgram', 300000);
    const txt = await readBody(res, 'Deepgram');
    if (!res.ok) throw httpFail(res.status, txt, 'Deepgram');
    const j = JSON.parse(txt);
    const alt = j.results?.channels?.[0]?.alternatives?.[0] || {};
    const utt = j.results?.utterances || [];
    const text = utt.length ? utt.map((u) => `[متحدث ${u.speaker + 1}] ${u.transcript}`).join('\n') : (alt.paragraphs?.transcript || alt.transcript || '');
    return {
      text, language: c.language,
      segments: utt.map((u) => ({ start: u.start, end: u.end, text: u.transcript, speaker: u.speaker })),
      provider: 'deepgram', model: c.model || 'nova-3',
    };
  },

  async elevenlabs(audio) {
    const c = cfg();
    const form = new FormData();
    form.append('file', new Blob([audio.buffer], { type: audio.contentType }), audio.filename || 'call.wav');
    form.append('model_id', c.model || 'scribe_v1');
    form.append('diarize', 'true');
    if (c.language) form.append('language_code', c.language === 'ar' ? 'ara' : c.language);
    const j = await postForm(`${(c.base_url || 'https://api.elevenlabs.io/v1').replace(/\/$/, '')}/speech-to-text`, { 'xi-api-key': c.api_key }, form, 'ElevenLabs');
    return { text: j.text || '', language: j.language_code, segments: (j.words || []).filter((w) => w.type === 'word').map((w) => ({ start: w.start, end: w.end, text: w.text, speaker: w.speaker_id })), provider: 'elevenlabs', model: c.model || 'scribe_v1' };
  },

  async custom_http(audio) {
    const c = cfg().custom || {};
    if (!c.url) throw new Error('stt.custom.url is not configured');
    const headers = { ...(c.headers || {}) };
    if (cfg().api_key && !Object.keys(headers).some((h) => h.toLowerCase() === 'authorization')) headers.Authorization = `Bearer ${cfg().api_key}`;
    let body;
    if ((c.body_mode || 'multipart') === 'multipart') {
      body = new FormData();
      body.append(c.file_field || 'file', new Blob([audio.buffer], { type: audio.contentType }), audio.filename || 'call.wav');
      for (const [k, v] of Object.entries(c.extra_fields || {})) body.append(k, String(v));
    } else if (c.body_mode === 'base64_json') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({ ...(c.extra_fields || {}), [c.file_field || 'audio']: audio.buffer.toString('base64'), filename: audio.filename });
    } else { headers['Content-Type'] = audio.contentType || 'application/octet-stream'; body = audio.buffer; }
    const res = await netFetch(c.url, { method: c.method || 'POST', headers, body }, 'STT', 300000);
    const txt = await readBody(res, 'STT');
    if (!res.ok) throw httpFail(res.status, txt, 'STT');
    let j; try { j = JSON.parse(txt); } catch { j = { text: txt }; }
    return { text: String(getPath(j, c.text_path || 'text') ?? ''), language: getPath(j, c.language_path) || cfg().language, segments: getPath(j, c.segments_path) || [], provider: 'custom_http', model: c.url };
  },
};

export function sttReady() {
  const c = cfg();
  if (!c.provider || c.provider === 'none') return false;
  if (c.provider === 'mock') return true;
  if (c.provider === 'custom_http') return !!c.custom?.url;
  return !!c.api_key;
}

export async function transcribe(audio) {
  const p = cfg().provider || 'mock';
  const fn = adapters[p];
  if (!fn) throw new Error(`unknown STT provider "${p}"`);
  const t = Date.now();
  const out = await fn(audio);
  out.took_ms = Date.now() - t;
  return out;
}
