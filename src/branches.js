/**
 * Direct branch client: talks to each branch's call-search server the same way the gateway does
 * (form login -> session cookie -> /api/search, /api/play, /api/download).
 * Branch list + the `dashboard` credentials are read at runtime from the gateway's config.ini
 * (config.branches.ini_file), so no secrets are duplicated here.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { config, ROOT } from './config.js';

const log = (...a) => console.log(new Date().toISOString(), '[branches]', ...a);

let _branches = null, _mtime = 0;
export function loadBranches() {
  // the gateway's config.ini next to the platform (dev machine), else a local copy branches.ini (production server)
  const candidates = [config.branches?.ini_file || '../config.ini', './branches.ini'].map((p) => path.resolve(ROOT, p));
  const file = candidates.find((p) => fs.existsSync(p)) || candidates[0];
  const st = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
  if (_branches && st === _mtime) return _branches;
  const out = [];
  if (st) {
    let cur = null;
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith(';') || line.startsWith('#')) continue;
      const sec = line.match(/^\[branch:([^\]]+)\]$/);
      if (sec) { cur = { id: sec[1].trim() }; out.push(cur); continue; }
      if (line.startsWith('[')) { cur = null; continue; }
      if (cur) { const i = line.indexOf('='); if (i > 0) cur[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
    }
  }
  for (const b of config.branches?.extra || []) out.push(b);
  _branches = out.filter((b) => b.url && b.username); _mtime = st;
  return _branches;
}

/* ---------------- per-branch session ---------------- */
const sessions = new Map(); // id -> { cookie, at }
const agents = { 'http:': new http.Agent({ keepAlive: true }), 'https:': new https.Agent({ keepAlive: true, rejectUnauthorized: false }) };

function request(url, { method = 'GET', headers = {}, body = null, timeout = 30000 } = {}) {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(u, { method, headers, agent: agents[u.protocol], timeout }, resolve);
    req.on('timeout', () => req.destroy(new Error(`timeout ${url}`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
async function drain(res) { const c = []; for await (const x of res) c.push(x); return Buffer.concat(c); }
function cookiesOf(res) {
  return (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
}

export async function login(b) {
  const body = new URLSearchParams({ username: b.username, password: b.password }).toString();
  const res = await request(`${b.url}/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }, body });
  await drain(res);
  const cookie = cookiesOf(res);
  const ok = (res.statusCode === 302 || res.statusCode === 303) && !String(res.headers.location || '').includes('login') && cookie;
  if (!ok) throw new Error(`login failed on ${b.id} (status ${res.statusCode})`);
  sessions.set(b.id, { cookie, at: Date.now() });
  return cookie;
}

async function authed(b, pathname, opts = {}, retry = true) {
  let s = sessions.get(b.id);
  if (!s) await login(b), (s = sessions.get(b.id));
  const res = await request(`${b.url}${pathname}`, { ...opts, headers: { ...(opts.headers || {}), Cookie: s.cookie, Accept: opts.accept || 'application/json' } });
  const redirectedToLogin = [301, 302, 303].includes(res.statusCode) && String(res.headers.location || '').includes('login');
  if ((res.statusCode === 401 || redirectedToLogin) && retry) { res.resume(); sessions.delete(b.id); return authed(b, pathname, opts, false); }
  return res;
}

/** Search one branch. Returns the array of file objects (shape as the branch returns it). */
export async function searchBranch(b, { query, date_from, date_to, page = 1, sort = 'recent' }) {
  const p = new URLSearchParams({ query: query || '', date_from: date_from || '', date_to: date_to || '', page: String(page), sort });
  const res = await authed(b, `/api/search?${p}`);
  const buf = await drain(res);
  if (res.statusCode >= 400) throw new Error(`${b.id} search ${res.statusCode}: ${buf.toString('utf8').slice(0, 200)}`);
  let j; try { j = JSON.parse(buf.toString('utf8')); } catch { throw new Error(`${b.id} search returned non-JSON`); }
  if (Array.isArray(j)) return j;
  for (const k of ['results', 'files', 'data', 'items', 'calls']) if (Array.isArray(j?.[k])) return j[k];
  return [];
}

/** Open the media stream (play or download) on a branch; returns the upstream IncomingMessage. */
export async function openMedia(b, kind, filepath, { range } = {}) {
  const enc = filepath.split('/').map(encodeURIComponent).join('/');
  const headers = {};
  if (range) headers.Range = range;
  return authed(b, `/api/${kind}/${enc}`, { headers, accept: '*/*', timeout: 180000 });
}

export function branchById(id) { return loadBranches().find((b) => b.id === id); }

export async function probeBranches() {
  const out = [];
  for (const b of loadBranches()) {
    const t = Date.now();
    try { await login(b); out.push({ id: b.id, name: b.name, url: b.url, ok: true, ms: Date.now() - t }); }
    catch (e) { out.push({ id: b.id, name: b.name, url: b.url, ok: false, error: e.message }); }
  }
  return out;
}
