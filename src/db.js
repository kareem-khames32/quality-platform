import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { nowIso } from './util.js';

fs.mkdirSync(path.dirname(config.db.path), { recursive: true });
export const db = new DatabaseSync(config.db.path);
db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;`);

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS sync_watermark (
  warehouse TEXT PRIMARY KEY, last_id INTEGER NOT NULL DEFAULT 0, last_sync_at TEXT, last_error TEXT, last_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  warehouse TEXT NOT NULL, server_name TEXT NOT NULL, source_cdr_id INTEGER NOT NULL,
  uniqueid TEXT NOT NULL, calldate TEXT NOT NULL,
  agent_ext TEXT, agent_name TEXT, dst_raw TEXT, phone TEXT, direction TEXT,
  duration INTEGER, billsec INTEGER, disposition TEXT, dcontext TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  skip_reason TEXT, error TEXT, retries INTEGER NOT NULL DEFAULT 0,
  recording_branch TEXT, recording_path TEXT,
  queued_by INTEGER, queued_at TEXT, created_at TEXT NOT NULL,
  UNIQUE(warehouse, server_name, uniqueid)
);
CREATE INDEX IF NOT EXISTS ix_calls_calldate ON calls(calldate);
CREATE INDEX IF NOT EXISTS ix_calls_status ON calls(status);
CREATE INDEX IF NOT EXISTS ix_calls_phone ON calls(phone);
CREATE INDEX IF NOT EXISTS ix_calls_ext ON calls(agent_ext);

CREATE TABLE IF NOT EXISTS transcripts (
  call_id INTEGER PRIMARY KEY REFERENCES calls(id) ON DELETE CASCADE,
  text TEXT NOT NULL, language TEXT, segments TEXT, provider TEXT, model TEXT,
  audio_bytes INTEGER, took_ms INTEGER, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analyses (
  call_id INTEGER PRIMARY KEY REFERENCES calls(id) ON DELETE CASCADE,
  banned_hits TEXT NOT NULL DEFAULT '[]',
  is_complaint INTEGER NOT NULL DEFAULT 0, complaint_type TEXT, severity TEXT,
  summary TEXT, sentiment TEXT, quality_score INTEGER,
  employee_mentioned TEXT, company_mentioned TEXT, issues TEXT, recommendations TEXT,
  provider TEXT, model TEXT, raw TEXT, took_ms INTEGER, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS banned_words (
  id INTEGER PRIMARY KEY AUTOINCREMENT, word TEXT NOT NULL UNIQUE, category TEXT DEFAULT 'general',
  severity TEXT NOT NULL DEFAULT 'medium', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  full_name TEXT, role TEXT NOT NULL DEFAULT 'user',
  active INTEGER NOT NULL DEFAULT 1, must_change_password INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, notes TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS company_members (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (company_id, user_id)
);
CREATE TABLE IF NOT EXISTS server_map (
  server_name TEXT PRIMARY KEY, gateway_branch TEXT, company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL, label TEXT
);
CREATE TABLE IF NOT EXISTS extensions (
  ext TEXT NOT NULL, server_name TEXT NOT NULL DEFAULT '*',
  agent_name TEXT, company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL, department TEXT,
  PRIMARY KEY (ext, server_name)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, locked_until TEXT);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id INTEGER NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open',
  severity TEXT NOT NULL DEFAULT 'medium', title TEXT NOT NULL, description TEXT,
  agent_ext TEXT, agent_name TEXT, source TEXT NOT NULL DEFAULT 'auto',
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TEXT, closed_at TEXT, closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS ix_tickets_company ON tickets(company_id);

CREATE TABLE IF NOT EXISTS ticket_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, kind TEXT NOT NULL,
  text TEXT, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS listens (
  id INTEGER PRIMARY KEY AUTOINCREMENT, call_id INTEGER NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, listened_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_listens_call ON listens(call_id);

-- ordered escalation chain per company (company_id 0 = default chain)
CREATE TABLE IF NOT EXISTS escalation_steps (
  company_id INTEGER NOT NULL DEFAULT 0, step_no INTEGER NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (company_id, step_no)
);

CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1,
  seconds INTEGER NOT NULL DEFAULT 0, UNIQUE(day, kind)
);
`);

/* ---------- lightweight migrations ---------- */
function addColumn(table, col, def) {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('tickets', 'step_no', 'INTEGER NOT NULL DEFAULT 1');
addColumn('tickets', 'step_total', 'INTEGER NOT NULL DEFAULT 1');
addColumn('tickets', 'due_at', 'TEXT');
addColumn('transcripts', 'speaker_map', 'TEXT');   // {"1":"agent","2":"customer"}
addColumn('users', 'email', 'TEXT');
addColumn('calls', 'retry_after', 'TEXT');   // worker waits until this time before retrying (recording not uploaded yet)
addColumn('analyses', 'agent_violation', 'INTEGER NOT NULL DEFAULT 0');   // LLM: agent used threats / insults / false claims
addColumn('analyses', 'violation_type', 'TEXT');
addColumn('analyses', 'needs_ticket', 'INTEGER');   // LLM verdict: does this call warrant a quality ticket at all
addColumn('analyses', 'ticket_reason', 'TEXT');
addColumn('tickets', 'step_role', 'TEXT');        // role that owns the current step (quality_specialist | quality_manager | customer_care | sector_manager)
addColumn('tickets', 'resolution', 'TEXT');       // closing feedback + actions taken
addColumn('companies', 'notify_emails', 'TEXT');   // comma-separated extra recipients

db.exec(`
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticket_id INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, text TEXT NOT NULL, read_at TEXT, emailed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_notif_user ON notifications(user_id, read_at);
`);

/* ---------- settings (rules) ---------- */
export const DEFAULT_SETTINGS = {
  default_password: 'Maharah@123',   // given to every new user and on reset; must be changed at first login
  llm_only_flagged: true,            // run the LLM only on calls that hit banned words (cost control)
  llm_gate_tickets: true,            // when the LLM has judged a call, open a ticket only if it confirms a complaint or an agent violation
  llm_custom_prompt: '',             // extra business rules written by the quality team, appended to the LLM system prompt
  chain_roles: ['quality_specialist', 'quality_manager', 'customer_care', 'sector_manager'],
  role_labels: { agent: 'المحصل', customer: 'العميل' },
  sla_hours: { high: 4, medium: 24, low: 72 },   // response deadline per severity
  severity_labels: { high: 'تدخل فوري', medium: 'متوسطة', low: 'منخفضة' },
  ingest_only_answered: true,
  auto_transcribe: false,        // keep OFF until STT/LLM providers are configured
  min_billsec: 15,
  max_billsec: 0,                // 0 = no limit
  sample_percent: 100,           // % of eligible calls to transcribe automatically
  daily_cap: 2000,               // max auto-transcriptions per day (0 = unlimited)
  allowed_servers: [],           // [] = all servers
  ticket_on_banned_min_severity: 'medium',   // low | medium | high
  ticket_on_complaint: true,
  default_company_id: null,
};

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows) { try { s[r.key] = JSON.parse(r.value); } catch { s[r.key] = r.value; } }
  return s;
}
export function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
}

/* ---------- small helpers ---------- */
export const q = {
  one: (sql, ...p) => db.prepare(sql).get(...p),
  all: (sql, ...p) => db.prepare(sql).all(...p),
  run: (sql, ...p) => db.prepare(sql).run(...p),
};

export function bumpUsage(kind, seconds = 0) {
  const day = nowIso().slice(0, 10);
  db.prepare(`INSERT INTO usage_log(day,kind,count,seconds) VALUES(?,?,1,?)
              ON CONFLICT(day,kind) DO UPDATE SET count=count+1, seconds=seconds+excluded.seconds`).run(day, kind, seconds);
}
export function usageToday(kind) {
  const day = nowIso().slice(0, 10);
  return db.prepare('SELECT count FROM usage_log WHERE day=? AND kind=?').get(day, kind)?.count || 0;
}

const SEED_BANNED = [
  ['شكوى', 'شكاوى', 'high'], ['اشتكي', 'شكاوى', 'high'], ['هشتكي', 'شكاوى', 'high'], ['بشتكي', 'شكاوى', 'high'],
  ['حماية المستهلك', 'شكاوى', 'high'], ['وزارة', 'شكاوى', 'medium'], ['بلاغ', 'شكاوى', 'high'], ['محامي', 'شكاوى', 'high'],
  ['نصب', 'اتهامات', 'high'], ['نصابين', 'اتهامات', 'high'], ['احتيال', 'اتهامات', 'high'], ['سرقة', 'اتهامات', 'high'],
  ['غبي', 'إساءة', 'high'], ['حمار', 'إساءة', 'high'], ['اخرس', 'إساءة', 'high'], ['اسكت', 'إساءة', 'medium'],
  ['قليل الأدب', 'إساءة', 'high'], ['يلعن', 'إساءة', 'high'], ['زفت', 'إساءة', 'medium'],
  ['مش هرد', 'سلوك', 'medium'], ['مش شغلي', 'سلوك', 'medium'], ['براحتك', 'سلوك', 'low'], ['زي ما تحب', 'سلوك', 'low'],
];

export function seedDefaults() {
  const cnt = db.prepare('SELECT COUNT(*) c FROM banned_words').get().c;
  if (cnt === 0) {
    const ins = db.prepare('INSERT OR IGNORE INTO banned_words(word,category,severity,active,created_at) VALUES(?,?,?,1,?)');
    for (const [w, c, s] of SEED_BANNED) ins.run(w, c, s, nowIso());
  }
}
