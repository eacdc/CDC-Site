/**
 * Database access for the Stock Issue Tool.
 *
 * Uses the backend's shared pools from src/db.js, chosen by site. No second
 * pool, no second driver. Reads are plain parameterised SQL; every write goes
 * through one of the module's two stored procedures.
 */

import { getPool, getLongQueryPool, sql } from '../db.js';

/**
 * Bind parameters given as `{ name: [sqlType, value] }`. Types are always
 * explicit: quantities and IDs written to the ERP should never be a driver guess.
 */
export function bind(request, params = {}) {
	for (const [name, [type, value]] of Object.entries(params)) {
		request.input(name, type, value);
	}
	return request;
}

/**
 * Every ID in ItemTransactionMain / ItemTransactionDetail is BIGINT, and the
 * driver returns BIGINT as a string ("66933", "-19"). Turn those back into
 * numbers so IDs compare with === and serialise as JSON numbers, as the API
 * contract promises. Safe while IDs stay below 2^53.
 */
export function bigIntsToNumbers(recordset) {
	if (!recordset?.length || !recordset.columns) return recordset || [];
	const bigCols = Object.entries(recordset.columns)
		.filter(([, col]) => col?.type === sql.BigInt || col?.type?.declaration === 'bigint')
		.map(([name]) => name);
	if (!bigCols.length) return recordset;
	for (const row of recordset) {
		for (const name of bigCols) {
			const v = row[name];
			if (typeof v === 'string' && v !== '') row[name] = Number(v);
		}
	}
	return recordset;
}

export async function query(site, text, params) {
	const pool = await getPool(site);
	const result = await bind(pool.request(), params).query(text);
	return bigIntsToNumbers(result.recordset);
}

export async function execute(site, procedure, params, { long = false } = {}) {
	const pool = await (long ? getLongQueryPool(site) : getPool(site));
	const result = await bind(pool.request(), params).execute(procedure);
	(result.recordsets || []).forEach(bigIntsToNumbers);
	return result;
}

/** `@p0, @p1, …` for an IN list, with the matching params. */
export function inList(prefix, values, type = sql.BigInt) {
	const params = {};
	const names = values.map((v, i) => {
		params[`${prefix}${i}`] = [type, v];
		return `@${prefix}${i}`;
	});
	return { sql: names.length ? names.join(', ') : 'NULL', params };
}

/** A LIKE pattern for user text, with the wildcard characters escaped. */
export function likePattern(text) {
	return `%${String(text).replace(/[\\%_[]/g, (c) => `\\${c}`)}%`;
}

export { sql };
