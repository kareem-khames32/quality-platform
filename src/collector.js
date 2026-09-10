/**
 * Collector: pulls new CDR rows from each SQL Server warehouse (cdr_central) into the local calls table.
 * Only metadata is copied - the recording stays on the branch servers and is streamed on demand via the gateway.
 */
import sql from 'mssql';
import { config } from './config.js';
import { db, getSettings, usageToday, q } from './db.js';
import { parseClid, normalizePhone, hasCustomerNumber, toLocalStamp, nowIso, sleep } from './util.js';
import { beat } from './resilience.js';

const log = (...a) => console.log(new Date().toISOString(), '[collector]', ...a);

const pools = new Map();
async function getPool(w) {
  if (pools.has(w.id)) return pools.get(w.id);
  const pool = new sql.ConnectionPool({
    server: w.host, port: w.port || 1433, database: w.database || 'CDRWarehouse',
    user: w.user, password: w.password,
    // useUTC:false -> SQL Server's naive datetime values keep their wall-clock hours (no timezone shift)
    options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true, useUTC: false },
    pool: { max: 2, min: 0, idleTimeoutMillis: 60000 },
    requestTimeout: 120000, connectionTimeout: 15000,
  });
  await pool.connect();
  pools.set(w.id, pool);
  return pool;
}

/** Decide whether a freshly ingested call should be auto-queued for transcription. */
export function evaluateRules(call, settings) {
  if (!settings.auto_transcribe) return { queue: false, reason: 'auto_off' };
  if (call.disposition !== 'ANSWERED') return { queue: false, reason: 'not_answered' };
  if (settings.min_billsec && call.billsec < settings.min_billsec) return { queue: false, reason: 'too_short' };
  if (settings.max_billsec && call.billsec > settings.max_billsec) return { queue: false, reason: 'too_long' };
  // internal ext-to-ext calls and CDRs without any number: there is no customer recording to find for them
  if (settings.skip_no_customer_number !== false && !hasCustomerNumber(call.phone, call.agent_ext)) return { queue: false, reason: 'no_customer_number' };
  if (settings.allowed_servers?.length && !settings.allowed_servers.includes(call.server_name)) return { queue: false, reason: 'server_excluded' };
  if (settings.daily_cap && usageToday('auto_queued') >= settings.daily_cap) return { queue: false, reason: 'daily_cap' };
  if (settings.sample_percent < 100 && Math.random() * 100 >= settings.sample_percent) return { queue: false, reason: 'sampled_out' };
  return { queue: true };
}

const insertCall = db.prepare(`
  INSERT OR IGNORE INTO calls(warehouse, server_name, source_cdr_id, uniqueid, calldate, agent_ext, agent_name, dst_raw, phone, direction,
    duration, billsec, disposition, dcontext, status, skip_reason, queued_at, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const upsertWm = db.prepare(`INSERT INTO sync_watermark(warehouse,last_id,last_sync_at,last_error,last_count) VALUES(?,?,?,?,?)
  ON CONFLICT(warehouse) DO UPDATE SET last_id=excluded.last_id, last_sync_at=excluded.last_sync_at, last_error=excluded.last_error, last_count=excluded.last_count`);
const bumpAuto = db.prepare(`INSERT INTO usage_log(day,kind,count,seconds) VALUES(?,?,1,0) ON CONFLICT(day,kind) DO UPDATE SET count=count+1`);

export async function collectWarehouse(w) {
  const settings = getSettings();
  const pool = await getPool(w);
  const wm = q.one('SELECT last_id FROM sync_watermark WHERE warehouse=?', w.id);
  let lastId = wm?.last_id || 0;

  if (!lastId) {
    // first run: start from the lookback window instead of 20M historical rows
    const days = config.collector.lookback_days ?? 1;
    const r = await pool.request().input('days', sql.Int, days)
      .query(`SELECT (SELECT MIN(id) FROM cdr_central WHERE calldate >= DATEADD(day, -@days, GETDATE())) AS min_id,
                     (SELECT MAX(id) FROM cdr_central) AS max_id`);
    const { min_id, max_id } = r.recordset[0];
    // no rows inside the lookback window (stale warehouse) -> start from the end and only pick up future rows
    lastId = min_id ? Math.max(0, Number(min_id) - 1) : Number(max_id || 0);
    log(`${w.id}: first run, starting after id ${lastId} (lookback ${days}d${min_id ? '' : ', no recent rows'})`);
  }

  const batch = config.collector.batch_size || 5000;
  let total = 0, queued = 0;
  for (;;) {
    beat('collector');   // a long first sync must not look like a stalled collector to the watchdog
    const where = settings.ingest_only_answered ? "AND disposition='ANSWERED' AND billsec > 0" : '';
    const r = await pool.request().input('last', sql.BigInt, lastId).input('n', sql.Int, batch).query(`
      SELECT TOP (@n) id, server_name, source_id, calldate, clid, src, dst, dcontext, duration, billsec, disposition, uniqueid
      FROM cdr_central WHERE id > @last ${where} ORDER BY id`);
    const rows = r.recordset;
    if (!rows.length) break;

    const tx = db.prepare('BEGIN'); tx.run();
    try {
      for (const row of rows) {
        const { name, ext } = parseClid(row.clid, row.src);
        const calldate = toLocalStamp(new Date(row.calldate));
        const call = { server_name: row.server_name, billsec: row.billsec, disposition: row.disposition, phone: normalizePhone(row.dst), agent_ext: ext };
        const rule = evaluateRules(call, settings);
        const status = row.disposition !== 'ANSWERED' ? 'skipped' : (rule.queue ? 'queued' : 'new');
        const res = insertCall.run(
          w.id, row.server_name, Number(row.id), row.uniqueid, calldate, ext, name, row.dst, normalizePhone(row.dst),
          row.dcontext === 'from-internal' ? 'out' : 'in',
          row.duration, row.billsec, row.disposition, row.dcontext, status, rule.queue ? null : rule.reason,
          rule.queue ? nowIso() : null, nowIso());
        if (res.changes) { total++; if (rule.queue) { queued++; bumpAuto.run(nowIso().slice(0, 10), 'auto_queued'); } }
        lastId = Math.max(lastId, Number(row.id));
      }
      db.prepare('COMMIT').run();
    } catch (e) { db.prepare('ROLLBACK').run(); throw e; }

    upsertWm.run(w.id, lastId, nowIso(), null, total);
    if (rows.length < batch) break;
  }
  upsertWm.run(w.id, lastId, nowIso(), null, total);
  log(`${w.id}: +${total} calls (${queued} auto-queued), watermark ${lastId}`);
  return { total, queued };
}

export async function collectAll() {
  const out = {};
  for (const w of config.warehouses) {
    try { out[w.id] = await collectWarehouse(w); }
    catch (e) {
      log(`${w.id}: ERROR ${e.message}`);
      const wm = q.one('SELECT last_id FROM sync_watermark WHERE warehouse=?', w.id);
      upsertWm.run(w.id, wm?.last_id || 0, nowIso(), e.message, 0);
      out[w.id] = { error: e.message };
    }
  }
  return out;
}

let running = false;
export async function runCollectorLoop() {
  const interval = (config.collector.interval_sec || 300) * 1000;
  for (;;) {
    beat('collector');
    if (!running) {
      running = true;
      try { await collectAll(); } catch (e) { log('loop error', e); }
      running = false;
    }
    beat('collector');
    await sleep(interval);
  }
}

/** Live health probe used by the settings page. */
export async function probeWarehouses() {
  const out = [];
  for (const w of config.warehouses) {
    const t = Date.now();
    try {
      const pool = await getPool(w);
      const r = await pool.request().query(`SELECT server_name, last_source_id, last_sync_at FROM cdr_sync_watermark ORDER BY server_name`);
      out.push({ id: w.id, name: w.name, host: w.host, ok: true, ms: Date.now() - t, servers: r.recordset });
    } catch (e) { out.push({ id: w.id, name: w.name, host: w.host, ok: false, error: e.message }); }
  }
  return out;
}
