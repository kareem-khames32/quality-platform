/**
 * Users, password hashing (scrypt), signed session cookies, brute-force lockout, role guards.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from './config.js';
import { db, q } from './db.js';
import { nowIso } from './util.js';

const SESSION_DAYS = 7;
const COOKIE = 'cq_session';

function secret() {
  if (config.server.secret) return config.server.secret;
  const f = path.join(ROOT, 'data', '.session_secret');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const s = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, s);
  return s;
}
const SECRET = secret();

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
export function verifyPassword(pw, stored) {
  if (!stored?.startsWith('scrypt$')) return false;
  const [, salt, hash] = stored.split('$');
  const test = crypto.scryptSync(pw, salt, 64);
  const ref = Buffer.from(hash, 'hex');
  return test.length === ref.length && crypto.timingSafeEqual(test, ref);
}

function sign(v) { return v + '.' + crypto.createHmac('sha256', SECRET).update(v).digest('base64url'); }
function unsign(s) {
  if (!s) return null;
  const i = s.lastIndexOf('.');
  if (i < 0) return null;
  const v = s.slice(0, i);
  return sign(v) === s ? v : null;
}

export function ensureAdmin() {
  if (!q.one('SELECT 1 FROM users LIMIT 1')) {
    db.prepare('INSERT INTO users(username,password_hash,full_name,role,active,must_change_password,created_at) VALUES(?,?,?,?,1,1,?)')
      .run('admin', hashPassword('admin123'), 'مدير النظام', 'admin', nowIso());
    console.log('[auth] created default admin / admin123 (must change on first login)');
  }
}

export function createSession(res, userId) {
  const id = crypto.randomBytes(24).toString('base64url');
  const exp = new Date(Date.now() + SESSION_DAYS * 864e5);
  db.prepare('INSERT INTO sessions(id,user_id,created_at,expires_at) VALUES(?,?,?,?)').run(id, userId, nowIso(), exp.toISOString());
  res.cookie(COOKIE, sign(id), { httpOnly: true, sameSite: 'lax', expires: exp, secure: !!config.server.https?.enabled });
}
export function destroySession(req, res) {
  const id = unsign(req.cookies?.[COOKIE]);
  if (id) db.prepare('DELETE FROM sessions WHERE id=?').run(id);
  res.clearCookie(COOKIE);
}

/** Express middleware: attaches req.user (or null). */
export function sessionMiddleware(req, _res, next) {
  req.user = null;
  const id = unsign(req.cookies?.[COOKIE]);
  if (id) {
    const s = q.one('SELECT s.expires_at, u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND u.active=1', id);
    if (s && new Date(s.expires_at) > new Date()) {
      const { expires_at, password_hash, ...user } = s;
      user.role = normalizeRole(user.role);
      user.roleInfo = ROLES[user.role];
      user.companies = q.all('SELECT company_id FROM company_members WHERE user_id=?', user.id).map((r) => r.company_id);
      req.user = user;
    }
  }
  next();
}

export function requireLogin(req, res, next) {
  if (!req.user) return req.accepts('html') && !req.xhr ? res.redirect('/login?next=' + encodeURIComponent(req.originalUrl)) : res.status(401).json({ error: 'unauthorized' });
  if (req.user.must_change_password && !req.path.startsWith('/change-password') && !req.path.startsWith('/logout')) return res.redirect('/change-password');
  next();
}
export function requireRole(...roles) {
  return (req, res, next) => (req.user && roles.map(normalizeRole).includes(req.user.role)) ? next() : res.status(403).render('error', { title: 'غير مصرح', message: 'ليس لديك صلاحية للوصول لهذه الصفحة', user: req.user });
}
/** Middleware from a capability flag in ROLES (e.g. requireCap('calls')). */
export function requireCap(cap) {
  return (req, res, next) => (req.user && roleInfo(req.user.role)[cap]) ? next() : res.status(403).render('error', { title: 'غير مصرح', message: 'ليس لديك صلاحية للوصول لهذه الصفحة', user: req.user });
}

/* brute-force protection: 8 failures -> 15 min lock per IP */
export function checkLock(ip) {
  const r = q.one('SELECT * FROM login_attempts WHERE ip=?', ip);
  if (r?.locked_until && new Date(r.locked_until) > new Date()) return Math.ceil((new Date(r.locked_until) - Date.now()) / 60000);
  return 0;
}
export function noteFailure(ip) {
  const r = q.one('SELECT * FROM login_attempts WHERE ip=?', ip);
  const count = (r?.count || 0) + 1;
  const locked = count >= 8 ? new Date(Date.now() + 15 * 60000).toISOString() : null;
  db.prepare('INSERT INTO login_attempts(ip,count,locked_until) VALUES(?,?,?) ON CONFLICT(ip) DO UPDATE SET count=excluded.count, locked_until=excluded.locked_until').run(ip, locked ? 0 : count, locked);
}
export function clearFailures(ip) { db.prepare('DELETE FROM login_attempts WHERE ip=?').run(ip); }

/* ------------------------------------------------------------------ roles ------------------------------------------------------------------
 * calls      : can browse/listen to every call (quality team)
 * allTickets : sees every ticket regardless of company
 * act        : can take actions on a ticket at their step (comment/escalate/close); false = view only
 * scoped     : responsibility is per company (needs company_members rows)
 * close      : may close a ticket for good (final step)
 */
export const ROLES = {
  admin:              { label: 'أدمن',              calls: true,  allTickets: true,  act: true,  scoped: false, close: true,  manage: true },
  quality_specialist: { label: 'أخصائي جودة',       calls: true,  allTickets: false, act: true,  scoped: true,  close: false },
  quality_manager:    { label: 'مدير الجودة',        calls: true,  allTickets: true,  act: true,  scoped: false, close: false, banned: true },
  customer_care:      { label: 'عناية العملاء',      calls: false, allTickets: true,  act: true,  scoped: false, close: false },
  sector_manager:     { label: 'مدير القطاع',        calls: false, allTickets: true,  act: true,  scoped: false, close: true },
  operations:         { label: 'إدارة العمليات',     calls: false, allTickets: true,  act: false, scoped: false, close: false },
  project_manager:    { label: 'مدير المشروع',       calls: false, allTickets: false, act: false, scoped: true,  close: false },
};
/** Legacy role names from the first version -> new ones. */
export function normalizeRole(r) { return r === 'supervisor' ? 'quality_manager' : r === 'user' ? 'project_manager' : (ROLES[r] ? r : 'project_manager'); }
export const roleInfo = (r) => ROLES[normalizeRole(r)];
export const ROLE_ORDER = ['quality_specialist', 'quality_manager', 'customer_care', 'sector_manager'];   // default escalation path

/** Tickets visibility. allTickets roles see everything; scoped roles see their companies' tickets, plus anything assigned to / handled by them. */
export function ticketScopeSql(user) {
  if (roleInfo(user.role).allTickets) return { sql: '1=1', params: [] };
  const parts = ['t.assigned_to = ?', 'EXISTS (SELECT 1 FROM ticket_events e WHERE e.ticket_id = t.id AND e.user_id = ?)'];
  const params = [user.id, user.id];
  if (user.companies.length) { parts.push(`t.company_id IN (${user.companies.map(() => '?').join(',')})`); params.push(...user.companies); }
  return { sql: `(${parts.join(' OR ')})`, params };
}

/** May this user act (comment as handler / escalate / close) on this ticket right now? */
export function canActOnTicket(user, ticket) {
  const info = roleInfo(user.role);
  if (user.role === 'admin') return true;
  if (!info.act) return false;
  if (ticket.assigned_to === user.id) return true;
  if (ticket.step_role && normalizeRole(user.role) === ticket.step_role) {
    return !info.scoped || !ticket.company_id || user.companies.includes(ticket.company_id);
  }
  return false;
}
