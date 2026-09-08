/**
 * Speech-to-text adapters. Every adapter takes {buffer, contentType, filename} and returns
 * { text, language, segments:[{start,end,text,speaker?}], provider, model }.
 *
 * providers:
 *   openai_compatible  - POST {base_url}/audio/transcriptions (OpenAI Whisper / gpt-4o-transcribe, Groq, etc.)
 *   deepgram           - POST https://api.deepgram.com/v1/listen
 *   elevenlabs         - POST https://api.elevenlabs.io/v1/speech-to-text (Scribe)
 *   custom_http        - any HTTP endpoint described in config.stt.custom
 *   mock               - returns a canned Arabic transcript (development only)
 */
import { config } from '../config.js';
import { getPath } from '../util.js';

const cfg = () => config.stt;

async function postForm(url, headers, form) {
  const res = await fetch(url, { method: 'POST', headers, body: form });
  const txt = await res.text();
  if (!res.ok) throw new Error(`STT ${res.status}: ${txt.slice(0, 400)}`);
  try { return JSON.parse(txt); } catch { return { text: txt }; }
}

const adapters = {
  async mock(audio) {
    return {
      text: `[نص تجريبي] الموظف: السلام عليكم معاك من شركة مهارة. العميل: أنا عايز أقدم شكوى على الخدمة، الموظف اللي كلمني قبل كده كان قليل الأدب. الموظف: حاضر يا فندم هنسجل الشكوى ونرجعلك. (حجم الملف ${audio.buffer?.length || 0} بايت)`,
      language: 'ar', segments: [], provider: 'mock', model: 'mock',
    };
  },

  async openai_compatible(audio) {
    const c = cfg();
    const form = new FormData();
    form.append('file', new Blob([audio.buffer], { type: audio.contentType }), audio.filename || 'call.wav');
    form.append('model', c.model || 'whisper-1');
    if (c.language) form.append('language', c.language);
    form.append('response_format', 'verbose_json');
    const j = await postForm(`${c.base_url.replace(/\/$/, '')}/audio/transcriptions`, { Authorization: `Bearer ${c.api_key}` }, form);
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
    const res = await fetch(`${(c.base_url || 'https://api.deepgram.com/v1').replace(/\/$/, '')}/listen?${params}`, {
      method: 'POST', headers: { Authorization: `Token ${c.api_key}`, 'Content-Type': audio.contentType || 'audio/wav' }, body: audio.buffer,
    });
    const j = await res.json();
    if (!res.ok) throw new Error(`STT ${res.status}: ${JSON.stringify(j).slice(0, 400)}`);
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
    const j = await postForm(`${(c.base_url || 'https://api.elevenlabs.io/v1').replace(/\/$/, '')}/speech-to-text`, { 'xi-api-key': c.api_key }, form);
    return { text: j.text || '', language: j.language_code, segments: (j.words || []).filter((w) => w.type === 'word').map((w) => ({ start: w.start, end: w.end, text: w.text, speaker: w.speaker_id })), provider: 'elevenlabs', model: c.model || 'scribe_v1' };
  },

  /**
   * Soniox async STT ($0.10/hour): POST /v1/files -> POST /v1/transcriptions (stt-async-v5)
   * -> poll GET /v1/transcriptions/{id} -> GET /v1/transcriptions/{id}/transcript -> DELETE (cleanup).
   */
  async soniox(audio) {
    const c = cfg();
    const base = (c.base_url && c.base_url.includes('soniox') ? c.base_url : 'https://api.soniox.com/v1').replace(/\/$/, '');
    const headers = { Authorization: `Bearer ${c.api_key}` };
    const jsonOrThrow = async (res, what) => { const j = await res.json().catch(() => ({})); if (!res.ok) throw new Error(`Soniox ${what} ${res.status}: ${JSON.stringify(j).slice(0, 300)}`); return j; };

    // 1) upload
    const form = new FormData();
    form.append('file', new Blob([audio.buffer], { type: audio.contentType }), audio.filename || 'call.wav');
    const file = await jsonOrThrow(await fetch(`${base}/files`, { method: 'POST', headers, body: form }), 'upload');

    // 2) create transcription
    const langs = (c.language || 'ar').split(',').map((s) => s.trim()).filter(Boolean);
    const body = { model: c.model && c.model.startsWith('stt-') ? c.model : 'stt-async-v5', file_id: file.id, language_hints: langs, enable_speaker_diarization: true, enable_language_identification: langs.length > 1 };
    const created = await jsonOrThrow(await fetch(`${base}/transcriptions`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), 'create');

    // 3) poll
    const deadline = Date.now() + (c.poll_timeout_sec || 900) * 1000;
    let st = created;
    while (st.status !== 'completed' && st.status !== 'error') {
      if (Date.now() > deadline) throw new Error(`Soniox timeout on transcription ${created.id} (status ${st.status})`);
      await new Promise((r) => setTimeout(r, 3000));
      st = await jsonOrThrow(await fetch(`${base}/transcriptions/${created.id}`, { headers }), 'status');
    }
    if (st.status === 'error') throw new Error(`Soniox error: ${st.error_type || ''} ${st.error_message || ''}`.trim());

    // 4) transcript (text + tokens with speaker) -> merge tokens into speaker turns
    const tr = await jsonOrThrow(await fetch(`${base}/transcriptions/${created.id}/transcript`, { headers }), 'transcript');
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

    // 5) cleanup on Soniox (we keep the text locally, not the audio)
    if (c.delete_after !== false) { fetch(`${base}/transcriptions/${created.id}`, { method: 'DELETE', headers }).catch(() => {}); fetch(`${base}/files/${file.id}`, { method: 'DELETE', headers }).catch(() => {}); }
    return { text, language: langs[0], segments, provider: 'soniox', model: body.model };
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
    const res = await fetch(c.url, { method: c.method || 'POST', headers, body });
    const txt = await res.text();
    if (!res.ok) throw new Error(`STT ${res.status}: ${txt.slice(0, 400)}`);
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
