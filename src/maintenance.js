/**
 * Background maintenance: Soniox janitor (every 15 min), health monitors with admin alerts (every 5 min),
 * a daily non-blocking database backup (newest 7 kept), log retention, and a check that the watchdog task exists.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { backup as sqliteBackup } from 'node:sqlite';
import { ROOT, config } from './config.js';
import { db, q, getSettings, setSetting } from './db.js';
import { nowIso, stampIn } from './util.js';
import { sonioxJanitor } from './stt/index.js';
import { alertOnce, notifyAdmins, circuitState } from './resilience.js';
import { queueStats, kick } from './worker.js';

const log = (...a) => console.log(new Date().toISOString(), '[maintenance]', ...a);
const safe = (name, fn) => async () => { try { await fn(); } catch (e) { log(`${name} failed:`, e.message); } };
const backupDir = () => path.resolve(ROOT, config.backup?.dir || 'data/backups');
const localMs = (stamp) => new Date(String(stamp).replace(' ', 'T')).getTime();

export const backupState = { last: null, error: null, running: false };
export const opsState = { watchdog: null, watchdog_checked_at: null };

/* ------------------------------ backup ------------------------------ */
let backupRunning = null;
/**
 * Consistent snapshot of the live database. node:sqlite's backup() copies pages in steps on the thread pool,
 * so the web UI, the lanes and /healthz keep working while it runs (VACUUM INTO would freeze the whole process).
 */
export function backupNow() {
  if (backupRunning) return backupRunning;
  backupRunning = doBackup().finally(() => { backupRunning = null; backupState.running = false; });
  return backupRunning;
}
async function doBackup() {
  backupState.running = true;
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `quality-${nowIso().slice(0, 10)}.db`);
  const tmp = file + '.tmp';
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  setSetting('backup_last_attempt', nowIso());
  const t0 = Date.now();
  await sqliteBackup(db, tmp, { rate: 200 });
  fs.renameSync(tmp, file);
  const all = fs.readdirSync(dir).filter((f) => /^quality-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  for (const f of all.slice(0, Math.max(0, all.length - 7))) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
  backupState.last = { file, at: nowIso(), size_mb: Math.round(fs.statSync(file).size / 1048576), took_ms: Date.now() - t0 };
  backupState.error = null;
  log(`backup written: ${file} (${backupState.last.size_mb} MB in ${backupState.last.took_ms} ms)`);
  return backupState.last;
}

function latestBackup() {
  try {
    const dir = backupDir();
    const all = fs.readdirSync(dir).filter((f) => /^quality-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    if (!all.length) return null;
    const file = path.join(dir, all.at(-1));
    const st = fs.statSync(file);
    return { file, at: st.mtime.toISOString().replace('T', ' ').slice(0, 19), size_mb: Math.round(st.size / 1048576) };
  } catch { return null; }
}

async function backupTick() {
  backupState.last ||= latestBackup();
  if (fs.existsSync(path.join(backupDir(), `quality-${nowIso().slice(0, 10)}.db`))) return;
  // an attempt in the last 6 hours that did not produce today's file was interrupted or failed: don't loop on it
  const lastAttempt = getSettings().backup_last_attempt;
  if (lastAttempt && Date.now() - localMs(lastAttempt) < 6 * 3600e3) return;
  // one backup per day, preferably in the quiet hours after 02:00 - but never go a day without one
  if (new Date().getHours() < 2 && backupState.last) return;
  try { await backupNow(); }
  catch (e) {
    backupState.error = e.message;
    alertOnce('backup_failed', 720, () => notifyAdmins({ kind: 'system', subject: 'فشل النسخ الاحتياطي', text: `⚠️ فشل النسخ الاحتياطي اليومي لقاعدة البيانات: ${e.message}` }));
    throw e;
  }
}

/* ------------------------------ logs ------------------------------ */
/** NSSM never deletes rotated logs: keep 14 days of platform logs and cap the watchdog log at 5 MB. */
function pruneLogs() {
  const dir = path.join(ROOT, 'logs');
  if (!fs.existsSync(dir)) return;
  const cutoff = Date.now() - 14 * 864e5;
  let removed = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!/^platform(-error)?-.+\.log$/i.test(f)) continue;
    const p = path.join(dir, f);
    try { if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); removed++; } } catch {}
  }
  const wd = path.join(dir, 'watchdog.log');
  try {
    const st = fs.statSync(wd);
    if (st.size > 5 * 1048576) { const buf = fs.readFileSync(wd); fs.writeFileSync(wd, buf.subarray(buf.length - 1048576)); }
  } catch {}
  if (removed) log(`log retention: removed ${removed} rotated log files older than 14 days`);
}

/* ------------------------------ watchdog task check ------------------------------ */
function checkWatchdogTask() {
  if (process.platform !== 'win32') return;
  execFile('schtasks', ['/query', '/tn', 'CallQualityPlatform Watchdog'], { windowsHide: true, timeout: 20000 }, (err) => {
    opsState.watchdog = !err;
    opsState.watchdog_checked_at = nowIso();
    if (err) alertOnce('watchdog_missing', 1440, () => notifyAdmins({ kind: 'system', subject: 'مراقب الخدمة غير مثبت',
      text: '⚠️ مهمة المراقب (Watchdog) مش مثبتة على السيرفر، فالخدمة مش هترجع لوحدها لو علّقت. شغّل INSTALL_SERVICE.bat كـ Administrator مرة واحدة.' }));
  });
}

/* ------------------------------ monitors ------------------------------ */
/** Watch for problems that nobody would notice until it is too late, and tell the admins once. */
async function monitors() {
  const s = getSettings();
  const interval = config.collector.interval_sec || 300;

  for (const w of q.all('SELECT * FROM sync_watermark')) {
    if (w.last_error) {
      alertOnce(`collector:${w.warehouse}`, 180, () => notifyAdmins({ kind: 'system', subject: `تعذر السحب من مستودع ${w.warehouse}`,
        text: `⚠️ تعذر سحب المكالمات من المستودع ${w.warehouse}: ${w.last_error}\nالنظام بيعيد المحاولة كل ${interval} ثانية ومش هيضيع أي مكالمة (بيكمل من آخر نقطة وصلها).` }));
    }
  }

  const st = queueStats();
  if (s.auto_transcribe && circuitState('stt') === 'closed' && st.queued > 0) {
    const eligible = q.one("SELECT COUNT(*) c FROM calls WHERE status='queued' AND (retry_after IS NULL OR retry_after <= ?) AND (queued_by IS NOT NULL OR calldate <= ?)", nowIso(), stampIn(-10 * 60000)).c;
    const recent = q.one('SELECT COUNT(*) c FROM transcripts WHERE created_at >= ?', stampIn(-30 * 60000)).c;
    if (eligible > 0 && recent === 0) {
      kick();
      alertOnce('stt_stalled', 120, () => notifyAdmins({ kind: 'system', subject: 'التحويل لنص مش بيتقدم', text: `⚠️ فيه ${eligible} مكالمة جاهزة للتحويل ومفيش ولا مكالمة اتحولت آخر 30 دقيقة. راجع صفحة حالة النظام واللوجات.` }));
    }
  }

  const limit = Number(s.backlog_alert || 0);
  if (limit && st.queued > limit) {
    alertOnce('backlog', 360, () => notifyAdmins({ kind: 'system', subject: 'الطابور كبير', text: `ℹ️ فيه ${st.queued} مكالمة في طابور التحويل (الحد ${limit}). النظام بيحوّل الأحدث أولاً؛ لو عايز تخلّص أسرع زوّد عدد التحويلات المتوازية من صفحة حالة النظام.` }));
  }
}

let started = false;
export function startMaintenance() {
  if (started) return;
  started = true;
  const every = (ms, fn) => { const t = setInterval(fn, ms); t.unref?.(); };
  const once = (ms, fn) => { const t = setTimeout(fn, ms); t.unref?.(); };
  once(60 * 1000, safe('janitor', () => sonioxJanitor()));
  every(15 * 60 * 1000, safe('janitor', () => sonioxJanitor()));
  every(5 * 60 * 1000, safe('monitors', monitors));
  once(3 * 60 * 1000, safe('backup', backupTick));
  every(30 * 60 * 1000, safe('backup', backupTick));
  once(30 * 1000, safe('logs', pruneLogs));
  every(24 * 3600 * 1000, safe('logs', pruneLogs));
  once(10 * 1000, safe('watchdog-check', checkWatchdogTask));
  every(12 * 3600 * 1000, safe('watchdog-check', checkWatchdogTask));
}

export function maintenanceInfo() {
  return { backup: backupState.last || latestBackup(), backup_error: backupState.error, backup_running: backupState.running, watchdog: opsState.watchdog, leftovers: q.one('SELECT COUNT(*) c FROM soniox_leftovers').c };
}
