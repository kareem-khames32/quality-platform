import express from 'express';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { loadTls } from './tls.js';
import { fileURLToPath } from 'node:url';
import { config, saveConfigPatch, ROOT } from './config.js';
import { db, q, getSettings, setSetting, seedDefaults, DEFAULT_SETTINGS } from './db.js';
import { ensureAdmin, sessionMiddleware, requireLogin, requireRole, requireCap, createSession, destroySession, hashPassword, verifyPassword, checkLock, noteFailure, clearFailures, ticketScopeSql, canActOnTicket, ROLES, roleInfo, normalizeRole } from './auth.js';
import { runCollectorLoop, collectAll, probeWarehouses, evaluateRules } from './collector.js';
import { runWorkerLoop, queueCall, queueStats } from './worker.js';
import { streamRecording, resolveRecording, probeGateway, recordingSource } from './gateway.js';
import { loadBranches } from './branches.js';
import { assignRoles, swapRoles, roleLabel, formatTranscript } from './roles.js';
import { notifyTicket, unreadCount, smtpReady, sendMail } from './notify.js';

/** Can this user open/listen to this call? Admin/supervisor: always. Others: only calls tied to a ticket they can see (same customer phone counts). */
function canAccessCall(user, call) {
  if (!user || !call) return false;
  if (roleInfo(user.role).calls) return true;
  const scope = ticketScopeSql(user);
  return !!q.one(`SELECT 1 FROM tickets t JOIN calls tc ON tc.id=t.call_id WHERE ${scope.sql} AND (t.call_id=? OR (tc.phone<>'' AND tc.phone=?)) LIMIT 1`, ...scope.params, call.id, call.phone || '');
}
const staffOnly = requireCap('calls');   // quality team (specialists, quality manager, admin)
import { analyzeCall, openTicket, findBannedWords, chainFor, dueAt } from './analyzer.js';
import { sttReady } from './stt/index.js';
import { llmReady } from './llm/index.js';
import { nowIso, fmtDuration } from './util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(ROOT, 'views'));
app.set('trust proxy', true);
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));
app.use('/static', express.static(path.join(ROOT, 'public')));
app.use((req, _res, next) => { // tiny cookie parser
  req.cookies = {};
  for (const part of (req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) req.cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  next();
});
app.use(sessionMiddleware);
app.use((req, res, next) => {
  res.locals.user = req.user; res.locals.path = req.path; res.locals.msg = req.query.msg || null; res.locals.err = req.query.err || null;
  res.locals.fmtDuration = fmtDuration; res.locals.warehouses = config.warehouses;
  res.locals.providers = { stt: sttReady() ? config.stt.provider : null, llm: llmReady() ? config.llm.provider : null, gateway: recordingSource() === 'gateway' ? !!config.gateway.api_key : loadBranches().length > 0, source: recordingSource() };
  res.locals.openTickets = req.user ? q.one(`SELECT COUNT(*) c FROM tickets t WHERE t.status IN ('open','in_progress') AND ${ticketScopeSql(req.user).sql}`, ...ticketScopeSql(req.user).params).c : 0;
  res.locals.unread = req.user ? unreadCount(req.user.id) : 0;
  res.locals.providers.smtp = smtpReady();
  res.locals.isStaff = !!req.user && !!roleInfo(req.user.role).calls;
  res.locals.ROLES = ROLES;
  next();
});

const back = (req, res, msg, err) => res.redirect((req.get('referer') || '/') .split('?')[0] + (msg ? `?msg=${encodeURIComponent(msg)}` : err ? `?err=${encodeURIComponent(err)}` : ''));
const STATUS_AR = { new: 'جديدة', skipped: 'مستبعدة', queued: 'في الانتظار', transcribing: 'جاري التحويل', transcribed: 'تم التحويل', analyzing: 'جاري التحليل', analyzed: 'تم التحليل', failed: 'فشلت' };
const TICKET_AR = { open: 'مفتوحة', in_progress: 'قيد المعالجة', resolved: 'تم الحل', closed: 'مغلقة' };
app.locals.STATUS_AR = STATUS_AR; app.locals.TICKET_AR = TICKET_AR;

/* ------------------------------ auth ------------------------------ */
app.get('/login', (req, res) => req.user ? res.redirect('/') : res.render('login', { error: null, next: req.query.next || '/' }));
app.post('/login', (req, res) => {
  const ip = req.ip;
  const locked = checkLock(ip);
  if (locked) return res.render('login', { error: `محاولات كثيرة، حاول بعد ${locked} دقيقة`, next: req.body.next || '/' });
  const u = q.one('SELECT * FROM users WHERE username=? AND active=1', (req.body.username || '').trim());
  if (!u || !verifyPassword(req.body.password || '', u.password_hash)) { noteFailure(ip); return res.render('login', { error: 'اسم المستخدم أو كلمة المرور غير صحيحة', next: req.body.next || '/' }); }
  clearFailures(ip); createSession(res, u.id);
  res.redirect(u.must_change_password ? '/change-password' : (req.body.next?.startsWith('/') ? req.body.next : '/'));
});
app.post('/logout', (req, res) => { destroySession(req, res); res.redirect('/login'); });
// internal CA certificate download (no login) so staff can trust the HTTPS certificate once
app.get('/ca.crt', (req, res) => { const p = path.join(ROOT, 'data', 'certs', 'ca.crt'); return fs.existsSync(p) ? res.download(p, 'maharah-call-quality-ca.crt') : res.status(404).type('text/plain').send('no internal CA (custom certificate in use)'); });
app.get('/change-password', requireLogin, (req, res) => res.render('change_password', { error: null, forced: !!req.user.must_change_password }));
app.post('/change-password', requireLogin, (req, res) => {
  const u = q.one('SELECT * FROM users WHERE id=?', req.user.id);
  const { current, password, confirm } = req.body;
  if (!u.must_change_password && !verifyPassword(current || '', u.password_hash)) return res.render('change_password', { error: 'كلمة المرور الحالية غير صحيحة', forced: false });
  if (!password || password.length < 8) return res.render('change_password', { error: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل', forced: !!u.must_change_password });
  if (password !== confirm) return res.render('change_password', { error: 'كلمتا المرور غير متطابقتين', forced: !!u.must_change_password });
  db.prepare('UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?').run(hashPassword(password), u.id);
  res.redirect('/?msg=' + encodeURIComponent('تم تغيير كلمة المرور'));
});

app.use(requireLogin);

/* ------------------------------ dashboard ------------------------------ */
app.get('/', (req, res) => {
  if (!res.locals.isStaff) return res.redirect('/tickets');
  const scope = ticketScopeSql(req.user);
  const days = q.all(`SELECT substr(calldate,1,10) d, COUNT(*) calls, SUM(status='analyzed') analyzed, SUM(status IN ('queued','transcribing','analyzing')) pending
                      FROM calls WHERE calldate >= date('now','-14 days') GROUP BY d ORDER BY d`);
  const byStatus = Object.fromEntries(q.all('SELECT status, COUNT(*) c FROM calls GROUP BY status').map((r) => [r.status, r.c]));
  const byServer = q.all(`SELECT warehouse, server_name, COUNT(*) calls, SUM(status='analyzed') analyzed, MAX(calldate) last_call FROM calls GROUP BY warehouse, server_name ORDER BY warehouse, server_name`);
  const tickets = q.all(`SELECT t.status, COUNT(*) c FROM tickets t WHERE ${scope.sql} GROUP BY t.status`, ...scope.params);
  const recentTickets = q.all(`SELECT t.*, c.name company_name, ca.calldate FROM tickets t LEFT JOIN companies c ON c.id=t.company_id JOIN calls ca ON ca.id=t.call_id WHERE ${scope.sql} ORDER BY t.id DESC LIMIT 8`, ...scope.params);
  const topAgents = q.all(`SELECT COALESCE(t.agent_name, t.agent_ext) agent, COUNT(*) c FROM tickets t WHERE ${scope.sql} AND t.created_at >= datetime('now','-30 days') GROUP BY agent ORDER BY c DESC LIMIT 8`, ...scope.params);
  const wm = q.all('SELECT * FROM sync_watermark');
  const usage = q.all("SELECT day, kind, count, seconds FROM usage_log WHERE day >= date('now','-7 days') ORDER BY day");
  res.render('dashboard', { days, byStatus, byServer, tickets: Object.fromEntries(tickets.map((t) => [t.status, t.c])), recentTickets, topAgents, wm, usage, settings: getSettings() });
});

/* ------------------------------ calls ------------------------------ */
function callFilters(qs) {
  const w = [], p = [];
  if (qs.warehouse) { w.push('c.warehouse=?'); p.push(qs.warehouse); }
  if (qs.server) { w.push('c.server_name=?'); p.push(qs.server); }
  if (qs.ext) { w.push('c.agent_ext=?'); p.push(qs.ext.trim()); }
  if (qs.phone) { w.push('(c.phone LIKE ? OR c.dst_raw LIKE ?)'); p.push(`%${qs.phone.trim()}%`, `%${qs.phone.trim()}%`); }
  if (qs.agent) { w.push('c.agent_name LIKE ?'); p.push(`%${qs.agent.trim()}%`); }
  if (qs.from) { w.push('c.calldate >= ?'); p.push(qs.from + ' 00:00:00'); }
  if (qs.to) { w.push('c.calldate <= ?'); p.push(qs.to + ' 23:59:59'); }
  if (qs.status) { w.push('c.status=?'); p.push(qs.status); }
  if (qs.min) { w.push('c.billsec >= ?'); p.push(Number(qs.min)); }
  if (qs.flag === 'complaint') w.push('a.is_complaint=1');
  if (qs.flag === 'banned') w.push("a.banned_hits IS NOT NULL AND a.banned_hits <> '[]'");
  if (qs.flag === 'ticket') w.push('EXISTS(SELECT 1 FROM tickets t WHERE t.call_id=c.id)');
  return { where: w.length ? 'WHERE ' + w.join(' AND ') : '', params: p };
}
app.get('/calls', staffOnly, (req, res) => {
  const qs = req.query;
  if (!qs.from && !qs.to && !qs.phone && !qs.ext && !qs.status && !qs.flag) qs.from = nowIso().slice(0, 10);
  const { where, params } = callFilters(qs);
  const page = Math.max(1, Number(qs.page) || 1), per = 50;
  const sort = qs.sort === 'duration' ? 'c.billsec DESC' : 'c.calldate DESC';
  const total = q.one(`SELECT COUNT(*) c FROM calls c LEFT JOIN analyses a ON a.call_id=c.id ${where}`, ...params).c;
  const rows = q.all(`SELECT c.*, a.is_complaint, a.severity a_severity, a.banned_hits, a.quality_score,
                      (SELECT id FROM tickets t WHERE t.call_id=c.id ORDER BY id DESC LIMIT 1) ticket_id,
                      (SELECT COUNT(*) FROM listens l WHERE l.call_id=c.id) listen_count,
                      (SELECT GROUP_CONCAT(DISTINCT COALESCE(u.full_name, u.username)) FROM listens l LEFT JOIN users u ON u.id=l.user_id WHERE l.call_id=c.id) listeners
                      FROM calls c LEFT JOIN analyses a ON a.call_id=c.id ${where} ORDER BY ${sort} LIMIT ? OFFSET ?`, ...params, per, (page - 1) * per);
  for (const r of rows) { try { r.hits = JSON.parse(r.banned_hits || '[]').length; } catch { r.hits = 0; } }
  const servers = q.all('SELECT DISTINCT warehouse, server_name FROM calls ORDER BY warehouse, server_name');
  res.render('calls', { rows, total, page, per, qs, servers, settings: getSettings() });
});
app.post('/calls/bulk', staffOnly, (req, res) => {
  const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean);
  if (req.body.action === 'transcribe') for (const id of ids) queueCall(id, req.user.id);
  back(req, res, `تمت إضافة ${ids.length} مكالمة لقائمة التحويل`);
});
app.get('/calls/:id', (req, res) => {
  const call = q.one('SELECT * FROM calls WHERE id=?', req.params.id);
  if (!call) return res.status(404).render('error', { title: 'غير موجود', message: 'المكالمة غير موجودة' });
  if (!canAccessCall(req.user, call)) return res.status(403).render('error', { title: 'غير مصرح', message: 'هذه المكالمة غير مرتبطة بتذكرة لديك صلاحية عليها' });
  const transcript = q.one('SELECT * FROM transcripts WHERE call_id=?', call.id);
  const analysis = q.one('SELECT * FROM analyses WHERE call_id=?', call.id);
  if (analysis) { for (const k of ['banned_hits', 'issues', 'recommendations']) { try { analysis[k] = JSON.parse(analysis[k] || '[]'); } catch { analysis[k] = []; } } }
  let segments = []; try { segments = JSON.parse(transcript?.segments || '[]'); } catch {}
  let speakerMap = {}; try { speakerMap = JSON.parse(transcript?.speaker_map || '{}'); } catch {}
  if (segments.length && !Object.keys(speakerMap).length) speakerMap = assignRoles(segments, call);
  const tickets = q.all('SELECT t.*, c.name company_name FROM tickets t LEFT JOIN companies c ON c.id=t.company_id WHERE t.call_id=? ORDER BY t.id DESC', call.id);
  const companies = q.all('SELECT id, name FROM companies WHERE active=1 ORDER BY name');
  const listens = q.all('SELECT l.listened_at, COALESCE(u.full_name, u.username) who FROM listens l LEFT JOIN users u ON u.id=l.user_id WHERE l.call_id=? ORDER BY l.id DESC LIMIT 50', call.id);
  const settings = getSettings();
  res.render('call', { call, transcript, analysis, segments, speakerMap, roleLabel: (r) => roleLabel(r, settings.role_labels), tickets, companies, listens, rule: evaluateRules(call, settings) });
});
/** Swap المحصل/العميل when the automatic guess was wrong. */
app.post('/calls/:id/swap-roles', staffOnly, (req, res) => {
  const tr = q.one('SELECT segments, speaker_map FROM transcripts WHERE call_id=?', req.params.id);
  if (tr) {
    let map = {}; try { map = JSON.parse(tr.speaker_map || '{}'); } catch {}
    if (!Object.keys(map).length) { const call = q.one('SELECT * FROM calls WHERE id=?', req.params.id); map = assignRoles(JSON.parse(tr.segments || '[]'), call); }
    db.prepare('UPDATE transcripts SET speaker_map=? WHERE call_id=?').run(JSON.stringify(swapRoles(map)), req.params.id);
  }
  res.redirect(`/calls/${req.params.id}?msg=${encodeURIComponent('تم تبديل الأدوار')}`);
});
app.post('/calls/:id/transcribe', staffOnly, (req, res) => { queueCall(Number(req.params.id), req.user.id); res.redirect(`/calls/${req.params.id}?msg=${encodeURIComponent('بدأ التحويل الآن، النص هيظهر هنا تلقائياً عند الانتهاء')}`); });
/** Live status for the UI: queue counters + per-call status for the ids requested. */
app.get('/api/queue.json', (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(Number).filter(Boolean).slice(0, 200);
  const calls = ids.length ? q.all(`SELECT id, status, error FROM calls WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids) : [];
  res.json({ stats: queueStats(), calls, labels: STATUS_AR, unread: unreadCount(req.user.id) });
});
app.post('/calls/:id/reanalyze', staffOnly, async (req, res) => {
  try { await analyzeCall(Number(req.params.id), { forceLLM: true }); res.redirect(`/calls/${req.params.id}?msg=${encodeURIComponent('تمت إعادة التحليل')}`); }
  catch (e) { res.redirect(`/calls/${req.params.id}?err=${encodeURIComponent(e.message)}`); }
});
app.post('/calls/:id/ticket', staffOnly, (req, res) => {
  const call = q.one('SELECT * FROM calls WHERE id=?', req.params.id);
  if (!call) return res.status(404).end();
  const id = openTicket({ call, companyId: Number(req.body.company_id) || null, severity: req.body.severity || 'medium', title: req.body.title || `تذكرة يدوية لمكالمة ${call.agent_ext}`, description: req.body.description || '', source: 'manual', userId: req.user.id });
  res.redirect(`/tickets/${id}`);
});
app.get('/calls/:id/audio', async (req, res) => {
  const call = q.one('SELECT * FROM calls WHERE id=?', req.params.id);
  if (!call) return res.status(404).end();
  if (!canAccessCall(req.user, call)) return res.status(403).type('text/plain; charset=utf-8').send('غير مصرح لك بسماع هذه المكالمة');
  // listen log: one entry per user per call per 30 minutes (players issue many Range requests for one listen)
  const recent = q.one("SELECT 1 FROM listens WHERE call_id=? AND user_id=? AND listened_at >= datetime('now','localtime','-30 minutes')", call.id, req.user.id);
  if (!recent) db.prepare('INSERT INTO listens(call_id,user_id,listened_at) VALUES(?,?,?)').run(call.id, req.user.id, nowIso());
  try { await streamRecording(call, req, res); }
  catch (e) {
    const notFound = /not found/i.test(e.message);
    const ageMin = (Date.now() - new Date(call.calldate.replace(' ', 'T')).getTime()) / 60000;
    const msg = notFound && ageMin < 30 ? 'التسجيل لم يصل لسيرفر الفرع بعد (المكالمات الجديدة تظهر خلال دقائق)، حاول لاحقاً'
      : notFound ? 'التسجيل غير موجود على أي فرع' : `تعذر جلب التسجيل: ${e.message}`;
    if (!res.headersSent) res.status(502).type('text/plain; charset=utf-8').send(msg);
  }
});
app.post('/calls/:id/resolve', staffOnly, async (req, res) => {
  const call = q.one('SELECT * FROM calls WHERE id=?', req.params.id);
  try { const r = await resolveRecording(call, { force: true }); res.redirect(`/calls/${call.id}?msg=${encodeURIComponent(`تم تحديد التسجيل: ${r.branch}/${r.filepath} (${r.how})`)}`); }
  catch (e) { res.redirect(`/calls/${call.id}?err=${encodeURIComponent(e.message)}`); }
});

/* ------------------------------ tickets ------------------------------ */
app.get('/tickets', (req, res) => {
  const scope = ticketScopeSql(req.user);
  const w = [scope.sql], p = [...scope.params];
  const status = req.query.status ?? 'active';
  if (status === 'active') w.push("t.status IN ('open','in_progress')"); else if (status && status !== 'all') { w.push('t.status=?'); p.push(status); }
  if (req.query.company) { w.push('t.company_id=?'); p.push(Number(req.query.company)); }
  if (req.query.severity) { w.push('t.severity=?'); p.push(req.query.severity); }
  const rows = q.all(`SELECT t.*, c.name company_name, ca.calldate, ca.phone, ca.server_name, u.username assignee
                      FROM tickets t LEFT JOIN companies c ON c.id=t.company_id JOIN calls ca ON ca.id=t.call_id LEFT JOIN users u ON u.id=t.assigned_to
                      WHERE ${w.join(' AND ')} ORDER BY CASE t.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, t.id DESC LIMIT 300`, ...p);
  const companies = q.all('SELECT id, name FROM companies ORDER BY name');
  res.render('tickets', { rows, companies, qs: { ...req.query, status } });
});
function loadTicket(req, res) {
  const scope = ticketScopeSql(req.user);
  const t = q.one(`SELECT t.*, c.name company_name FROM tickets t LEFT JOIN companies c ON c.id=t.company_id WHERE t.id=? AND ${scope.sql}`, req.params.id, ...scope.params);
  if (!t) { res.status(404).render('error', { title: 'غير موجود', message: 'التذكرة غير موجودة أو ليس لديك صلاحية عليها' }); return null; }
  return t;
}
app.get('/tickets/:id', (req, res) => {
  const t = loadTicket(req, res); if (!t) return;
  const call = q.one('SELECT * FROM calls WHERE id=?', t.call_id);
  const transcript = q.one('SELECT text, segments, speaker_map FROM transcripts WHERE call_id=?', t.call_id);
  if (transcript) {
    try {
      const segs = JSON.parse(transcript.segments || '[]'), map = JSON.parse(transcript.speaker_map || '{}');
      if (segs.length) transcript.text = formatTranscript(segs, Object.keys(map).length ? map : assignRoles(segs, call), getSettings().role_labels, { withTime: true });
    } catch {}
  }
  const analysis = q.one('SELECT * FROM analyses WHERE call_id=?', t.call_id);
  if (analysis) { for (const k of ['banned_hits', 'issues', 'recommendations']) { try { analysis[k] = JSON.parse(analysis[k] || '[]'); } catch { analysis[k] = []; } } }
  const events = q.all('SELECT e.*, u.username FROM ticket_events e LEFT JOIN users u ON u.id=e.user_id WHERE e.ticket_id=? ORDER BY e.id', t.id);
  const assignees = t.company_id ? q.all(`SELECT u.id, u.username, u.full_name FROM users u JOIN company_members m ON m.user_id=u.id WHERE m.company_id=? AND u.active=1 UNION SELECT id, username, full_name FROM users WHERE role IN ('admin','supervisor') AND active=1`, t.company_id)
                                 : q.all('SELECT id, username, full_name FROM users WHERE active=1');
  const companies = q.all('SELECT id, name FROM companies WHERE active=1 ORDER BY name');
  const chain = chainFor(t.company_id);
  // every other call with the same customer, so the handler can hear the full history without general calls access
  const related = call?.phone ? q.all(`SELECT c.id, c.calldate, c.server_name, c.agent_name, c.agent_ext, c.billsec, c.status,
        (SELECT 1 FROM transcripts tr WHERE tr.call_id=c.id) has_text, a.is_complaint, a.banned_hits,
        (SELECT COUNT(*) FROM listens l WHERE l.call_id=c.id) listens
        FROM calls c LEFT JOIN analyses a ON a.call_id=c.id WHERE c.phone=? ORDER BY c.calldate DESC LIMIT 40`, call.phone) : [];
  for (const r of related) { try { r.hits = JSON.parse(r.banned_hits || '[]').length; } catch { r.hits = 0; } }
  db.prepare('UPDATE notifications SET read_at=? WHERE user_id=? AND ticket_id=? AND read_at IS NULL').run(nowIso(), req.user.id, t.id);
  const canAct = canActOnTicket(req.user, t);
  const canClose = req.user.role === 'admin' || (canAct && roleInfo(req.user.role).close);
  res.render('ticket', { t, call, transcript, analysis, events, assignees, companies, chain, related, canAct, canClose, settings: getSettings() });
});
/** Final step: close the complaint with feedback + actions taken (sector manager / admin only). */
app.post('/tickets/:id/close', (req, res) => {
  const t = loadTicket(req, res); if (!t) return;
  const allowed = req.user.role === 'admin' || (canActOnTicket(req.user, t) && roleInfo(req.user.role).close);
  if (!allowed) return res.redirect(`/tickets/${t.id}?err=${encodeURIComponent('إغلاق الشكوى من صلاحية مدير القطاع فقط')}`);
  const resolution = (req.body.resolution || '').trim();
  if (resolution.length < 5) return res.redirect(`/tickets/${t.id}?err=${encodeURIComponent('اكتب نتيجة الشكوى والإجراء المتخذ قبل الإغلاق')}`);
  const now = nowIso();
  db.prepare("UPDATE tickets SET status='closed', resolution=?, closed_at=?, closed_by=?, resolved_at=COALESCE(resolved_at, ?), updated_at=? WHERE id=?").run(resolution, now, req.user.id, now, now, t.id);
  db.prepare('INSERT INTO ticket_events(ticket_id,user_id,kind,text,created_at) VALUES(?,?,?,?,?)').run(t.id, req.user.id, 'closed', `أُغلقت الشكوى — النتيجة والإجراءات: ${resolution}`, now);
  notifyTicket({ ticketId: t.id, kind: 'closed', text: `أُغلقت التذكرة #${t.id} بواسطة ${req.user.full_name || req.user.username}: ${resolution.slice(0, 200)}`, actorId: req.user.id });
  res.redirect(`/tickets/${t.id}?msg=${encodeURIComponent('تم إغلاق الشكوى')}`);
});
/** Current handler closes their step -> ticket moves to the next person in the chain. */
app.post('/tickets/:id/escalate', (req, res) => {
  const t = loadTicket(req, res); if (!t) return;
  if (!canActOnTicket(req.user, t)) return res.redirect(`/tickets/${t.id}?err=${encodeURIComponent('التذكرة ليست عندك في هذه الخطوة')}`);
  const chain = chainFor(t.company_id);
  const next = chain.find((s) => s.step_no > t.step_no);
  const now = nowIso();
  const ev = db.prepare('INSERT INTO ticket_events(ticket_id,user_id,kind,text,created_at) VALUES(?,?,?,?,?)');
  if (req.body.note?.trim()) ev.run(t.id, req.user.id, 'comment', req.body.note.trim(), now);
  if (!next) {
    ev.run(t.id, req.user.id, 'status', 'وصلت التذكرة لآخر خطوة في سلسلة التصعيد', now);
    return res.redirect(`/tickets/${t.id}?err=${encodeURIComponent('أنت في آخر خطوة، أغلق الشكوى بالنتيجة والإجراءات')}`);
  }
  db.prepare("UPDATE tickets SET assigned_to=?, step_no=?, step_total=?, step_role=?, status='in_progress', updated_at=? WHERE id=?").run(next.user_id, next.step_no, Math.max(chain.length, next.step_no), next.role || null, now, t.id);
  const who = next.user_id ? (next.full_name || next.username) : `لا يوجد مستخدم بدور ${next.label}`;
  ev.run(t.id, req.user.id, 'escalate', `أُنهيت الخطوة ${t.step_no} وتم التحويل إلى الخطوة ${next.step_no}/${chain.length} (${next.label}): ${who}`, now);
  notifyTicket({ ticketId: t.id, kind: 'escalate', text: `التذكرة #${t.id} وصلت إليك (${next.label}، الخطوة ${next.step_no}/${chain.length}) من ${req.user.full_name || req.user.username}${req.body.note?.trim() ? ': ' + req.body.note.trim() : ''}`, actorId: req.user.id });
  res.redirect(`/tickets/${t.id}?msg=${encodeURIComponent('تم التصعيد للشخص التالي')}`);
});
app.post('/tickets/:id/comment', (req, res) => {
  const t = loadTicket(req, res); if (!t) return;
  if (!roleInfo(req.user.role).act) return res.redirect(`/tickets/${t.id}?err=${encodeURIComponent('دورك للمشاهدة فقط')}`);
  if ((req.body.text || '').trim()) {
    db.prepare('INSERT INTO ticket_events(ticket_id,user_id,kind,text,created_at) VALUES(?,?,?,?,?)').run(t.id, req.user.id, 'comment', req.body.text.trim(), nowIso());
    db.prepare('UPDATE tickets SET updated_at=? WHERE id=?').run(nowIso(), t.id);
    notifyTicket({ ticketId: t.id, kind: 'comment', text: `تعليق جديد من ${req.user.full_name || req.user.username} على التذكرة #${t.id}: ${req.body.text.trim().slice(0, 200)}`, actorId: req.user.id });
  }
  res.redirect(`/tickets/${t.id}`);
});
app.post('/tickets/:id/status', (req, res) => {
  const t = loadTicket(req, res); if (!t) return;
  const s = req.body.status;
  if (!TICKET_AR[s]) return res.redirect(`/tickets/${t.id}`);
  // handlers may move between open/in_progress/resolved; 'closed' goes through /close (final step + resolution text)
  if (req.user.role !== 'admin' && (!canActOnTicket(req.user, t) || s === 'closed')) return res.redirect(`/tickets/${t.id}?err=${encodeURIComponent('غير مصرح بهذا الإجراء')}`);
  const now = nowIso();
  db.prepare(`UPDATE tickets SET status=?, updated_at=?, resolved_at=CASE WHEN ?='resolved' THEN ? ELSE resolved_at END,
              closed_at=CASE WHEN ?='closed' THEN ? ELSE closed_at END, closed_by=CASE WHEN ?='closed' THEN ? ELSE closed_by END WHERE id=?`)
    .run(s, now, s, now, s, now, s, req.user.id, t.id);
  db.prepare('INSERT INTO ticket_events(ticket_id,user_id,kind,text,created_at) VALUES(?,?,?,?,?)').run(t.id, req.user.id, 'status', `تغيير الحالة إلى: ${TICKET_AR[s]}${req.body.note ? ' — ' + req.body.note : ''}`, now);
  notifyTicket({ ticketId: t.id, kind: 'status', text: `${req.user.full_name || req.user.username} غيّر حالة التذكرة #${t.id} إلى «${TICKET_AR[s]}»${req.body.note ? ' — ' + req.body.note : ''}`, actorId: req.user.id });
  res.redirect(`/tickets/${t.id}`);
});
app.post('/tickets/:id/assign', (req, res) => {
  const t = loadTicket(req, res); if (!t) return;
  const uid = Number(req.body.assigned_to) || null;
  const cid = req.body.company_id !== undefined ? (Number(req.body.company_id) || null) : t.company_id;
  db.prepare('UPDATE tickets SET assigned_to=?, company_id=?, updated_at=? WHERE id=?').run(uid, cid, nowIso(), t.id);
  const who = uid ? q.one('SELECT username FROM users WHERE id=?', uid)?.username : 'لا أحد';
  db.prepare('INSERT INTO ticket_events(ticket_id,user_id,kind,text,created_at) VALUES(?,?,?,?,?)').run(t.id, req.user.id, 'assign', `إسناد التذكرة إلى: ${who}`, nowIso());
  if (uid) notifyTicket({ ticketId: t.id, kind: 'assign', text: `${req.user.full_name || req.user.username} أسند إليك التذكرة #${t.id}`, actorId: req.user.id, onlyUserIds: [uid] });
  res.redirect(`/tickets/${t.id}`);
});

/* ------------------------------ notifications ------------------------------ */
app.get('/notifications', (req, res) => {
  const rows = q.all(`SELECT n.*, t.title, t.severity, t.status FROM notifications n LEFT JOIN tickets t ON t.id=n.ticket_id WHERE n.user_id=? ORDER BY n.id DESC LIMIT 100`, req.user.id);
  res.render('notifications', { rows });
});
app.post('/notifications/read-all', (req, res) => { db.prepare('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL').run(nowIso(), req.user.id); res.redirect('/notifications'); });
app.get('/notifications/:id/go', (req, res) => {
  const n = q.one('SELECT * FROM notifications WHERE id=? AND user_id=?', req.params.id, req.user.id);
  if (!n) return res.redirect('/notifications');
  db.prepare('UPDATE notifications SET read_at=COALESCE(read_at, ?) WHERE id=?').run(nowIso(), n.id);
  res.redirect(n.ticket_id ? `/tickets/${n.ticket_id}` : '/notifications');
});

/* ------------------------------ admin ------------------------------ */
const admin = express.Router();
// admin pages are admin-only, except the banned-words list which the quality manager also maintains
admin.use((req, res, next) => (req.path.startsWith('/banned') && roleInfo(req.user.role).banned) ? next() : requireRole('admin')(req, res, next));

admin.get('/banned', (req, res) => res.render('admin/banned', { words: q.all('SELECT * FROM banned_words ORDER BY severity DESC, category, word'), test: null }));
admin.post('/banned', (req, res) => {
  const w = (req.body.word || '').trim();
  if (w) db.prepare('INSERT OR IGNORE INTO banned_words(word,category,severity,active,created_at) VALUES(?,?,?,1,?)').run(w, (req.body.category || 'عام').trim(), req.body.severity || 'medium', nowIso());
  res.redirect('/admin/banned');
});
admin.post('/banned/import', (req, res) => {
  const lines = (req.body.bulk || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const ins = db.prepare('INSERT OR IGNORE INTO banned_words(word,category,severity,active,created_at) VALUES(?,?,?,1,?)');
  let n = 0;
  for (const l of lines) { const [word, category = 'عام', severity = 'medium'] = l.split(/[,\t|]/).map((s) => s.trim()); if (word) n += ins.run(word, category, ['low', 'medium', 'high'].includes(severity) ? severity : 'medium', nowIso()).changes; }
  res.redirect('/admin/banned?msg=' + encodeURIComponent(`تمت إضافة ${n} كلمة`));
});
admin.post('/banned/test', (req, res) => res.render('admin/banned', { words: q.all('SELECT * FROM banned_words ORDER BY severity DESC, category, word'), test: { text: req.body.text, hits: findBannedWords(req.body.text || '') } }));
admin.post('/banned/:id/toggle', (req, res) => { db.prepare('UPDATE banned_words SET active=1-active WHERE id=?').run(req.params.id); res.redirect('/admin/banned'); });
admin.post('/banned/:id/delete', (req, res) => { db.prepare('DELETE FROM banned_words WHERE id=?').run(req.params.id); res.redirect('/admin/banned'); });

admin.get('/settings', async (req, res) => {
  const servers = q.all('SELECT DISTINCT server_name FROM calls ORDER BY server_name');
  res.render('admin/settings', { settings: getSettings(), defaults: DEFAULT_SETTINGS, servers, cfg: config, companies: q.all('SELECT id,name FROM companies ORDER BY name') });
});
admin.post('/settings', (req, res) => {
  const b = req.body;
  setSetting('auto_transcribe', b.auto_transcribe === 'on');
  setSetting('ingest_only_answered', b.ingest_only_answered === 'on');
  setSetting('ticket_on_complaint', b.ticket_on_complaint === 'on');
  setSetting('min_billsec', Math.max(0, Number(b.min_billsec) || 0));
  setSetting('max_billsec', Math.max(0, Number(b.max_billsec) || 0));
  setSetting('sample_percent', Math.min(100, Math.max(0, Number(b.sample_percent) || 0)));
  setSetting('daily_cap', Math.max(0, Number(b.daily_cap) || 0));
  setSetting('allowed_servers', [].concat(b.allowed_servers || []).filter(Boolean));
  setSetting('ticket_on_banned_min_severity', ['low', 'medium', 'high'].includes(b.ticket_on_banned_min_severity) ? b.ticket_on_banned_min_severity : 'medium');
  setSetting('default_company_id', Number(b.default_company_id) || null);
  setSetting('sla_hours', { high: Math.max(1, Number(b.sla_high) || 4), medium: Math.max(1, Number(b.sla_medium) || 24), low: Math.max(1, Number(b.sla_low) || 72) });
  setSetting('role_labels', { agent: (b.role_agent || '').trim() || 'المحصل', customer: (b.role_customer || '').trim() || 'العميل' });
  if ((b.default_password || '').trim().length >= 8) setSetting('default_password', b.default_password.trim());
  setSetting('llm_only_flagged', b.llm_only_flagged === 'on');
  setSetting('llm_gate_tickets', b.llm_gate_tickets === 'on');
  if (b.llm_custom_prompt !== undefined) setSetting('llm_custom_prompt', String(b.llm_custom_prompt).slice(0, 6000));
  res.redirect('/admin/settings?msg=' + encodeURIComponent('تم حفظ القواعد'));
});
admin.post('/providers', (req, res) => {
  const b = req.body;
  const patch = {
    gateway: { base_url: b.gw_base_url, api_key_header: b.gw_header || 'X-API-Key', insecure_tls: b.gw_insecure === 'on' },
    stt: { provider: b.stt_provider, base_url: b.stt_base_url, model: b.stt_model, language: b.stt_language, custom: { url: b.stt_custom_url, text_path: b.stt_text_path || 'text' } },
    llm: { provider: b.llm_provider, model: b.llm_model, effort: b.llm_effort || 'low', base_url: b.llm_base_url },
    collector: { interval_sec: Number(b.collect_interval) || 300 },
    worker: { concurrency: Number(b.worker_conc) || 2 },
  };
  if (b.gw_api_key) patch.gateway.api_key = b.gw_api_key;
  if (b.stt_api_key) patch.stt.api_key = b.stt_api_key;
  if (b.llm_api_key) patch.llm.api_key = b.llm_api_key;
  patch.smtp = { enabled: b.smtp_enabled === 'on', host: (b.smtp_host || '').trim(), port: Number(b.smtp_port) || 25, secure: b.smtp_secure === 'on', ignore_tls: b.smtp_ignore_tls === 'on', user: (b.smtp_user || '').trim(), from: (b.smtp_from || '').trim() };
  if (b.smtp_pass) patch.smtp.pass = b.smtp_pass;
  if (b.public_url) patch.server = { public_url: b.public_url.trim() };
  saveConfigPatch(patch);
  res.redirect('/admin/settings?msg=' + encodeURIComponent('تم حفظ إعدادات المزودين (بعض التغييرات تحتاج إعادة تشغيل الخدمة)'));
});
admin.get('/health', async (req, res) => res.json({ warehouses: await probeWarehouses(), gateway: await probeGateway(), stt: sttReady(), llm: llmReady(), watermarks: q.all('SELECT * FROM sync_watermark') }));
/** Apply the current rules to calls already ingested today that are still 'new' (rules normally run at ingest time). */
admin.post('/apply-rules', (req, res) => {
  const settings = getSettings();
  if (!settings.auto_transcribe) return res.redirect('/admin/settings?err=' + encodeURIComponent('فعّل التحويل التلقائي أولاً ثم احفظ'));
  const rows = q.all("SELECT * FROM calls WHERE status='new' AND date(calldate)=date('now','localtime') ORDER BY calldate DESC");
  let n = 0;
  const upd = db.prepare("UPDATE calls SET status='queued', skip_reason=NULL, queued_at=? WHERE id=?");
  const bump = db.prepare(`INSERT INTO usage_log(day,kind,count,seconds) VALUES(?,?,1,0) ON CONFLICT(day,kind) DO UPDATE SET count=count+1`);
  for (const c of rows) {
    const r = evaluateRules(c, settings);
    if (!r.queue) { if (r.reason === 'daily_cap') break; continue; }
    upd.run(nowIso(), c.id); bump.run(nowIso().slice(0, 10), 'auto_queued'); n++;
  }
  queueCall(-1); // no-op update, just wakes the worker
  res.redirect('/admin/settings?msg=' + encodeURIComponent(`تمت إضافة ${n} مكالمة من اليوم لقائمة التحويل`));
});
/** Re-run the analysis (with the LLM) on today's calls that tripped banned words - fixes tickets opened before the LLM was configured. */
admin.post('/reanalyze-flagged', async (req, res) => {
  if (!llmReady()) return res.redirect('/admin/settings?err=' + encodeURIComponent('اضبط مزود الـ AI أولاً'));
  const rows = q.all(`SELECT c.id FROM calls c JOIN analyses a ON a.call_id=c.id WHERE a.banned_hits <> '[]' AND date(c.calldate)=date('now','localtime') ORDER BY c.id DESC LIMIT 500`);
  res.redirect('/admin/settings?msg=' + encodeURIComponent(`بدأت إعادة تحليل ${rows.length} مكالمة بالـ AI في الخلفية، تابع النتيجة في قائمة الشكاوى`));
  (async () => { for (const r of rows) { try { await analyzeCall(r.id, { forceLLM: true }); } catch (e) { console.error('reanalyze', r.id, e.message); } } console.log(`[admin] reanalyzed ${rows.length} flagged calls`); })();
});
/** Re-judge every open auto ticket nobody has touched with the current AI criteria; clean ones get auto-closed. */
admin.post('/review-open-tickets', async (req, res) => {
  if (!llmReady()) return res.redirect('/admin/settings?err=' + encodeURIComponent('اضبط مزود الـ AI أولاً'));
  const rows = q.all(`SELECT t.call_id FROM tickets t WHERE t.source='auto' AND t.status IN ('open','in_progress')
                      AND NOT EXISTS (SELECT 1 FROM ticket_events e WHERE e.ticket_id=t.id AND e.user_id IS NOT NULL AND e.kind IN ('comment','escalate','status','assign','closed'))
                      AND EXISTS (SELECT 1 FROM transcripts tr WHERE tr.call_id=t.call_id) ORDER BY t.id DESC LIMIT 2000`);
  res.redirect('/admin/settings?msg=' + encodeURIComponent(`بدأت مراجعة ${rows.length} تذكرة مفتوحة بالـ AI في الخلفية؛ اللي مالهاش لازمة هتتقفل تلقائياً`));
  (async () => {
    let closed = 0;
    for (const r of rows) { try { const before = q.one("SELECT COUNT(*) c FROM tickets WHERE call_id=? AND status='closed'", r.call_id).c; await analyzeCall(r.call_id, { forceLLM: true }); if (q.one("SELECT COUNT(*) c FROM tickets WHERE call_id=? AND status='closed'", r.call_id).c > before) closed++; } catch (e) { console.error('review', r.call_id, e.message); } }
    console.log(`[admin] reviewed ${rows.length} open tickets, auto-closed ${closed}`);
  })();
});
admin.post('/collect-now', async (req, res) => { const r = await collectAll(); res.redirect('/admin/settings?msg=' + encodeURIComponent('نتيجة السحب: ' + JSON.stringify(r))); });

admin.get('/companies', (req, res) => {
  const companies = q.all(`SELECT c.*, (SELECT COUNT(*) FROM tickets t WHERE t.company_id=c.id AND t.status IN ('open','in_progress')) open_tickets FROM companies c ORDER BY c.name`);
  for (const c of companies) {
    c.members = q.all('SELECT u.id, u.username, u.full_name FROM company_members m JOIN users u ON u.id=m.user_id WHERE m.company_id=?', c.id);
    c.chain = q.all('SELECT s.step_no, s.user_id FROM escalation_steps s WHERE s.company_id=? ORDER BY s.step_no', c.id);
  }
  const defaultChain = q.all('SELECT s.step_no, s.user_id FROM escalation_steps s WHERE s.company_id=0 ORDER BY s.step_no');
  res.render('admin/companies', { companies, defaultChain, users: q.all('SELECT id, username, full_name, role FROM users WHERE active=1 ORDER BY username') });
});
/** Save the ordered escalation chain (company id 0 = default chain). */
admin.post('/companies/:id/chain', (req, res) => {
  const cid = Number(req.params.id) || 0;
  const ids = [].concat(req.body.user_ids || []).flatMap((v) => String(v).split(',')).map(Number).filter(Boolean);
  const uniq = [...new Set(ids)];
  db.prepare('DELETE FROM escalation_steps WHERE company_id=?').run(cid);
  const ins = db.prepare('INSERT INTO escalation_steps(company_id, step_no, user_id) VALUES(?,?,?)');
  uniq.forEach((u, i) => ins.run(cid, i + 1, u));
  res.redirect('/admin/companies?msg=' + encodeURIComponent(`تم حفظ سلسلة التصعيد (${uniq.length} خطوة)`));
});
admin.post('/companies', (req, res) => { if ((req.body.name || '').trim()) db.prepare('INSERT OR IGNORE INTO companies(name,notes,active,created_at) VALUES(?,?,1,?)').run(req.body.name.trim(), req.body.notes || null, nowIso()); res.redirect('/admin/companies'); });
admin.post('/companies/:id/members', (req, res) => {
  const ids = [].concat(req.body.user_ids || []).map(Number).filter(Boolean);
  db.prepare('DELETE FROM company_members WHERE company_id=?').run(req.params.id);
  const ins = db.prepare('INSERT OR IGNORE INTO company_members(company_id,user_id) VALUES(?,?)');
  for (const u of ids) ins.run(req.params.id, u);
  res.redirect('/admin/companies?msg=' + encodeURIComponent('تم تحديث المسؤولين'));
});
admin.post('/companies/:id/delete', (req, res) => { db.prepare('DELETE FROM companies WHERE id=?').run(req.params.id); res.redirect('/admin/companies'); });

admin.get('/servers', async (req, res) => {
  const known = q.all('SELECT warehouse, server_name, COUNT(*) calls FROM calls GROUP BY warehouse, server_name ORDER BY warehouse, server_name');
  const map = Object.fromEntries(q.all('SELECT * FROM server_map').map((r) => [r.server_name, r]));
  let branches = []; try { branches = (await probeGateway()).branches || []; } catch {}
  res.render('admin/servers', { known, map, branches, companies: q.all('SELECT id,name FROM companies ORDER BY name') });
});
admin.post('/servers', (req, res) => {
  const names = [].concat(req.body.server_name || []);
  const branch = [].concat(req.body.gateway_branch || []), comp = [].concat(req.body.company_id || []), label = [].concat(req.body.label || []);
  const up = db.prepare('INSERT INTO server_map(server_name,gateway_branch,company_id,label) VALUES(?,?,?,?) ON CONFLICT(server_name) DO UPDATE SET gateway_branch=excluded.gateway_branch, company_id=excluded.company_id, label=excluded.label');
  names.forEach((n, i) => up.run(n, (branch[i] || '').trim() || null, Number(comp[i]) || null, (label[i] || '').trim() || null));
  res.redirect('/admin/servers?msg=' + encodeURIComponent('تم الحفظ'));
});

admin.get('/extensions', (req, res) => {
  const rows = q.all('SELECT e.*, c.name company_name FROM extensions e LEFT JOIN companies c ON c.id=e.company_id ORDER BY e.ext');
  const seen = q.all(`SELECT agent_ext ext, MAX(agent_name) agent_name, server_name, COUNT(*) calls FROM calls WHERE agent_ext IS NOT NULL AND calldate >= date('now','-30 days')
                      AND NOT EXISTS (SELECT 1 FROM extensions e WHERE e.ext=calls.agent_ext) GROUP BY agent_ext, server_name ORDER BY calls DESC LIMIT 200`);
  res.render('admin/extensions', { rows, seen, companies: q.all('SELECT id,name FROM companies ORDER BY name') });
});
admin.post('/extensions', (req, res) => {
  const up = db.prepare('INSERT INTO extensions(ext,server_name,agent_name,company_id,department) VALUES(?,?,?,?,?) ON CONFLICT(ext,server_name) DO UPDATE SET agent_name=excluded.agent_name, company_id=excluded.company_id, department=excluded.department');
  if (req.body.bulk) {
    let n = 0;
    for (const l of req.body.bulk.split(/\r?\n/)) {
      const [ext, agent_name = '', company = '', department = '', server = '*'] = l.split(/[,\t;]/).map((s) => s.trim());
      if (!ext) continue;
      let cid = Number(company) || q.one('SELECT id FROM companies WHERE name=?', company)?.id || null;
      if (!cid && company) { cid = Number(db.prepare('INSERT INTO companies(name,active,created_at) VALUES(?,1,?)').run(company, nowIso()).lastInsertRowid); }
      up.run(ext, server || '*', agent_name || null, cid, department || null); n++;
    }
    return res.redirect('/admin/extensions?msg=' + encodeURIComponent(`تم استيراد ${n} تحويلة`));
  }
  if ((req.body.ext || '').trim()) up.run(req.body.ext.trim(), (req.body.server_name || '*').trim() || '*', req.body.agent_name || null, Number(req.body.company_id) || null, req.body.department || null);
  res.redirect('/admin/extensions');
});
admin.post('/extensions/delete', (req, res) => { db.prepare('DELETE FROM extensions WHERE ext=? AND server_name=?').run(req.body.ext, req.body.server_name); res.redirect('/admin/extensions'); });

admin.get('/users', (req, res) => res.render('admin/users', { users: q.all(`SELECT u.*, (SELECT GROUP_CONCAT(c.name, '، ') FROM company_members m JOIN companies c ON c.id=m.company_id WHERE m.user_id=u.id) companies FROM users u ORDER BY u.username`).map((u) => ({ ...u, role: normalizeRole(u.role), company_ids: q.all('SELECT company_id FROM company_members WHERE user_id=?', u.id).map((r) => r.company_id) })),
  allCompanies: q.all('SELECT id, name FROM companies WHERE active=1 ORDER BY name'), tempPassword: req.query.tmp || null, defaultPassword: getSettings().default_password || 'Maharah@123' }));
admin.post('/users', (req, res) => {
  const u = (req.body.username || '').trim(); if (!u) return res.redirect('/admin/users');
  const tmp = getSettings().default_password || 'Maharah@123';
  let newId;
  try { newId = db.prepare('INSERT INTO users(username,password_hash,full_name,email,role,active,must_change_password,created_at) VALUES(?,?,?,?,?,1,1,?)').run(u, hashPassword(tmp), req.body.full_name || null, (req.body.email || '').trim() || null, ROLES[req.body.role] ? req.body.role : 'project_manager', nowIso()).lastInsertRowid; }
  catch { return res.redirect('/admin/users?err=' + encodeURIComponent('اسم المستخدم موجود بالفعل')); }
  const cids = [].concat(req.body.company_ids || []).map(Number).filter(Boolean);
  const insM = db.prepare('INSERT OR IGNORE INTO company_members(company_id,user_id) VALUES(?,?)');
  for (const c of cids) insM.run(c, newId);
  res.redirect(`/admin/users?tmp=${encodeURIComponent(u + ' / ' + tmp)}`);
});
/** Which companies a user is responsible for (quality specialist / project manager). */
admin.post('/users/:id/companies', (req, res) => {
  const cids = [].concat(req.body.company_ids || []).map(Number).filter(Boolean);
  db.prepare('DELETE FROM company_members WHERE user_id=?').run(req.params.id);
  const insM = db.prepare('INSERT OR IGNORE INTO company_members(company_id,user_id) VALUES(?,?)');
  for (const c of cids) insM.run(c, req.params.id);
  res.redirect('/admin/users?msg=' + encodeURIComponent('تم تحديث شركات المستخدم'));
});
admin.post('/users/:id/email', (req, res) => { db.prepare('UPDATE users SET email=?, full_name=COALESCE(NULLIF(?, \'\'), full_name) WHERE id=?').run((req.body.email || '').trim() || null, (req.body.full_name || '').trim(), req.params.id); res.redirect('/admin/users?msg=' + encodeURIComponent('تم الحفظ')); });
admin.post('/companies/:id/emails', (req, res) => { db.prepare('UPDATE companies SET notify_emails=? WHERE id=?').run((req.body.notify_emails || '').trim() || null, req.params.id); res.redirect('/admin/companies?msg=' + encodeURIComponent('تم حفظ إيميلات الإشعار')); });
admin.post('/test-mail', async (req, res) => {
  try {
    const to = (req.body.to || req.user.email || '').trim();
    if (!to) return res.redirect('/admin/settings?err=' + encodeURIComponent('اكتب إيميلاً للاختبار'));
    const r = await sendMail({ to, subject: '[جودة المكالمات] رسالة اختبار', text: 'إعدادات SMTP تعمل بشكل صحيح.', html: '<div dir="rtl">✅ إعدادات SMTP تعمل بشكل صحيح.</div>' });
    res.redirect('/admin/settings?msg=' + encodeURIComponent('تم إرسال رسالة الاختبار إلى ' + to + (r.messageId ? '' : ' (بدون معرف)')));
  } catch (e) { res.redirect('/admin/settings?err=' + encodeURIComponent('فشل الإرسال: ' + e.message)); }
});
admin.post('/users/:id/reset', (req, res) => { const tmp = getSettings().default_password || 'Maharah@123'; db.prepare('UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?').run(hashPassword(tmp), req.params.id); const u = q.one('SELECT username FROM users WHERE id=?', req.params.id); res.redirect(`/admin/users?tmp=${encodeURIComponent(u.username + ' / ' + tmp)}`); });
admin.post('/users/:id/toggle', (req, res) => { if (Number(req.params.id) !== req.user.id) db.prepare('UPDATE users SET active=1-active WHERE id=?').run(req.params.id); res.redirect('/admin/users'); });
admin.post('/users/:id/role', (req, res) => { if (Number(req.params.id) !== req.user.id && ROLES[req.body.role]) db.prepare('UPDATE users SET role=? WHERE id=?').run(req.body.role, req.params.id); res.redirect('/admin/users'); });
admin.post('/users/:id/delete', (req, res) => { if (Number(req.params.id) !== req.user.id) db.prepare('DELETE FROM users WHERE id=?').run(req.params.id); res.redirect('/admin/users'); });
app.use('/admin', admin);

/* ------------------------------ errors ------------------------------ */
app.use((req, res) => res.status(404).render('error', { title: '404', message: 'الصفحة غير موجودة' }));
app.use((err, req, res, _next) => { console.error(err); res.status(500).render('error', { title: 'خطأ', message: err.message }); });

/* ------------------------------ boot ------------------------------ */
seedDefaults(); ensureAdmin();
const port = config.server.port || 8090;
const tls = loadTls();
const startBackground = () => {
  console.log(`providers: gateway_key=${!!config.gateway.api_key} stt=${config.stt.provider}(${sttReady() ? 'ready' : 'not ready'}) llm=${config.llm.provider}(${llmReady() ? 'ready' : 'keywords only'})`);
  if (config.collector.enabled && process.env.NO_COLLECTOR !== '1') runCollectorLoop();
  if (config.worker.enabled && process.env.NO_WORKER !== '1') runWorkerLoop();
};
if (tls) {
  const httpsPort = config.server.https.port || 8443;
  https.createServer({ key: tls.key, cert: tls.cert }, app).listen(httpsPort, () => {
    console.log(`Call Quality Platform listening on https://0.0.0.0:${httpsPort}`);
    startBackground();
  });
  // plain HTTP just redirects to HTTPS (same host, https port)
  http.createServer((req, res) => {
    const host = (req.headers.host || 'localhost').replace(/:\d+$/, '');
    res.writeHead(301, { Location: `https://${host}${httpsPort === 443 ? '' : ':' + httpsPort}${req.url}` });
    res.end();
  }).listen(port, () => console.log(`HTTP :${port} -> redirects to HTTPS :${httpsPort}`));
} else {
  app.listen(port, () => { console.log(`Call Quality Platform listening on http://0.0.0.0:${port}`); startBackground(); });
}
