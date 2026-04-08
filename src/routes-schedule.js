/**
 * Schedule Reorder API
 * - GET /schedule/machines — list machines for dropdown
 * - GET /schedule/machine/:machineId — schedule data (GetMachineScheduleData)
 * - POST /schedule/reorder — save new order (usp_UpdateMachineJobSequence)
 * All endpoints accept ?database=KOL|AHM (default: KOL).
 */
import { Router } from 'express';
import { getPool } from './db.js';
import sql from 'mssql';

const router = Router();
const DEFAULT_DATABASE = 'KOL';
const ALLOWED_DATABASES = ['KOL', 'AHM'];

const IST_OFFSET = '+05:30';
const IST_TZ = 'Asia/Kolkata';

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * @typedef {object} ScheduleDateOptions
 * @property {number} shiftMs — added to the JS instant before formatting (tune if UI is still off)
 * @property {'utc'|'local'} components — which getters to use for label mode
 * @property {'label'|'kolkata'|'sql'} mode — label = clock digits + +05:30; kolkata = Intl in IST; sql = SQL CONVERT (best match to SSMS)
 */

function parseDateLike(v) {
  if (v == null) return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v;
  if (Object.prototype.toString.call(v) === '[object Date]' && typeof v.getTime === 'function') {
    const t = v.getTime();
    if (!Number.isNaN(t)) return v;
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) || /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) {
      const d = new Date(s);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return null;
}

function resolveScheduleDateOptions(req) {
  const q = req.query || {};
  const env = process.env;
  const shiftRaw = q.dateShiftMs ?? env.SCHEDULE_DATETIME_SHIFT_MS ?? '0';
  const shiftParsed = parseInt(String(shiftRaw), 10);
  const shiftMs = Number.isNaN(shiftParsed) ? 0 : shiftParsed;

  let mode = (q.dateMode || env.SCHEDULE_DATETIME_MODE || 'sql').toLowerCase();
  if (mode !== 'label' && mode !== 'kolkata' && mode !== 'sql') {
    mode = 'sql';
  }

  let components = (q.dateComponents || env.SCHEDULE_DATETIME_COMPONENTS || 'auto').toLowerCase();
  if (components !== 'utc' && components !== 'local' && components !== 'auto') {
    components = 'auto';
  }
  if (components === 'auto') {
    const off = new Date().getTimezoneOffset();
    if (off === -330) components = 'local';
    else components = 'utc';
  }

  const useSql =
    mode === 'sql' ||
    q.dateSqlFormat === '1' ||
    env.SCHEDULE_DATETIME_SQL_FORMAT === '1';

  return { shiftMs, mode: useSql ? 'sql' : mode, components, useSqlFormat: useSql };
}

/** Clock digits + +05:30 (no second timezone conversion). */
function formatLabelMode(value, components) {
  const useLocal = components === 'local';
  let y;
  let mo;
  let d;
  let h;
  let mi;
  let s;
  let ms;
  if (useLocal) {
    y = value.getFullYear();
    mo = pad2(value.getMonth() + 1);
    d = pad2(value.getDate());
    h = pad2(value.getHours());
    mi = pad2(value.getMinutes());
    s = pad2(value.getSeconds());
    ms = value.getMilliseconds();
  } else {
    y = value.getUTCFullYear();
    mo = pad2(value.getUTCMonth() + 1);
    d = pad2(value.getUTCDate());
    h = pad2(value.getUTCHours());
    mi = pad2(value.getUTCMinutes());
    s = pad2(value.getUTCSeconds());
    ms = value.getUTCMilliseconds();
  }
  const base = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  if (ms > 0) {
    return `${base}.${String(ms).padStart(3, '0')}${IST_OFFSET}`;
  }
  return `${base}${IST_OFFSET}`;
}

/** Wall clock in Asia/Kolkata for this instant (use when driver encodes correct UTC instant). */
function formatKolkataMode(value) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: IST_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const parts = fmt.formatToParts(value);
  const g = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}${IST_OFFSET}`;
}

function rfc3339ToDisplay(rfc) {
  if (typeof rfc !== 'string') return rfc;
  let s = rfc.replace(/\+05:30$/, '');
  s = s.replace(/\.\d{3}$/, '');
  return s.replace('T', ' ');
}

function formatScheduleDateValue(date, options) {
  let d = date;
  if (options.shiftMs) {
    d = new Date(date.getTime() + options.shiftMs);
  }
  if (options.mode === 'kolkata') {
    return formatKolkataMode(d);
  }
  return formatLabelMode(d, options.components);
}

/** Sync mapping when not using SQL FORMAT. Adds KeyDisplay (plain text) for each date field. */
function mapScheduleRowDates(row, options) {
  const out = { ...row };
  for (const key of Object.keys(out)) {
    const v = out[key];
    const parsed = parseDateLike(v);
    if (!parsed) continue;
    const formatted = formatScheduleDateValue(parsed, options);
    out[key] = formatted;
    out[`${key}Display`] = rfc3339ToDisplay(formatted);
  }
  return out;
}

const sqlFormatCache = new Map();

/**
 * SQL Server CONVERT matches how the DB engine sees the same instant — avoids
 * Node/driver timezone quirks. Cached by epoch ms.
 */
async function formatWithSqlConvert(pool, value) {
  const t = value.getTime();
  if (sqlFormatCache.has(t)) {
    return sqlFormatCache.get(t);
  }
  const r = await pool.request().input('d', sql.DateTime2, value).query(`
    SELECT CONVERT(VARCHAR(23), @d, 121) AS s
  `);
  const s = (r.recordset[0] && r.recordset[0].s) || '';
  sqlFormatCache.set(t, s);
  return s;
}

async function mapScheduleRowDatesWithSql(pool, rows, options) {
  sqlFormatCache.clear();
  const outRows = [];
  for (const row of rows) {
    const o = { ...row };
    for (const key of Object.keys(o)) {
      const v = o[key];
      const parsed = parseDateLike(v);
      if (!parsed) continue;
      let d = parsed;
      if (options.shiftMs) {
        d = new Date(parsed.getTime() + options.shiftMs);
      }
      const sqlStr = await formatWithSqlConvert(pool, d);
      o[key] = sqlStr;
      o[`${key}Display`] = sqlStr;
    }
    outRows.push(o);
  }
  return outRows;
}

function getDbFromQuery(req) {
  const db = (req.query?.database || req.body?.database || DEFAULT_DATABASE).toString().trim().toUpperCase();
  return ALLOWED_DATABASES.includes(db) ? db : null;
}

/**
 * GET /api/schedule/machines?database=KOL
 * Returns list of machines: [{ machineId, machineName, machineType }, ...]
 */
router.get('/schedule/machines', async (req, res) => {
  const db = getDbFromQuery(req);
  if (!db) {
    return res.status(400).json({ error: 'database must be KOL or AHM' });
  }
  try {
    const pool = await getPool(db);
    const result = await pool.request().query(`
      SELECT MachineID AS machineId, MachineName AS machineName, MachineType AS machineType
      FROM dbo.MachineMaster
      WHERE IsDeletedTransaction = 0
      ORDER BY MachineName
    `);
    console.log('[schedule] machines result:', JSON.stringify(result.recordset));
    const list = (result.recordset || []).map((r) => {
      const keys = Object.keys(r);
      const findVal = (name) => {
        const k = keys.find((x) => x.toLowerCase() === name.toLowerCase());
        const v = k != null ? r[k] : undefined;
        return v != null ? String(v) : '';
      };
      return {
        machineId: findVal('machineid'),
        machineName: findVal('machinename'),
        machineType: findVal('machinetype'),
      };
    });
    console.log('[schedule] machines sample:', JSON.stringify(list.slice(0, 2)));
    return res.json(list);
  } catch (e) {
    console.error('[schedule] machines list failed:', e);
    return res.status(500).json({ error: e.message || 'Failed to fetch machines' });
  }
});

/**
 * GET /api/schedule/machine/:machineId?database=KOL
 * Returns schedule rows for the machine (GetMachineScheduleData).
 *
 * Date/datetime handling (defaults to SQL CONVERT so values match SSMS):
 * - dateMode=sql|label|kolkata — sql (default) uses SQL Server CONVERT; label = clock digits + +05:30;
 *   kolkata = Intl in Asia/Kolkata (correct when JS Date is the true UTC instant).
 * - dateComponents=utc|local|auto — for label mode only (auto: local if host offset is IST).
 * - dateShiftMs=N — milliseconds added to each instant before formatting (fine-tuning).
 * - dateSqlFormat=1 — force SQL CONVERT even if dateMode is label.
 * Env: SCHEDULE_DATETIME_MODE, SCHEDULE_DATETIME_COMPONENTS, SCHEDULE_DATETIME_SHIFT_MS, SCHEDULE_DATETIME_SQL_FORMAT.
 *
 * Each date column also gets KeyDisplay (e.g. StartDateTimeDisplay) as plain "YYYY-MM-DD HH:mm:ss" for text-only UI.
 */
router.get('/schedule/machine/:machineId', async (req, res) => {
  const db = getDbFromQuery(req);
  if (!db) {
    return res.status(400).json({ error: 'database must be KOL or AHM' });
  }
  const machineIdStr = String(req.params.machineId || '').trim();
  const machineId = parseInt(machineIdStr, 10);
  if (Number.isNaN(machineId) || machineId < 0) {
    return res.status(400).json({ error: 'Valid machineId is required' });
  }
  try {
    const pool = await getPool(db);
    const result = await pool.request().input('MachineID', sql.Int, machineId).execute('dbo.GetMachineScheduleData');
    const rows = result.recordset || [];
    const dateOpts = resolveScheduleDateOptions(req);
    console.log('[schedule] GetMachineScheduleData', {
      database: db,
      machineId,
      rowCount: rows.length,
      dateOpts
    });
    let payload;
    if (dateOpts.useSqlFormat) {
      payload = await mapScheduleRowDatesWithSql(pool, rows, dateOpts);
    } else {
      payload = rows.map((r) => mapScheduleRowDates(r, dateOpts));
    }
    if (payload.length > 0) {
      console.log('[schedule] FIRST 3 ROWS (keys + values):');
      payload.slice(0, 3).forEach(function (row, i) {
        console.log('[schedule] row[' + i + '] keys:', Object.keys(row));
        console.log('[schedule] row[' + i + '] data:', JSON.stringify(row));
      });
    }
    return res.json(payload);
  } catch (e) {
    console.error('[schedule] GetMachineScheduleData failed:', e);
    return res.status(500).json({ error: e.message || 'Failed to fetch schedule' });
  }
});

/**
 * POST /api/schedule/reorder
 * Body: { database?: 'KOL'|'AHM', machineId: number, orderedJobIds: number[] }
 * Saves new order and runs Auto_Schedule_Refresh via usp_UpdateMachineJobSequence.
 */
router.post('/schedule/reorder', async (req, res) => {
  const db = getDbFromQuery(req);
  if (!db) {
    return res.status(400).json({ error: 'database must be KOL or AHM' });
  }
  const { machineId, orderedJobIds } = req.body || {};
  const mid = parseInt(machineId, 10);
  if (Number.isNaN(mid) || mid < 0) {
    return res.status(400).json({ error: 'Valid machineId is required' });
  }
  if (!Array.isArray(orderedJobIds) || orderedJobIds.length === 0) {
    return res.status(400).json({ error: 'orderedJobIds must be a non-empty array' });
  }
  const ids = orderedJobIds.map((id) => parseInt(id, 10)).filter((n) => !Number.isNaN(n));
  if (ids.length !== orderedJobIds.length) {
    return res.status(400).json({ error: 'All orderedJobIds must be numbers' });
  }
  const orderedJson = JSON.stringify(ids.map((id, idx) => ({ id, pos: idx + 1 })));
  try {
    const pool = await getPool(db);
    await pool
      .request()
      .input('MachineID', sql.Int, mid)
      .input('OrderedJobsJSON', sql.NVarChar(sql.MAX), orderedJson)
      .execute('dbo.usp_UpdateMachineJobSequence');
    return res.json({ success: true });
  } catch (e) {
    console.error('[schedule] reorder failed:', e);
    return res.status(500).json({ error: e.message || 'Failed to save order' });
  }
});

/**
 * POST /api/schedule/refresh
 * Body: { database?: 'KOL'|'AHM' }
 * Runs Auto_Schedule_Refresh.
 */
router.post('/schedule/refresh', async (req, res) => {
  const db = getDbFromQuery(req);
  if (!db) {
    return res.status(400).json({ error: 'database must be KOL or AHM' });
  }
  try {
    const pool = await getPool(db);
    await pool.request().execute('dbo.Auto_Schedule_Refresh');
    return res.json({ success: true });
  } catch (e) {
    console.error('[schedule] refresh failed:', e);
    return res.status(500).json({ error: e.message || 'Failed to refresh schedule' });
  }
});

/**
 * POST /api/schedule/change-machine
 * Body: { database?: 'KOL'|'AHM', sourceMachineId: number, targetMachineId: number, jobIds: number[] }
 * Moves jobs from one machine to another and runs Auto_Schedule_Refresh.
 */
router.post('/schedule/change-machine', async (req, res) => {
  const db = getDbFromQuery(req);
  if (!db) {
    return res.status(400).json({ error: 'database must be KOL or AHM' });
  }
  const { sourceMachineId, targetMachineId, jobIds } = req.body || {};
  const src = parseInt(sourceMachineId, 10);
  const tgt = parseInt(targetMachineId, 10);
  if (Number.isNaN(src) || src < 0) {
    return res.status(400).json({ error: 'Valid sourceMachineId is required' });
  }
  if (Number.isNaN(tgt) || tgt < 0) {
    return res.status(400).json({ error: 'Valid targetMachineId is required' });
  }
  if (src === tgt) {
    return res.status(400).json({ error: 'sourceMachineId and targetMachineId must differ' });
  }
  if (!Array.isArray(jobIds) || jobIds.length === 0) {
    return res.status(400).json({ error: 'jobIds must be a non-empty array' });
  }
  const ids = jobIds.map((id) => parseInt(id, 10)).filter((n) => !Number.isNaN(n));
  if (ids.length !== jobIds.length) {
    return res.status(400).json({ error: 'All jobIds must be numbers' });
  }
  const jobIdsJson = JSON.stringify(ids);
  try {
    const pool = await getPool(db);
    await pool
      .request()
      .input('SourceMachineID', sql.Int, src)
      .input('TargetMachineID', sql.Int, tgt)
      .input('JobIdsJSON', sql.NVarChar(sql.MAX), jobIdsJson)
      .execute('dbo.usp_ChangeJobMachine');
    return res.json({ success: true });
  } catch (e) {
    console.error('[schedule] change-machine failed:', e);
    return res.status(500).json({ error: e.message || 'Failed to change machine' });
  }
});

export default router;
