/**
 * Background maintenance: Soniox janitor (every 15 min), health monitors with admin alerts (every 5 min)
 * and a daily database backup (data/backups, newest 7 kept).
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, config } from './config.js';
import { db, q, getSettings } from './db.js';
import { nowIso, stampIn } from './util.js';
import { sonioxJanitor } from './stt/index.js';
import { alertOnce, notifyAdmins, circuitState } from './resilience.js';
import { queueStats, kick } from './worker.js';

const log = (...a) => console.log(new Date().toISOString(), '[maintenance]', ...a);
const safe = (name, fn) => async () => { try { await fn(); } catch (e) { log(`${name} failed:`, e.message); } };
const BACKUP_DIR = path.join(ROOT, 'data', 'backups');

export const backupState = { last: null, error: null };

/** Consistent snapshot of the live database (safe while it is being written: WAL + VACUUM INTO). */
export function backupNow() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const file = path.join(BACKUP_DIR, `quality-${nowIso().slice(0, 10)}.db`);
  const tmp = file + '.tmp';
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  const t0 = Date.now();
  db.exec(`VACUUM INTO '${tmp.replace(/\\/g, '/').replace(/'/g, "''")}'`);
  fs.renameSync(tmp, file);
  const all = fs.readdirSync(BACKUP_DIR).filter((f) => /^quality-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  for (const f of all.slice(0, Math.max(0, all.length - 7))) { try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch {} }
  backupState.last = { file, at: nowIso(), size_mb: Math.round(fs.statSync(file).size / 1048576), took_ms: Date.now() - t0 };
  backupState.error = null;
  log(`backup written: ${file} (${backupState.last.size_mb} MB in ${backupState.last.took_ms} ms)`);
  return backupState.last;
}

function latestBackup() {
  try {
    const all = fs.readdirSync(BACKUP_DIR).filter((f) => /^quality-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    if (!all.length) return null;
    const file = path.join(BACKUP_DIR, all.at(-1));
    const st = fs.statSync(file);
    return { file, at: st.mtime.toISOString().replace('T', ' ').slice(0, 19), size_mb: Math.round(st.size / 1048576) };
  } catch { return null; }
}

async function backupTick() {
  backupState.last ||= latestBackup();
  const today = nowIso().slice(0, 10);
  if (fs.existsSync(path.join(BACKUP_DIR, `quality-${today}.db`))) return;
  // one backup per day, preferably in the quiet hours after 02:00 - but never go a day without one
  if (new Date().getHours() < 2 && backupState.last) return;
  try { backupNow(); }
  catch (e) {
    backupState.error = e.message;
    alertOnce('backup_failed', 720, () => notifyAdmins({ kind: 'system', subject: 'فشل النسخ الاحتياطي', text: `⚠️ فشل النسخ الاحتياطي اليومي لقاعدة البيانات: ${e.message}` }));
    throw e;
  }
}

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
  setTimeout(safe('janitor', () => sonioxJanitor()), 60 * 1000).unref?.();
  every(15 * 60 * 1000, safe('janitor', () => sonioxJanitor()));
  every(5 * 60 * 1000, safe('monitors', monitors));
  setTimeout(safe('backup', backupTick), 3 * 60 * 1000).unref?.();
  every(30 * 60 * 1000, safe('backup', backupTick));
}

export function maintenanceInfo() {
  return { backup: backupState.last || latestBackup(), backup_error: backupState.error, leftovers: q.one('SELECT COUNT(*) c FROM soniox_leftovers').c };
}
