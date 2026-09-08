/**
 * Speaker roles: map diarized speaker ids -> 'agent' (المحصل) / 'customer' (العميل).
 * Heuristic: the agent introduces the company, asks "تسمعني", uses collection vocabulary; on outbound
 * calls the agent usually speaks first. Users can swap the roles manually (stored in transcripts.speaker_map).
 */
import { normalizeArabic } from './util.js';

const AGENT_MARKERS = [
  'معك', 'معاك', 'من شركة', 'مهاره', 'مهارة', 'وكيل تحصيل', 'تحصيل', 'شركة السعودية للطاقة', 'شركه السعوديه للطاقه',
  'تسمعني', 'بخصوص فاتورة', 'بخصوص فاتوره', 'فاتورة الكهرب', 'المبلغ المستحق', 'مسجل', 'ضمان جودة', 'ضمان جوده',
  'معايا', 'بكلمك من', 'اتصل بحضرتك', 'خدمة العملاء', 'خدمه العملاء', 'الاستاذ', 'الأستاذ', 'حضرتك', 'يا فندم', 'افندم',
  'اقدر اساعدك', 'أقدر أساعدك', 'المديونية', 'المديونيه', 'السداد', 'تسديد', 'الدفع', 'مستحق', 'عليك مبلغ',
];
const CUSTOMER_MARKERS = ['ما اسمع', 'ما أسمع', 'كلميني', 'كلمني', 'انا في', 'أنا في', 'مشغول', 'ابغى', 'أبغى', 'عايز', 'عندي', 'مالي', 'ما لي', 'وش عندك', 'ايش عندك', 'إيش عندك', 'ماني', 'ما اقدر', 'ما أقدر'];

export function assignRoles(segments, call) {
  const ids = [...new Set(segments.map((s) => s.speaker).filter((x) => x != null && x !== ''))].map(String);
  const map = {};
  if (!ids.length) return map;
  if (ids.length === 1) { map[ids[0]] = 'agent'; return map; }

  const score = {};
  for (const id of ids) score[id] = 0;
  for (const s of segments) {
    if (s.speaker == null) continue;
    const t = normalizeArabic(s.text || '');
    const id = String(s.speaker);
    for (const m of AGENT_MARKERS) if (t.includes(normalizeArabic(m))) score[id] += 2;
    for (const m of CUSTOMER_MARKERS) if (t.includes(normalizeArabic(m))) score[id] -= 1.5;
  }
  // tie-breaker: first speaker on an outbound call is usually the agent
  const first = String(segments.find((s) => s.speaker != null)?.speaker);
  if (first) score[first] += call?.direction === 'in' ? -1 : 1;

  const ranked = [...ids].sort((a, b) => score[b] - score[a]);
  map[ranked[0]] = 'agent';
  map[ranked[1]] = 'customer';
  // extra speakers (hold music, a third party) keep a generic label
  for (const id of ranked.slice(2)) map[id] = `other${id}`;
  return map;
}

/** true when a segment has real words (skips ".", "…", pure punctuation that diarization sometimes emits) */
export function hasContent(text) { return /[\p{L}\p{N}]/u.test(text || ''); }

export function swapRoles(map) {
  const out = {};
  for (const [k, v] of Object.entries(map || {})) out[k] = v === 'agent' ? 'customer' : v === 'customer' ? 'agent' : v;
  return out;
}

export function roleLabel(role, labels) {
  if (role === 'agent') return labels?.agent || 'المحصل';
  if (role === 'customer') return labels?.customer || 'العميل';
  if (typeof role === 'string' && role.startsWith('other')) return `متحدث ${role.slice(5)}`;
  return role || 'متحدث';
}

/** Build a role-labelled plain text of the call (used for the LLM prompt and for display fallbacks). */
export function formatTranscript(segments, map, labels, { withTime = false } = {}) {
  const fmt = (sec) => { sec = Math.round(sec || 0); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
  return (segments || []).filter((s) => hasContent(s.text)).map((s) => {
    const role = s.speaker != null ? (map?.[String(s.speaker)] || `other${s.speaker}`) : null;
    const who = role ? roleLabel(role, labels) : null;
    return `${withTime ? `[${fmt(s.start)}] ` : ''}${who ? who + ': ' : ''}${(s.text || '').trim()}`;
  }).filter((l) => l.trim()).join('\n');
}
