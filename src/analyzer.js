/**
 * Analyzer: banned-word matching + (optional) LLM classification -> analysis row + auto ticket.
 */
import { db, q, getSettings } from './db.js';
import { analyzeWithLLM, llmReady } from './llm/index.js';
import { normalizeArabic, escapeRegex, nowIso } from './util.js';
import { formatTranscript } from './roles.js';
import { notifyTicket } from './notify.js';
import { ROLES, ROLE_ORDER, normalizeRole } from './auth.js';

const SEV = { low: 1, medium: 2, high: 3 };
const log = (...a) => console.log(new Date().toISOString(), '[analyzer]', ...a);

export function findBannedWords(text) {
  const words = q.all('SELECT id, word, category, severity FROM banned_words WHERE active=1');
  const norm = normalizeArabic(text);
  const hits = [];
  for (const w of words) {
    const nw = normalizeArabic(w.word).trim();
    if (!nw) continue;
    // single short words match on word boundaries (so "سمة" doesn't fire inside "قسمة"); phrases match as substrings
    const single = !nw.includes(' ');
    // very short words (سمة، ملم) get no prefix/suffix tolerance at all, otherwise "بسمة" would fire
    const affixes = nw.length > 3;
    const re = single
      ? new RegExp(`(?<![\\p{L}\\p{N}])${affixes ? '(?:ال|و|ب|ف|ل|لل)?' : ''}${escapeRegex(nw)}${affixes ? '(?:ك|كم|ه|ها|ي|نا|ين|ات|ون|وني|ني)?' : ''}(?![\\p{L}\\p{N}])`, 'gu')
      : new RegExp(escapeRegex(nw), 'g');
    let m, count = 0, context = null;
    while ((m = re.exec(norm)) && count < 50) {
      count++;
      if (!context) {
        const s = Math.max(0, m.index - 40), e = Math.min(norm.length, m.index + nw.length + 40);
        context = (s > 0 ? '…' : '') + norm.slice(s, e) + (e < norm.length ? '…' : '');
      }
    }
    if (count) hits.push({ id: w.id, word: w.word, category: w.category, severity: w.severity, count, context });
  }
  hits.sort((a, b) => SEV[b.severity] - SEV[a.severity] || b.count - a.count);
  return hits;
}

/** Which company owns this call? extension map (exact server, then wildcard) -> server_map -> default. */
export function companyForCall(call, settings) {
  const e = q.one(`SELECT company_id FROM extensions WHERE ext=? AND server_name IN (?, '*') ORDER BY CASE WHEN server_name='*' THEN 1 ELSE 0 END LIMIT 1`, call.agent_ext || '', call.server_name);
  if (e?.company_id) return e.company_id;
  const s = q.one('SELECT company_id FROM server_map WHERE server_name=?', call.server_name);
  if (s?.company_id) return s.company_id;
  return settings.default_company_id || null;
}

export function agentNameForCall(call) {
  if (call.agent_name) return call.agent_name;
  const e = q.one(`SELECT agent_name FROM extensions WHERE ext=? AND server_name IN (?, '*') ORDER BY CASE WHEN server_name='*' THEN 1 ELSE 0 END LIMIT 1`, call.agent_ext || '', call.server_name);
  return e?.agent_name || null;
}

/**
 * Escalation chain for a company. Two sources:
 *  1) an explicit per-person chain saved by the admin (escalation_steps, company_id or 0 = default) - used if present;
 *  2) otherwise the role chain from settings (أخصائي جودة ← مدير الجودة ← عناية العملاء ← مدير القطاع):
 *     for company-scoped roles the candidates are the company's members with that role, for the others every active user with that role.
 * Each step: { step_no, role, label, user_id (first candidate or null), username, full_name, candidates: [...] }
 */
export function chainFor(companyId) {
  const personal = companyId ? q.all('SELECT s.step_no, s.user_id, u.username, u.full_name, u.role FROM escalation_steps s JOIN users u ON u.id=s.user_id WHERE s.company_id=? AND u.active=1 ORDER BY s.step_no', companyId) : [];
  const fallback = personal.length ? [] : q.all('SELECT s.step_no, s.user_id, u.username, u.full_name, u.role FROM escalation_steps s JOIN users u ON u.id=s.user_id WHERE s.company_id=0 AND u.active=1 ORDER BY s.step_no');
  const explicit = personal.length ? personal : fallback;
  if (explicit.length) return explicit.map((s, i) => ({ step_no: i + 1, role: normalizeRole(s.role), label: s.full_name || s.username, user_id: s.user_id, username: s.username, full_name: s.full_name, candidates: [{ id: s.user_id, username: s.username, full_name: s.full_name }] }));

  const roles = getSettings().chain_roles || ROLE_ORDER;
  return roles.map((role, i) => {
    const scoped = ROLES[role]?.scoped;
    const cands = scoped && companyId
      ? q.all('SELECT u.id, u.username, u.full_name, u.email FROM users u JOIN company_members m ON m.user_id=u.id WHERE m.company_id=? AND u.role=? AND u.active=1 ORDER BY u.id', companyId, role)
      : q.all('SELECT id, username, full_name, email FROM users WHERE role=? AND active=1 ORDER BY id', role);
    const first = cands[0] || null;
    return { step_no: i + 1, role, label: ROLES[role]?.label || role, user_id: first?.id || null, username: first?.username, full_name: first?.full_name, candidates: cands };
  });
}

export function dueAt(severity, settings, from = new Date()) {
  const h = Number(settings?.sla_hours?.[severity] ?? { high: 4, medium: 24, low: 72 }[severity] ?? 24);
  const d = new Date(from.getTime() + h * 3600e3);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function openTicket({ call, companyId, severity, title, description, source = 'auto', userId = null }) {
  const existing = q.one("SELECT id FROM tickets WHERE call_id=? AND status IN ('open','in_progress')", call.id);
  if (existing) return existing.id;
  const now = nowIso();
  const settings = getSettings();
  const chain = chainFor(companyId);
  // a quality specialist opening the ticket manually has already done step 1 -> start at step 2
  const openerRole = userId ? normalizeRole(q.one('SELECT role FROM users WHERE id=?', userId)?.role) : null;
  let startIdx = 0;
  if (openerRole && chain[0]?.role === openerRole) startIdx = Math.min(1, chain.length - 1);
  const first = chain[startIdx] || null;
  const r = db.prepare(`INSERT INTO tickets(call_id, company_id, status, severity, title, description, agent_ext, agent_name, source, created_by, assigned_to, step_no, step_total, step_role, due_at, created_at, updated_at)
                        VALUES(?,?, 'open', ?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(call.id, companyId, severity, title, description, call.agent_ext, agentNameForCall(call), source, userId,
      first?.user_id || null, first?.step_no || 1, Math.max(1, chain.length), first?.role || null, dueAt(severity, settings), now, now);
  const id = Number(r.lastInsertRowid);
  const ev = db.prepare('INSERT INTO ticket_events(ticket_id,user_id,kind,text,created_at) VALUES(?,?,?,?,?)');
  ev.run(id, userId, 'created', source === 'auto' ? 'تم فتح التذكرة تلقائياً من التحليل' : 'تم فتح التذكرة يدوياً', now);
  if (first) ev.run(id, null, 'assign', `الخطوة ${first.step_no}/${chain.length} (${first.label}): ${first.user_id ? 'أُسندت إلى ' + (first.full_name || first.username) : 'لا يوجد مستخدم بهذا الدور بعد'}`, now);
  else ev.run(id, null, 'assign', 'لا توجد سلسلة تصعيد — التذكرة بانتظار الأدمن', now);
  try { notifyTicket({ ticketId: id, kind: 'created', text: `تذكرة جديدة: ${title}${first ? ` — الخطوة الحالية: ${first.label}` : ''}`, actorId: userId }); }
  catch (e) { log(`notify failed: ${e.message}`); }
  return id;
}

export async function analyzeCall(callId, { forceLLM = false } = {}) {
  const call = q.one('SELECT * FROM calls WHERE id=?', callId);
  const tr = q.one('SELECT text, segments, speaker_map FROM transcripts WHERE call_id=?', callId);
  if (!call || !tr) throw new Error('call or transcript missing');
  const settings = getSettings();
  const bannedHits = findBannedWords(tr.text);

  // role-labelled text (المحصل / العميل) gives the LLM a much clearer picture than raw speaker ids
  let llmText = tr.text;
  try {
    const segs = JSON.parse(tr.segments || '[]'), map = JSON.parse(tr.speaker_map || '{}');
    if (segs.length && Object.keys(map).length) llmText = formatTranscript(segs, map, settings.role_labels);
  } catch {}

  let llm = null, llmErr = null;
  // cost control: by default the LLM only looks at calls that tripped the banned-word list (or an explicit re-analysis)
  const wantLLM = llmReady() && (forceLLM || !settings.llm_only_flagged || bannedHits.length > 0);
  if (wantLLM) {
    try { llm = await analyzeWithLLM({ call, transcript: llmText, bannedHits }); }
    catch (e) { llmErr = e.message; log(`LLM failed for call ${callId}: ${e.message}`); }
  }

  const topSev = bannedHits[0]?.severity || null;
  const severity = llm?.severity || topSev || 'low';
  const isComplaint = llm ? llm.is_complaint : bannedHits.some((h) => h.category === 'شكوى من العميل');
  const agentViolation = llm ? !!llm.agent_violation : false;

  const needsTicket = llm ? (llm.needs_ticket === true) : null;
  db.prepare(`INSERT INTO analyses(call_id, banned_hits, is_complaint, complaint_type, agent_violation, violation_type, needs_ticket, ticket_reason, severity, summary, sentiment, quality_score,
              employee_mentioned, company_mentioned, issues, recommendations, provider, model, raw, took_ms, created_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(call_id) DO UPDATE SET banned_hits=excluded.banned_hits, is_complaint=excluded.is_complaint, complaint_type=excluded.complaint_type,
              agent_violation=excluded.agent_violation, violation_type=excluded.violation_type, needs_ticket=excluded.needs_ticket, ticket_reason=excluded.ticket_reason,
              severity=excluded.severity, summary=excluded.summary, sentiment=excluded.sentiment, quality_score=excluded.quality_score,
              employee_mentioned=excluded.employee_mentioned, company_mentioned=excluded.company_mentioned, issues=excluded.issues,
              recommendations=excluded.recommendations, provider=excluded.provider, model=excluded.model, raw=excluded.raw, took_ms=excluded.took_ms, created_at=excluded.created_at`)
    .run(callId, JSON.stringify(bannedHits), isComplaint ? 1 : 0, llm?.complaint_type || (isComplaint ? 'other' : 'none'), agentViolation ? 1 : 0, llm?.violation_type || 'none',
      needsTicket === null ? null : (needsTicket ? 1 : 0), llm?.ticket_reason || null, severity,
      llm?.summary || (llmErr ? `(تعذر التحليل بالذكاء الاصطناعي: ${llmErr})` : null), llm?.customer_sentiment || null, llm?.quality_score ?? null,
      llm?.employee_mentioned || null, llm?.company_mentioned || null, JSON.stringify(llm?.issues || []), JSON.stringify(llm?.recommendations || []),
      llm?.provider || 'keywords_only', llm?.model || null, llm ? JSON.stringify(llm.raw) : null, llm?.took_ms || 0, nowIso());

  // ---- ticket decision ----
  // With an LLM verdict (and llm_gate_tickets on) the LLM is the judge: banned words alone do not open a ticket.
  // Without a verdict we fall back to the banned-word severity rule.
  const minSev = SEV[settings.ticket_on_banned_min_severity || 'medium'];
  const bannedTrigger = bannedHits.some((h) => SEV[h.severity] >= minSev);
  let shouldOpen, reason;
  if (llm && settings.llm_gate_tickets !== false) {
    // the LLM's explicit needs_ticket verdict is the gate; an agent violation always counts
    shouldOpen = agentViolation || needsTicket === true;
    reason = agentViolation ? 'violation' : isComplaint ? 'complaint' : 'severity';
  } else {
    shouldOpen = bannedTrigger || (settings.ticket_on_complaint && isComplaint);
    reason = isComplaint ? 'complaint' : 'banned';
  }

  let ticketId = null;
  const openAuto = q.one("SELECT id FROM tickets WHERE call_id=? AND source='auto' AND status IN ('open','in_progress')", callId);
  if (shouldOpen) {
    const companyId = companyForCall(call, settings);
    const who = agentNameForCall(call) || call.agent_ext || '-';
    const VIOL = { illegal_threat: 'تهديد غير مشروع', false_claim: 'ادعاء كاذب', insult: 'إساءة', third_party_threat: 'تهديد بالتواصل مع الغير', unprofessional: 'سلوك غير مهني', other: 'مخالفة' };
    const title = reason === 'complaint' ? `شكوى عميل على ${who}` : reason === 'violation' ? `${VIOL[llm?.violation_type] || 'مخالفة'} من ${who}` : `مكالمة تحتاج مراجعة — ${who}`;
    const desc = [
      llm?.ticket_reason && llm.ticket_reason !== 'لا يوجد' ? `سبب التذكرة: ${llm.ticket_reason}` : null,
      llm?.summary,
      llm?.issues?.length ? `ملاحظات: ${llm.issues.join('؛ ')}` : null,
      bannedHits.length ? `كلمات محظورة: ${bannedHits.map((h) => `${h.word}×${h.count}`).join('، ')}` : null,
      llm?.employee_mentioned ? `الموظف المذكور: ${llm.employee_mentioned}` : null,
      llm?.company_mentioned ? `الشركة المذكورة: ${llm.company_mentioned}` : null,
    ].filter(Boolean).join('\n');
    ticketId = openTicket({ call, companyId, severity, title, description: desc });
  } else if (llm && openAuto) {
    // a ticket was opened earlier on banned words only, nobody touched it, and the LLM now says the call is clean -> close it
    const touched = q.one("SELECT 1 FROM ticket_events WHERE ticket_id=? AND user_id IS NOT NULL AND kind IN ('comment','escalate','status','assign','closed')", openAuto.id);
    if (!touched) {
      const now = nowIso();
      const note = `أُغلقت تلقائياً: التحليل بالذكاء الاصطناعي لم يجد شكوى أو مخالفة. ${llm.summary || ''}`.trim();
      db.prepare("UPDATE tickets SET status='closed', resolution=?, closed_at=?, updated_at=? WHERE id=?").run(note, now, now, openAuto.id);
      db.prepare('INSERT INTO ticket_events(ticket_id,user_id,kind,text,created_at) VALUES(?,?,?,?,?)').run(openAuto.id, null, 'closed', note, now);
      log(`ticket #${openAuto.id} auto-closed after LLM review of call ${callId}`);
    }
  }
  db.prepare("UPDATE calls SET status='analyzed', error=NULL WHERE id=?").run(callId);
  return { bannedHits, llm, ticketId, llmErr };
}
