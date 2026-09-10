export function nowIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function toLocalStamp(d) {
  // Date -> "YYYY-MM-DD HH:MM:SS" using the wall-clock values as they came from SQL Server (no TZ shift)
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** '"nada gamal" <101975>' -> {name:"nada gamal", ext:"101975"} */
export function parseClid(clid, src) {
  if (!clid) return { name: null, ext: src || null };
  const m = String(clid).match(/^\s*"?([^"<]*?)"?\s*<?\s*([0-9*#+]+)?\s*>?\s*$/);
  if (!m) return { name: null, ext: src || null };
  const name = (m[1] || '').trim();
  const ext = (m[2] || src || '').trim();
  return { name: name && name !== ext ? name : null, ext: ext || null };
}

/** Strip trunk dial-prefixes and keep the subscriber number as the branch systems store it. */
export function normalizePhone(dst) {
  if (!dst) return '';
  const digits = String(dst).replace(/\D/g, '');
  let m = digits.match(/(0?5\d{8})$/);            // Saudi mobile 05XXXXXXXX
  if (m) return m[1].length === 9 ? '0' + m[1] : m[1];
  m = digits.match(/(01\d{9})$/);                 // Egyptian mobile 01XXXXXXXXX
  if (m) return m[1];
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/** Local "YYYY-MM-DD HH:MM:SS" stamp `ms` from now (negative = in the past) - same format as nowIso(). */
export function stampIn(ms) { return toLocalStamp(new Date(Date.now() + ms)); }

export function fmtDuration(sec) {
  sec = Number(sec) || 0;
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Arabic text normalisation for keyword matching (tashkeel, alef/yaa/taa-marbuta variants). */
export function normalizeArabic(s) {
  if (!s) return '';
  return String(s)
    .replace(/[ً-ْـ]/g, '')
    .replace(/[إأآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .toLowerCase();
}

export function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function getPath(obj, p) {
  if (!p) return undefined;
  return p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
