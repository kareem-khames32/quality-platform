/**
 * Notifications: in-app (notifications table, bell in the nav) + e-mail via the company's local SMTP (Outlook/Exchange).
 * Recipients are resolved from the ticket: current assignee, escalation chain, company viewers, extra company e-mails.
 */
import nodemailer from 'nodemailer';
import { config } from './config.js';
import { db, q } from './db.js';
import { nowIso } from './util.js';
import { ROLES } from './auth.js';

const log = (...a) => console.log(new Date().toISOString(), '[notify]', ...a);

let _transport = null, _sig = '';
function transport() {
  const s = config.smtp || {};
  if (!s.enabled || !s.host) return null;
  const sig = JSON.stringify([s.host, s.port, s.secure, s.user, s.pass, s.ignore_tls]);
  if (_transport && sig === _sig) return _transport;
  _sig = sig;
  _transport = nodemailer.createTransport({
    host: s.host, port: Number(s.port) || 25, secure: !!s.secure,
    auth: s.user ? { user: s.user, pass: s.pass } : undefined,
    tls: { rejectUnauthorized: false },   // internal Exchange usually has a self-signed cert
    ignoreTLS: !!s.ignore_tls,
    connectionTimeout: 10000,
  });
  return _transport;
}
export function smtpReady() { return !!transport(); }

export async function sendMail({ to, subject, html, text }) {
  const t = transport();
  if (!t) throw new Error('SMTP is not configured');
  const list = [].concat(to).filter(Boolean);
  if (!list.length) return { skipped: true };
  const info = await t.sendMail({ from: config.smtp.from || config.smtp.user, to: list.join(', '), subject, html, text });
  return { messageId: info.messageId, accepted: info.accepted };
}

/**
 * Who hears about a ticket event:
 *  - created  : the people at the current step + everyone with a view-only duty (operations for all companies,
 *               the company's project managers) + quality managers
 *  - escalate : the people at the (new) current step
 *  - assign   : the assignee (caller passes onlyUserIds)
 *  - comment/status/closed : current assignee + everyone who already acted on the ticket + quality managers
 */
export function ticketAudience(ticket, kind = 'created') {
  const users = new Map();
  const add = (u) => { if (u && u.active !== 0) users.set(u.id, u); };
  const byRole = (role) => q.all('SELECT id, username, full_name, email, active FROM users WHERE role=? AND active=1', role);
  const byRoleInCompany = (role) => ticket.company_id
    ? q.all('SELECT u.id, u.username, u.full_name, u.email, u.active FROM company_members m JOIN users u ON u.id=m.user_id WHERE m.company_id=? AND u.role=? AND u.active=1', ticket.company_id, role) : [];
  const stepPeople = () => {
    if (ticket.assigned_to) add(q.one('SELECT id, username, full_name, email, active FROM users WHERE id=?', ticket.assigned_to));
    if (ticket.step_role) for (const u of (ROLES[ticket.step_role]?.scoped ? byRoleInCompany(ticket.step_role) : byRole(ticket.step_role))) add(u);
  };
  if (kind === 'created') {
    stepPeople();
    for (const u of byRole('operations')) add(u);
    for (const u of byRoleInCompany('project_manager')) add(u);
    for (const u of byRole('quality_manager')) add(u);
  } else if (kind === 'escalate' || kind === 'assign') {
    stepPeople();
  } else {
    stepPeople();
    for (const u of q.all('SELECT DISTINCT u.id, u.username, u.full_name, u.email, u.active FROM ticket_events e JOIN users u ON u.id=e.user_id WHERE e.ticket_id=?', ticket.id)) add(u);
    for (const u of byRole('quality_manager')) add(u);
    if (kind === 'closed') { for (const u of byRole('operations')) add(u); for (const u of byRoleInCompany('project_manager')) add(u); }
  }
  if (!users.size) for (const u of byRole('admin')) add(u);
  const extra = ticket.company_id ? (q.one('SELECT notify_emails FROM companies WHERE id=?', ticket.company_id)?.notify_emails || '') : '';
  const extraEmails = kind === 'created' || kind === 'closed' ? extra.split(/[,;\s]+/).map((s) => s.trim()).filter((s) => s.includes('@')) : [];
  return { users: [...users.values()], extraEmails };
}

function ticketMail(ticket, call, kind, text) {
  const base = (config.server.public_url || `http://localhost:${config.server.port || 8090}`).replace(/\/$/, '');
  const url = `${base}/tickets/${ticket.id}`;
  const sev = { high: 'تدخل فوري', medium: 'متوسطة', low: 'منخفضة' }[ticket.severity] || ticket.severity;
  const subject = `[جودة المكالمات] تذكرة #${ticket.id} — ${ticket.title} (${sev})`;
  const html = `<div dir="rtl" style="font-family:Tahoma,Arial;line-height:1.8;color:#1e293b">
    <h3 style="margin:0 0 .5rem">🎫 تذكرة #${ticket.id}: ${esc(ticket.title)}</h3>
    <p style="background:#f1f5f9;padding:.5rem .8rem;border-radius:8px">${esc(text)}</p>
    <table style="border-collapse:collapse">
      <tr><td style="color:#64748b;padding:.2rem .8rem">الخطورة</td><td>${sev}</td></tr>
      <tr><td style="color:#64748b;padding:.2rem .8rem">الموظف</td><td>${esc(ticket.agent_name || '')} (${esc(ticket.agent_ext || '')})</td></tr>
      ${call ? `<tr><td style="color:#64748b;padding:.2rem .8rem">رقم العميل</td><td dir="ltr">${esc(call.phone || '')}</td></tr>
      <tr><td style="color:#64748b;padding:.2rem .8rem">تاريخ المكالمة</td><td dir="ltr">${esc(call.calldate)}</td></tr>
      <tr><td style="color:#64748b;padding:.2rem .8rem">السنترال</td><td>${esc(call.server_name)}</td></tr>` : ''}
      <tr><td style="color:#64748b;padding:.2rem .8rem">الخطوة</td><td>${ticket.step_no}/${ticket.step_total}</td></tr>
    </table>
    ${ticket.description ? `<p style="white-space:pre-wrap;color:#475569">${esc(ticket.description)}</p>` : ''}
    <p><a href="${url}" style="background:#28316e;color:#fff;padding:.5rem 1rem;border-radius:8px;text-decoration:none">افتح التذكرة</a></p>
    <p style="color:#94a3b8;font-size:.8rem">رسالة آلية من منصة جودة المكالمات — ${kind}</p></div>`;
  return { subject, html, text: `${subject}\n${text}\n${url}` };
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Record an in-app notification for each recipient and e-mail those who have an address.
 * @param {object} p  { ticketId, kind, text, actorId (excluded), onlyUserIds (optional override) }
 */
export function notifyTicket({ ticketId, kind, text, actorId = null, onlyUserIds = null }) {
  const ticket = q.one('SELECT * FROM tickets WHERE id=?', ticketId);
  if (!ticket) return;
  const call = q.one('SELECT * FROM calls WHERE id=?', ticket.call_id);
  const { users, extraEmails } = ticketAudience(ticket, kind);
  const targets = users.filter((u) => u.id !== actorId && (!onlyUserIds || onlyUserIds.includes(u.id)));
  const ins = db.prepare('INSERT INTO notifications(user_id,ticket_id,kind,text,created_at) VALUES(?,?,?,?,?)');
  for (const u of targets) ins.run(u.id, ticketId, kind, text, nowIso());

  const emails = [...new Set([...targets.map((u) => u.email).filter((e) => e && e.includes('@')), ...(onlyUserIds ? [] : extraEmails)])];
  if (emails.length && smtpReady()) {
    const m = ticketMail(ticket, call, kind, text);
    sendMail({ to: emails, ...m })
      .then((r) => { log(`ticket #${ticketId} ${kind}: mailed ${emails.length} (${r.messageId || 'ok'})`); db.prepare('UPDATE notifications SET emailed=1 WHERE ticket_id=? AND kind=? AND created_at>=?').run(ticketId, kind, nowIso().slice(0, 16)); })
      .catch((e) => log(`ticket #${ticketId} mail failed: ${e.message}`));
  }
  return targets.length;
}

export function unreadCount(userId) { return q.one('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read_at IS NULL', userId)?.c || 0; }
