/**
 * Dates for the Stock Issue Tool.
 *
 * The SQL Server clock is IST, so every timestamp is taken with GETDATE() in
 * SQL. The Node process may run in UTC (Render does), so "today" is computed in
 * Asia/Kolkata here and never with `new Date().getDate()`.
 *
 * Dates travel as 'YYYY-MM-DD' strings so no timezone ever touches them.
 */

const KOLKATA = new Intl.DateTimeFormat('en-CA', {
	timeZone: 'Asia/Kolkata',
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
});

/** Today's date in India, as 'YYYY-MM-DD'. */
export function todayInKolkata(now = new Date()) {
	return KOLKATA.format(now);
}

/** Add whole days to a 'YYYY-MM-DD' date. */
export function addDays(isoDate, days) {
	const d = new Date(`${isoDate}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`, both 'YYYY-MM-DD'. */
export function daysBetween(from, to) {
	return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

/**
 * The Indian financial year of a date (April to March), in the two forms the
 * ERP uses: FYear '2026-2027' on the rows, '_26_27' at the end of a voucher
 * number. Mirrors the computation in usp_IssueTool_PostIssue.
 */
export function financialYear(isoDate) {
	const [year, month] = isoDate.split('-').map(Number);
	const start = month >= 4 ? year : year - 1;
	const yy = (n) => String(n).slice(-2);
	return { fYear: `${start}-${start + 1}`, suffix: `_${yy(start)}_${yy(start + 1)}` };
}

/** A SQL date column (a JS Date at UTC midnight from mssql) back to 'YYYY-MM-DD'. */
export function toIsoDate(value) {
	if (!value) return null;
	if (typeof value === 'string') return value.slice(0, 10);
	return new Date(value).toISOString().slice(0, 10);
}

/**
 * A SQL datetime as the wall-clock IST string the database holds.
 *
 * mssql reads DATETIME as if it were UTC, so the ISO string's digits are the
 * server's IST digits. Dropping the 'Z' keeps a browser from shifting them a
 * second time.
 */
export function toLocalDateTime(value) {
	if (!value) return null;
	return new Date(value).toISOString().slice(0, 19);
}
