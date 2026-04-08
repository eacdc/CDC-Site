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

/** IST for schedule display; India has no DST (fixed +05:30). */
const IST_TIMEZONE = 'Asia/Kolkata';

/**
 * JSON.stringify / res.json turn Date into UTC ISO strings (Z). Clients then
 * show that instant in the browser's local zone, which mismatches IST.
 * Emit RFC 3339 with explicit +05:30 so values match GetMachineScheduleData intent.
 *
 * If times still look wrong, the Node process may be interpreting SQL datetime
 * differently than the DB — set TZ=Asia/Kolkata on the server or align SQL/driver.
 */
function formatDateAsIstRfc3339(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    return value;
  }
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: IST_TIMEZONE,
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
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}+05:30`;
}

function mapScheduleRowDatesToIstStrings(row) {
  const out = { ...row };
  for (const key of Object.keys(out)) {
    const v = out[key];
    if (v instanceof Date) {
      out[key] = formatDateAsIstRfc3339(v);
    }
  }
  return out;
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
 * All columns from the stored procedure are returned; the frontend controls which to display.
 * Date/datetime columns are returned as strings (RFC 3339 with +05:30 IST), not UTC Z.
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
    console.log('[schedule] GetMachineScheduleData', { database: db, machineId, rowCount: rows.length });
    const payload = rows.map(mapScheduleRowDatesToIstStrings);
    if (payload.length > 0) {
      console.log('[schedule] FIRST 3 ROWS (keys + values, IST strings):');
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
