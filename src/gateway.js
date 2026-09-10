/**
 * Recording access layer. Two sources, chosen automatically:
 *   - "branches": talk to every branch call-search server directly (form login with the same
 *                 credentials the gateway uses, read from the gateway's config.ini). Default.
 *   - "gateway":  callsearch-gateway's external /api/v1/* API with an API key (used when a key is set
 *                 and config.recordings.source is not forced to "branches").
 * Only the resolved branch + filepath are stored; audio is streamed/downloaded on demand.
 */
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import { config } from './config.js';
import { db, q } from './db.js';
import { loadBranches, branchById, searchBranch, openMedia, probeBranches } from './branches.js';

const log = (...a) => console.log(new Date().toISOString(), '[recordings]', ...a);

export function recordingSource() {
  const forced = config.recordings?.source;
  if (forced === 'branches' || forced === 'gateway') return forced;
  return config.gateway.api_key ? 'gateway' : 'branches';
}

/* ======================= gateway (API key) transport ======================= */
let _agent;
function agent(url) {
  if (!url.startsWith('https')) return undefined;
  if (_agent) return _agent;
  const opts = { keepAlive: true };
  if (config.gateway.insecure_tls) opts.rejectUnauthorized = false;
  else if (config.gateway.ca_file && fs.existsSync(config.gateway.ca_file)) opts.ca = fs.readFileSync(config.gateway.ca_file);
  return (_agent = new https.Agent(opts));
}
function authHeaders() {
  const h = { Accept: 'application/json' };
  const key = config.gateway.api_key;
  if (!key) return h;
  const name = config.gateway.api_key_header || 'X-API-Key';
  h[name] = name.toLowerCase() === 'authorization' ? `Bearer ${key}` : key;
  return h;
}
export function rawRequest(pathname, { method = 'GET', headers = {}, timeout } = {}) {
  const url = new URL(pathname, config.gateway.base_url);
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(url, { method, headers: { ...authHeaders(), ...headers }, agent: agent(url.href), timeout: timeout || config.gateway.timeout_ms || 30000 }, resolve);
    req.on('timeout', () => req.destroy(new Error('gateway timeout')));
    req.on('error', reject);
    req.end();
  });
}
async function readBody(res) { const chunks = []; for await (const c of res) chunks.push(c); return Buffer.concat(chunks); }
export async function getJson(pathname) {
  const res = await rawRequest(pathname);
  const body = await readBody(res);
  if (res.statusCode >= 400) throw new Error(`gateway ${res.statusCode} on ${pathname}: ${body.toString('utf8').slice(0, 300)}`);
  try { return JSON.parse(body.toString('utf8')); } catch { throw new Error(`gateway returned non-JSON for ${pathname}`); }
}
function extractResults(j) {
  if (Array.isArray(j)) return j;
  for (const k of ['results', 'files', 'data', 'items', 'calls']) if (Array.isArray(j?.[k])) return j[k];
  const out = [];
  const bag = j?.branches || j?.results || {};
  if (bag && typeof bag === 'object') for (const [b, v] of Object.entries(bag)) {
    const arr = Array.isArray(v) ? v : (v?.results || v?.files || []);
    for (const f of arr) out.push({ ...f, _branch: f._branch || b });
  }
  return out;
}
function gatewayMediaPath(kind, branch, filepath) {
  return `/api/v1/${kind}/${encodeURIComponent(branch)}/${encodeURIComponent(filepath)}`;
}

/* ======================= matching ======================= */
export function candidateBranches(serverName) {
  const m = q.one('SELECT gateway_branch FROM server_map WHERE server_name=?', serverName);
  if (m?.gateway_branch) return m.gateway_branch.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}
function toSeconds(dateStr, timeStr) {
  const d = new Date(`${dateStr}T${(timeStr || '00:00:00').padEnd(8, ':00')}`);
  return isNaN(d) ? null : d.getTime() / 1000;
}
/** Pick the best-matching file for a call: uniqueid inside the filename, else same extension + closest time. */
export function pickMatch(call, files) {
  if (!files?.length) return null;
  const uid = call.uniqueid;
  let hit = files.find((f) => uid && String(f.filename || f.filepath || f.path || '').includes(uid));
  if (hit) return { ...hit, _how: 'uniqueid' };
  const t0 = new Date(call.calldate.replace(' ', 'T')).getTime() / 1000;
  let best = null, bestDiff = 181;
  for (const f of files) {
    const ext = String(f.extension || f.ext || '');
    if (call.agent_ext && ext && ext !== String(call.agent_ext)) continue;
    const ts = toSeconds(f.call_date || f.date, f.call_time || f.time);
    if (ts == null) continue;
    const diff = Math.abs(ts - t0);
    if (diff < bestDiff) { bestDiff = diff; best = f; }
  }
  return best ? { ...best, _how: `time±${Math.round(bestDiff)}s` } : null;
}
const fileOf = (m) => m.filepath || m.path || m.file || m.filename;

/* ======================= resolve ======================= */
async function resolveViaBranches(call) {
  const all = loadBranches();
  if (!all.length) throw new Error('no branches configured (config.ini not found?)');
  const wanted = candidateBranches(call.server_name);
  const targets = wanted.length ? all.filter((b) => wanted.includes(b.id)) : all;
  const day = call.calldate.slice(0, 10);
  const params = { query: call.phone || call.dst_raw || '', date_from: day, date_to: day, sort: 'recent' };
  const settled = await Promise.allSettled(targets.map(async (b) => ({ b, files: await searchBranch(b, params) })));
  // prefer a uniqueid hit anywhere; fall back to the best time match
  let fallback = null;
  const rejected = [];
  for (const s of settled) {
    if (s.status !== 'fulfilled') { rejected.push(String(s.reason?.message || s.reason).slice(0, 120)); log(`search ${s.reason?.message || s.reason}`); continue; }
    const m = pickMatch(call, s.value.files);
    if (!m) continue;
    if (m._how === 'uniqueid') return { branch: s.value.b.id, filepath: fileOf(m), how: m._how };
    if (!fallback) fallback = { branch: s.value.b.id, filepath: fileOf(m), how: m._how };
  }
  if (fallback) return fallback;
  // a branch that could not be asked is an outage, not a missing recording (different retry policy, not charged to "not found")
  if (rejected.length) throw new Error(`branch unreachable: ${rejected.join(' | ')}`);
  throw new Error('recording not found on any branch');
}

async function resolveViaGateway(call) {
  const day = call.calldate.slice(0, 10);
  const params = new URLSearchParams({ query: call.phone || call.dst_raw || '', date_from: day, date_to: day, sort: 'recent', page: '1' });
  const branches = candidateBranches(call.server_name);
  if (branches.length) {
    const rejected = [];
    for (const b of branches) {
      params.set('branch', b);
      try {
        const m = pickMatch(call, extractResults(await getJson(`/api/v1/search?${params}`)).map((f) => ({ ...f, _branch: f._branch || b })));
        if (m) return { branch: b, filepath: fileOf(m), how: m._how };
      } catch (e) { rejected.push(`${b}: ${String(e.message).slice(0, 100)}`); log(`gateway search ${b} failed: ${e.message}`); }
    }
    if (rejected.length) throw new Error(`branch unreachable (gateway): ${rejected.join(' | ')}`);
    throw new Error('recording not found on gateway');
  }
  const m = pickMatch(call, extractResults(await getJson(`/api/v1/search?${params}`)));
  if (!m) throw new Error('recording not found on gateway');
  return { branch: m._branch, filepath: fileOf(m), how: m._how };
}

/** Resolve (and cache) the recording branch + filepath of a call. */
export async function resolveRecording(call, { force = false } = {}) {
  if (!force && call.recording_branch && call.recording_path) return { branch: call.recording_branch, filepath: call.recording_path, cached: true };
  const r = recordingSource() === 'gateway' ? await resolveViaGateway(call) : await resolveViaBranches(call);
  db.prepare('UPDATE calls SET recording_branch=?, recording_path=? WHERE id=?').run(r.branch, r.filepath, call.id);
  return r;
}

/* ======================= media ======================= */
async function openUpstream(call, kind, range) {
  const { branch, filepath } = await resolveRecording(call);
  if (recordingSource() === 'gateway') {
    const headers = range ? { Range: range } : {};
    return rawRequest(gatewayMediaPath(kind, branch, filepath), { headers, timeout: 180000 });
  }
  const b = branchById(branch);
  if (!b) throw new Error(`branch "${branch}" is not in config.ini`);
  return openMedia(b, kind, filepath, { range });
}

/** Proxy-stream the recording to the browser, passing Range through (no local storage). */
export async function streamRecording(call, req, res) {
  let up = await openUpstream(call, 'play', req.headers.range);
  if (up.statusCode === 404 && call.recording_path) {
    // cached path went stale (file moved/archived) -> resolve again once
    up.resume();
    await resolveRecording(call, { force: true });
    up = await openUpstream(call, 'play', req.headers.range);
  }
  if (up.statusCode >= 400) { up.resume(); throw new Error(`branch returned ${up.statusCode} for the recording`); }
  res.status(up.statusCode);
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition', 'cache-control']) if (up.headers[h]) res.setHeader(h, up.headers[h]);
  if (!up.headers['content-type']) res.setHeader('content-type', 'audio/wav');
  // a branch resetting the stream or a listener closing the player must not crash the process
  up.on('error', () => { try { res.destroy(); } catch {} });
  res.on('close', () => { try { up.destroy(); } catch {} });
  up.pipe(res);
}

/** Download the whole recording into memory for the STT step (discarded afterwards). */
export async function downloadRecording(call) {
  const up = await openUpstream(call, 'download');
  const buf = await readBody(up);
  if (up.statusCode >= 400) throw new Error(`upstream ${up.statusCode} downloading recording`);
  const { filepath } = await resolveRecording(call);
  return { buffer: buf, contentType: up.headers['content-type'] || 'audio/wav', filename: String(filepath).split(/[\\/]/).pop() };
}

/* ======================= health ======================= */
export async function listBranches() {
  if (recordingSource() === 'gateway') { const j = await getJson('/api/v1/branches'); return Array.isArray(j) ? j : (j.branches || j.data || j.results || []); }
  return loadBranches().map((b) => ({ id: b.id, name: b.name, url: b.url }));
}
export async function probeGateway() {
  const t = Date.now();
  const source = recordingSource();
  try {
    if (source === 'gateway') { const b = await listBranches(); return { ok: true, source, ms: Date.now() - t, branches: b, has_key: true }; }
    const probes = await probeBranches();
    return { ok: probes.some((p) => p.ok), source, ms: Date.now() - t, branches: probes, has_key: !!config.gateway.api_key };
  } catch (e) { return { ok: false, source, error: e.message, has_key: !!config.gateway.api_key }; }
}
