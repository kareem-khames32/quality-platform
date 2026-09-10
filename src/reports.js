/**
 * Reports: every query takes the same filter object { from, to, company_id, server, companies (scope) }.
 * Dates are inclusive calendar days ("YYYY-MM-DD"). Company of a call = extension mapping, else server mapping.
 */
import { q, getSettings } from './db.js';
import { ROLES } from './auth.js';

const CALL_COMPANY = 'COALESCE(e.company_id, sm.company_id)';
const CALL_JOINS = `LEFT JOIN extensions e ON e.ext=c.agent_ext AND (e.server_name=c.server_name OR e.server_name='*')
                    LEFT JOIN server_map sm ON sm.server_name=c.server_name`;

function callWhere(f) {
  const w = ['c.calldate >= ?', 'c.calldate <= ?'], p = [f.from + ' 00:00:00', f.to + ' 23:59:59'];
  if (f.server) { w.push('c.server_name=?'); p.push(f.server); }
  if (f.company_id) { w.push(`${CALL_COMPANY}=?`); p.push(f.company_id); }
  else if (f.companies?.length) { w.push(`${CALL_COMPANY} IN (${f.companies.map(() => '?').join(',')})`); p.push(...f.companies); }
  return { where: 'WHERE ' + w.join(' AND '), params: p };
}
function ticketWhere(f, alias = 't') {
  const w = [`${alias}.created_at >= ?`, `${alias}.created_at <= ?`], p = [f.from + ' 00:00:00', f.to + ' 23:59:59'];
  if (f.company_id) { w.push(`${alias}.company_id=?`); p.push(f.company_id); }
  else if (f.companies?.length) { w.push(`${alias}.company_id IN (${f.companies.map(() => '?').join(',')})`); p.push(...f.companies); }
  return { where: 'WHERE ' + w.join(' AND '), params: p };
}

export function overview(f) {
  const c = callWhere(f), t = ticketWhere(f);
  const calls = q.one(`SELECT COUNT(*) total, SUM(c.billsec>=20) over20, SUM(c.status='analyzed') analyzed,
      SUM(EXISTS(SELECT 1 FROM transcripts tr WHERE tr.call_id=c.id)) transcribed,
      SUM(CASE WHEN EXISTS(SELECT 1 FROM transcripts tr WHERE tr.call_id=c.id) THEN c.billsec ELSE 0 END)/60.0 minutes_transcribed,
      SUM(a.banned_hits IS NOT NULL AND a.banned_hits<>'[]') with_hits,
      SUM(a.provider='anthropic') llm_calls, SUM(a.is_complaint=1) complaints, SUM(a.agent_violation=1) violations,
      ROUND(AVG(a.quality_score),1) avg_score, SUM(c.status='failed') failed
      FROM calls c ${CALL_JOINS} LEFT JOIN analyses a ON a.call_id=c.id ${c.where}`, ...c.params);
  const tickets = q.one(`SELECT COUNT(*) opened, SUM(t.status='closed') closed, SUM(t.status IN ('open','in_progress')) still_open,
      SUM(t.status IN ('open','in_progress') AND t.due_at < datetime('now','localtime')) overdue,
      SUM(t.source='auto') auto_opened, SUM(t.resolution LIKE 'أُغلقت تلقائياً%') auto_closed,
      SUM(t.severity='high') high, SUM(t.severity='medium') medium, SUM(t.severity='low') low,
      ROUND(AVG(CASE WHEN t.closed_at IS NOT NULL AND t.resolution NOT LIKE 'أُغلقت تلقائياً%' THEN (julianday(t.closed_at)-julianday(t.created_at))*24 END),1) avg_close_hours
      FROM tickets t ${t.where}`, ...t.params);
  const listens = q.one(`SELECT COUNT(*) n, COUNT(DISTINCT l.user_id) users FROM listens l JOIN calls c ON c.id=l.call_id ${CALL_JOINS} ${c.where.replace('WHERE', 'WHERE l.listened_at >= ? AND l.listened_at <= ? AND')}`, f.from + ' 00:00:00', f.to + ' 23:59:59', ...c.params);
  return { calls, tickets, listens };
}

export function daily(f) {
  const c = callWhere(f), t = ticketWhere(f);
  const rows = q.all(`SELECT substr(c.calldate,1,10) d, COUNT(*) calls, SUM(c.billsec>=20) over20,
      SUM(EXISTS(SELECT 1 FROM transcripts tr WHERE tr.call_id=c.id)) transcribed,
      SUM(a.banned_hits IS NOT NULL AND a.banned_hits<>'[]') with_hits, SUM(a.agent_violation=1) violations, SUM(a.is_complaint=1) complaints,
      ROUND(AVG(a.quality_score),1) avg_score
      FROM calls c ${CALL_JOINS} LEFT JOIN analyses a ON a.call_id=c.id ${c.where} GROUP BY d ORDER BY d`, ...c.params);
  const tk = Object.fromEntries(q.all(`SELECT substr(t.created_at,1,10) d, COUNT(*) opened, SUM(t.status='closed') closed FROM tickets t ${t.where} GROUP BY d`, ...t.params).map((r) => [r.d, r]));
  for (const r of rows) { r.tickets_opened = tk[r.d]?.opened || 0; r.tickets_closed = tk[r.d]?.closed || 0; }
  return rows;
}

export function agents(f, limit = 300) {
  const c = callWhere(f);
  return q.all(`SELECT c.agent_ext ext, COALESCE(MAX(c.agent_name), MAX(e.agent_name)) name, MAX(c.server_name) server, MAX(co.name) company,
      COUNT(*) calls, SUM(c.billsec)/60 minutes, SUM(EXISTS(SELECT 1 FROM transcripts tr WHERE tr.call_id=c.id)) transcribed,
      ROUND(AVG(a.quality_score),1) avg_score, SUM(a.banned_hits IS NOT NULL AND a.banned_hits<>'[]') with_hits,
      SUM(a.agent_violation=1) violations, SUM(a.is_complaint=1) complaints,
      (SELECT COUNT(*) FROM tickets t WHERE t.agent_ext=c.agent_ext AND t.created_at BETWEEN ? AND ?) tickets,
      (SELECT COUNT(*) FROM tickets t WHERE t.agent_ext=c.agent_ext AND t.created_at BETWEEN ? AND ? AND t.status='closed' AND t.resolution NOT LIKE 'أُغلقت تلقائياً%') tickets_confirmed
      FROM calls c ${CALL_JOINS} LEFT JOIN companies co ON co.id=${CALL_COMPANY} LEFT JOIN analyses a ON a.call_id=c.id
      ${c.where} AND c.agent_ext IS NOT NULL GROUP BY c.agent_ext
      ORDER BY violations DESC, complaints DESC, with_hits DESC, calls DESC LIMIT ?`, f.from + ' 00:00:00', f.to + ' 23:59:59', f.from + ' 00:00:00', f.to + ' 23:59:59', ...c.params, limit);
}

export function companies(f) {
  const t = ticketWhere(f);
  return q.all(`SELECT COALESCE(co.name,'غير محددة') company, COUNT(*) tickets, SUM(t.status IN ('open','in_progress')) open_now,
      SUM(t.status='closed') closed, SUM(t.resolution LIKE 'أُغلقت تلقائياً%') auto_closed,
      SUM(t.status IN ('open','in_progress') AND t.due_at < datetime('now','localtime')) overdue,
      SUM(t.severity='high') high, SUM(t.severity='medium') medium, SUM(t.severity='low') low,
      ROUND(AVG(CASE WHEN t.closed_at IS NOT NULL AND t.resolution NOT LIKE 'أُغلقت تلقائياً%' THEN (julianday(t.closed_at)-julianday(t.created_at))*24 END),1) avg_close_hours
      FROM tickets t LEFT JOIN companies co ON co.id=t.company_id ${t.where} GROUP BY t.company_id ORDER BY tickets DESC`, ...t.params);
}

export function words(f) {
  const c = callWhere(f);
  return q.all(`SELECT json_extract(h.value,'$.word') word, json_extract(h.value,'$.category') category, json_extract(h.value,'$.severity') severity,
      COUNT(*) calls, SUM(json_extract(h.value,'$.count')) occurrences,
      SUM(a.agent_violation=1) confirmed_violations, SUM(a.is_complaint=1) confirmed_complaints
      FROM analyses a JOIN calls c ON c.id=a.call_id ${CALL_JOINS}, json_each(a.banned_hits) h
      ${c.where} GROUP BY word ORDER BY calls DESC LIMIT 100`, ...c.params);
}

const VIOL_AR = { none: 'لا يوجد', illegal_threat: 'تهديد غير مشروع', false_claim: 'ادعاء كاذب', insult: 'إساءة', third_party_threat: 'تهديد بالتواصل مع الغير', unprofessional: 'سلوك غير مهني', other: 'أخرى' };
const COMP_AR = { none: 'لا يوجد', debt_dispute: 'اعتراض على المديونية', call_frequency: 'كثرة الاتصالات', service: 'الخدمة', employee_behavior: 'سلوك الموظف', billing: 'الفوترة', delay: 'تأخير', worker_issue: 'مشكلة عاملة', legal_threat: 'تهديد قانوني', harassment: 'مضايقة', other: 'أخرى' };
export function breakdown(f) {
  const c = callWhere(f);
  const viol = q.all(`SELECT a.violation_type k, COUNT(*) n FROM analyses a JOIN calls c ON c.id=a.call_id ${CALL_JOINS} ${c.where} AND a.provider='anthropic' AND a.agent_violation=1 GROUP BY k ORDER BY n DESC`, ...c.params).map((r) => ({ ...r, label: VIOL_AR[r.k] || r.k }));
  const comp = q.all(`SELECT a.complaint_type k, COUNT(*) n FROM analyses a JOIN calls c ON c.id=a.call_id ${CALL_JOINS} ${c.where} AND a.provider='anthropic' AND a.is_complaint=1 GROUP BY k ORDER BY n DESC`, ...c.params).map((r) => ({ ...r, label: COMP_AR[r.k] || r.k }));
  const sent = q.all(`SELECT a.sentiment k, COUNT(*) n FROM analyses a JOIN calls c ON c.id=a.call_id ${CALL_JOINS} ${c.where} AND a.sentiment IS NOT NULL GROUP BY k`, ...c.params).map((r) => ({ ...r, label: { positive: 'إيجابي', neutral: 'محايد', negative: 'سلبي' }[r.k] || r.k }));
  const scores = q.all(`SELECT CASE WHEN a.quality_score>=80 THEN 'ممتاز (80+)' WHEN a.quality_score>=60 THEN 'جيد (60-79)' WHEN a.quality_score>=40 THEN 'ضعيف (40-59)' ELSE 'سيء (<40)' END label, COUNT(*) n
      FROM analyses a JOIN calls c ON c.id=a.call_id ${CALL_JOINS} ${c.where} AND a.quality_score IS NOT NULL GROUP BY label ORDER BY MIN(a.quality_score) DESC`, ...c.params);
  return { viol, comp, sent, scores };
}

/** Ticket lifecycle: hours spent at each step (by role order), who closed, and resolutions. */
export function lifecycle(f) {
  const t = ticketWhere(f);
  const chainRoles = getSettings().chain_roles || ['quality_specialist', 'quality_manager', 'customer_care', 'sector_manager'];
  const tickets = q.all(`SELECT t.id, t.created_at, t.closed_at, t.status, t.severity FROM tickets t ${t.where} AND t.resolution NOT LIKE 'أُغلقت تلقائياً%'`, ...t.params);
  const stepHours = chainRoles.map(() => ({ sum: 0, n: 0 }));
  for (const tk of tickets) {
    const evs = q.all("SELECT kind, created_at FROM ticket_events WHERE ticket_id=? AND kind IN ('escalate','closed') ORDER BY id", tk.id);
    let prev = new Date(tk.created_at.replace(' ', 'T')).getTime(), step = 0;
    for (const e of evs) {
      const at = new Date(e.created_at.replace(' ', 'T')).getTime();
      if (step < stepHours.length) { stepHours[step].sum += (at - prev) / 3600e3; stepHours[step].n++; }
      prev = at; step++;
    }
  }
  const steps = chainRoles.map((r, i) => ({ role: r, label: ROLES[r]?.label || r, avg_hours: stepHours[i].n ? +(stepHours[i].sum / stepHours[i].n).toFixed(1) : null, samples: stepHours[i].n }));
  const closers = q.all(`SELECT COALESCE(u.full_name,u.username,'تلقائي (AI)') who, COUNT(*) n FROM tickets t LEFT JOIN users u ON u.id=t.closed_by ${t.where} AND t.status='closed' GROUP BY t.closed_by ORDER BY n DESC`, ...t.params);
  const bySeverity = q.all(`SELECT t.severity, COUNT(*) n, SUM(t.status='closed') closed, SUM(t.status IN ('open','in_progress') AND t.due_at < datetime('now','localtime')) overdue,
      ROUND(AVG(CASE WHEN t.closed_at IS NOT NULL AND t.resolution NOT LIKE 'أُغلقت تلقائياً%' THEN (julianday(t.closed_at)-julianday(t.created_at))*24 END),1) avg_close_hours
      FROM tickets t ${t.where} GROUP BY t.severity ORDER BY CASE t.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END`, ...t.params);
  const resolutions = q.all(`SELECT t.id, t.title, t.severity, co.name company, t.resolution, t.closed_at, COALESCE(u.full_name,u.username) closed_by
      FROM tickets t LEFT JOIN companies co ON co.id=t.company_id LEFT JOIN users u ON u.id=t.closed_by ${t.where} AND t.status='closed' AND t.resolution NOT LIKE 'أُغلقت تلقائياً%' ORDER BY t.closed_at DESC LIMIT 200`, ...t.params);
  return { steps, closers, bySeverity, resolutions };
}

export function listens(f) {
  const c = callWhere(f);
  return q.all(`SELECT COALESCE(u.full_name,u.username,'—') who, u.role, COUNT(*) listens, COUNT(DISTINCT l.call_id) calls, MAX(l.listened_at) last_at
      FROM listens l LEFT JOIN users u ON u.id=l.user_id JOIN calls c ON c.id=l.call_id ${CALL_JOINS}
      ${c.where.replace('WHERE', 'WHERE l.listened_at >= ? AND l.listened_at <= ? AND')} GROUP BY l.user_id ORDER BY listens DESC`, f.from + ' 00:00:00', f.to + ' 23:59:59', ...c.params);
}

export function servers(f) {
  const c = callWhere(f);
  return q.all(`SELECT c.warehouse, c.server_name, COUNT(*) calls, SUM(c.billsec>=20) over20, SUM(EXISTS(SELECT 1 FROM transcripts tr WHERE tr.call_id=c.id)) transcribed,
      SUM(a.banned_hits IS NOT NULL AND a.banned_hits<>'[]') with_hits, SUM(a.agent_violation=1) violations, ROUND(AVG(a.quality_score),1) avg_score, SUM(c.status='failed') failed
      FROM calls c ${CALL_JOINS} LEFT JOIN analyses a ON a.call_id=c.id ${c.where} GROUP BY c.warehouse, c.server_name ORDER BY c.warehouse, c.server_name`, ...c.params);
}

/* ======================= detailed (row-level) reports ======================= */
const STATUS_AR = { new: 'جديدة', skipped: 'مستبعدة', queued: 'في الانتظار', transcribing: 'جاري التحويل', transcribed: 'تم التحويل', awaiting_ai: 'بانتظار الـ AI', analyzing: 'جاري التحليل', analyzed: 'تم التحليل', failed: 'فشلت' };
const TICKET_AR = { open: 'مفتوحة', in_progress: 'قيد المعالجة', resolved: 'تم الحل', closed: 'مغلقة' };
const SEV_AR = { high: 'عالية', medium: 'متوسطة', low: 'منخفضة' };

/** Every ticket in the period with call, agent, company, step, timings and outcome. x = extra filters {status, severity, agent, source} */
export function ticketsDetail(f, x = {}, limit = 5000) {
  const t = ticketWhere(f);
  const w = [], p = [];
  if (x.status && x.status !== 'all') { if (x.status === 'active') w.push("t.status IN ('open','in_progress')"); else { w.push('t.status=?'); p.push(x.status); } }
  if (x.severity) { w.push('t.severity=?'); p.push(x.severity); }
  if (x.agent) { w.push('(t.agent_ext=? OR t.agent_name LIKE ?)'); p.push(x.agent, `%${x.agent}%`); }
  if (x.source) { w.push('t.source=?'); p.push(x.source); }
  if (f.server) { w.push('c.server_name=?'); p.push(f.server); }
  const rows = q.all(`SELECT t.id 'رقم التذكرة', t.title 'العنوان', ${sevCase('t.severity')} 'الخطورة', ${statusCase('t.status', TICKET_AR)} 'الحالة',
      COALESCE(co.name,'غير محددة') 'الشركة', COALESCE(t.agent_name, c.agent_name, '') 'المحصل', t.agent_ext 'التحويلة', c.server_name 'السنترال',
      c.phone 'رقم العميل', c.calldate 'تاريخ المكالمة', (c.billsec/60)||':'||substr('0'||(c.billsec%60),-2) 'مدة المكالمة',
      CASE t.source WHEN 'auto' THEN 'تلقائي' ELSE 'يدوي' END 'المصدر', t.step_no||'/'||t.step_total 'الخطوة',
      COALESCE(ua.full_name, ua.username, '') 'المسؤول الحالي', t.due_at 'المهلة',
      CASE WHEN t.status IN ('open','in_progress') AND t.due_at < datetime('now','localtime') THEN 'نعم' ELSE '' END 'متأخرة',
      t.created_at 'فُتحت', t.closed_at 'أُغلقت', COALESCE(uc.full_name, uc.username, CASE WHEN t.resolution LIKE 'أُغلقت تلقائياً%' THEN 'AI' END, '') 'أغلقها',
      ROUND((julianday(COALESCE(t.closed_at, datetime('now','localtime')))-julianday(t.created_at))*24,1) 'ساعات مفتوحة',
      a.summary 'ملخص الـ AI', CASE WHEN a.is_complaint=1 THEN 'نعم' ELSE 'لا' END 'شكوى مؤكدة', CASE WHEN a.agent_violation=1 THEN 'نعم' ELSE 'لا' END 'مخالفة محصل',
      a.quality_score 'تقييم الجودة', (SELECT GROUP_CONCAT(json_extract(h.value,'$.word'), '، ') FROM json_each(COALESCE(a.banned_hits,'[]')) h) 'الكلمات المحظورة',
      t.description 'التفاصيل', t.resolution 'النتيجة والإجراء',
      (SELECT COUNT(*) FROM ticket_events e WHERE e.ticket_id=t.id AND e.kind='comment') 'عدد التعليقات'
      FROM tickets t JOIN calls c ON c.id=t.call_id LEFT JOIN companies co ON co.id=t.company_id LEFT JOIN analyses a ON a.call_id=c.id
      LEFT JOIN users ua ON ua.id=t.assigned_to LEFT JOIN users uc ON uc.id=t.closed_by
      ${t.where} ${w.length ? 'AND ' + w.join(' AND ') : ''} ORDER BY t.id DESC LIMIT ?`, ...t.params, ...p, limit);
  return rows;
}

/** Every call in the period; x = {status, agent, phone, min, hits} */
export function callsDetail(f, x = {}, limit = 5000) {
  const c = callWhere(f);
  const w = [], p = [];
  if (x.status) { w.push('c.status=?'); p.push(x.status); }
  if (x.agent) { w.push('(c.agent_ext=? OR c.agent_name LIKE ?)'); p.push(x.agent, `%${x.agent}%`); }
  if (x.phone) { w.push('c.phone LIKE ?'); p.push(`%${x.phone}%`); }
  if (x.min) { w.push('c.billsec >= ?'); p.push(Number(x.min)); }
  if (x.hits === '1') w.push("a.banned_hits IS NOT NULL AND a.banned_hits <> '[]'");
  return q.all(`SELECT c.id 'رقم المكالمة', c.calldate 'التاريخ', c.server_name 'السنترال', c.warehouse 'المستودع', COALESCE(c.agent_name, e.agent_name, '') 'المحصل', c.agent_ext 'التحويلة',
      COALESCE(co.name,'') 'الشركة', c.phone 'رقم العميل', CASE c.direction WHEN 'out' THEN 'صادرة' ELSE 'واردة' END 'الاتجاه',
      (c.billsec/60)||':'||substr('0'||(c.billsec%60),-2) 'المدة', c.billsec 'ثواني', ${statusCase('c.status', STATUS_AR)} 'الحالة', c.skip_reason 'سبب الاستبعاد', c.error 'الخطأ',
      CASE WHEN tr.call_id IS NOT NULL THEN 'نعم' ELSE 'لا' END 'محوّلة لنص',
      (SELECT GROUP_CONCAT(json_extract(h.value,'$.word'), '، ') FROM json_each(COALESCE(a.banned_hits,'[]')) h) 'الكلمات المحظورة',
      CASE a.is_complaint WHEN 1 THEN 'نعم' WHEN 0 THEN 'لا' END 'شكوى', CASE a.agent_violation WHEN 1 THEN 'نعم' WHEN 0 THEN 'لا' END 'مخالفة محصل',
      a.quality_score 'تقييم الجودة', ${sevCase('a.severity')} 'الخطورة', a.summary 'ملخص الـ AI',
      (SELECT t.id FROM tickets t WHERE t.call_id=c.id ORDER BY t.id DESC LIMIT 1) 'رقم التذكرة',
      (SELECT COUNT(*) FROM listens l WHERE l.call_id=c.id) 'مرات الاستماع',
      (SELECT GROUP_CONCAT(DISTINCT COALESCE(u.full_name,u.username)) FROM listens l LEFT JOIN users u ON u.id=l.user_id WHERE l.call_id=c.id) 'سمعها'
      FROM calls c ${CALL_JOINS} LEFT JOIN companies co ON co.id=${CALL_COMPANY} LEFT JOIN analyses a ON a.call_id=c.id LEFT JOIN transcripts tr ON tr.call_id=c.id
      ${c.where} ${w.length ? 'AND ' + w.join(' AND ') : ''} ORDER BY c.calldate DESC LIMIT ?`, ...c.params, ...p, limit);
}

/** Transcribed calls with the full role-labelled text and the analysis. */
export function transcriptsDetail(f, x = {}, limit = 2000) {
  const c = callWhere(f);
  const w = [], p = [];
  if (x.agent) { w.push('(c.agent_ext=? OR c.agent_name LIKE ?)'); p.push(x.agent, `%${x.agent}%`); }
  if (x.hits === '1') w.push("a.banned_hits IS NOT NULL AND a.banned_hits <> '[]'");
  if (x.verdict === 'complaint') w.push('a.is_complaint=1');
  if (x.verdict === 'violation') w.push('a.agent_violation=1');
  if (x.verdict === 'clean') w.push("a.provider='anthropic' AND a.is_complaint=0 AND a.agent_violation=0");
  return q.all(`SELECT c.id 'رقم المكالمة', c.calldate 'التاريخ', c.server_name 'السنترال', COALESCE(c.agent_name, e.agent_name, '') 'المحصل', c.agent_ext 'التحويلة', COALESCE(co.name,'') 'الشركة',
      c.phone 'رقم العميل', (c.billsec/60)||':'||substr('0'||(c.billsec%60),-2) 'المدة', tr.provider 'مزود التحويل', tr.created_at 'وقت التحويل',
      (SELECT GROUP_CONCAT(json_extract(h.value,'$.word'), '، ') FROM json_each(COALESCE(a.banned_hits,'[]')) h) 'الكلمات المحظورة',
      CASE a.is_complaint WHEN 1 THEN 'نعم' WHEN 0 THEN 'لا' END 'شكوى', CASE a.agent_violation WHEN 1 THEN 'نعم' WHEN 0 THEN 'لا' END 'مخالفة محصل',
      a.violation_type 'نوع المخالفة', a.quality_score 'تقييم الجودة', ${sevCase('a.severity')} 'الخطورة', a.summary 'ملخص الـ AI', a.issues 'ملاحظات', a.recommendations 'توصيات',
      (SELECT t.id FROM tickets t WHERE t.call_id=c.id ORDER BY t.id DESC LIMIT 1) 'رقم التذكرة',
      tr.text 'النص الكامل', tr.segments '_segments', tr.speaker_map '_map'
      FROM transcripts tr JOIN calls c ON c.id=tr.call_id ${CALL_JOINS} LEFT JOIN companies co ON co.id=${CALL_COMPANY} LEFT JOIN analyses a ON a.call_id=c.id
      ${c.where} ${w.length ? 'AND ' + w.join(' AND ') : ''} ORDER BY c.calldate DESC LIMIT ?`, ...c.params, ...p, limit);
}

function sevCase(col) { return `CASE ${col} WHEN 'high' THEN 'عالية' WHEN 'medium' THEN 'متوسطة' WHEN 'low' THEN 'منخفضة' ELSE ${col} END`; }
function statusCase(col, map) { return `CASE ${col} ${Object.entries(map).map(([k, v]) => `WHEN '${k}' THEN '${v}'`).join(' ')} ELSE ${col} END`; }

/** Rough spend estimate: Soniox $0.10/h, Sonnet 5 ~$0.005 per analysed call. */
export function cost(f) {
  const o = overview(f);
  const sttUsd = (o.calls.minutes_transcribed || 0) / 60 * 0.10;
  const llmUsd = (o.calls.llm_calls || 0) * 0.005;
  return { minutes: Math.round(o.calls.minutes_transcribed || 0), stt_usd: +sttUsd.toFixed(2), llm_calls: o.calls.llm_calls || 0, llm_usd: +llmUsd.toFixed(2), total_usd: +(sttUsd + llmUsd).toFixed(2) };
}

/** CSV with BOM so Excel opens Arabic correctly. */
export function toCsv(rows) {
  if (!rows?.length) return '﻿';
  const cols = Object.keys(rows[0]);
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return '﻿' + [cols.join(','), ...rows.map((r) => cols.map((k) => esc(r[k])).join(','))].join('\r\n');
}
