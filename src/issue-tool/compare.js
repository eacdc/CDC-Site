/**
 * Column-by-column comparison of two issue vouchers (brief 8C).
 *
 * Used by scripts/issue-tool-compare.js (a voucher this tool posted against
 * one the ERP posted) and scripts/issue-tool-acceptance.js (dry-run rows
 * against the captured test vouchers). Pure, so it is unit-tested.
 */

/** Never compared: identity, number and timestamp columns. */
export const ALWAYS_IGNORED = new Set([
	'TransactionID',
	'TransactionDetailID',
	'MaxVoucherNo',
	'VoucherNo',
	'CreatedDate',
	'ModifiedDate',
]);

/** Ignored only when one side is a deleted test voucher (the acceptance run). */
export const DELETION_COLUMNS = ['IsDeletedTransaction', 'DeletedBy', 'DeletedDate'];

/**
 * Normalise a value for comparison while keeping '' / ' ' / NULL distinct,
 * because the ERP is inconsistent about them and we must match it exactly.
 */
export function normalise(value) {
	if (value === null || value === undefined) return null;
	if (value instanceof Date) return value.toISOString();
	// FOR JSON writes DATETIME as '2026-10-03T00:00:00'; mssql reads the same
	// column as a Date with those digits in UTC. Bring both to one form.
	if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)) {
		return new Date(`${value}Z`).toISOString();
	}
	if (Buffer.isBuffer?.(value)) return `0x${value.toString('hex')}`;
	if (typeof value === 'boolean') return value ? 1 : 0;
	if (typeof value === 'number') return Math.round(value * 10000) / 10000;
	if (typeof value === 'string' && value !== '' && value.trim() !== '' && !Number.isNaN(Number(value)) && /^-?\d+(\.\d+)?$/.test(value.trim())) {
		return Math.round(Number(value) * 10000) / 10000;
	}
	return value;
}

/** How a value is printed in a diff: quotes make '' and ' ' visible. */
export function show(value) {
	if (value === null || value === undefined) return 'NULL';
	if (typeof value === 'string') return JSON.stringify(value);
	if (value instanceof Date) return value.toISOString();
	return String(value);
}

/**
 * Differences between two rows, over the union of their columns.
 * @returns {Array<{column, ours, theirs}>}
 */
export function diffRows(ours, theirs, { ignore = new Set() } = {}) {
	const columns = new Set([...Object.keys(ours || {}), ...Object.keys(theirs || {})]);
	const diffs = [];
	for (const column of [...columns].sort()) {
		if (ALWAYS_IGNORED.has(column) || ignore.has(column)) continue;
		const a = normalise(ours?.[column]);
		const b = normalise(theirs?.[column]);
		if (a !== b) diffs.push({ column, ours: ours?.[column], theirs: theirs?.[column] });
	}
	return diffs;
}

/**
 * Compare a voucher: header against header, lines matched by TransID.
 * @returns {{header: Array, lines: Array<{transId, diffs, missing?}>, identical: boolean}}
 */
export function compareVouchers(ours, theirs, { ignore = [] } = {}) {
	const ignoreSet = new Set(ignore);
	const header = diffRows(ours.header, theirs.header, { ignore: ignoreSet });

	const byTransId = (rows) => new Map((rows || []).map((r) => [Number(r.TransID), r]));
	const a = byTransId(ours.lines);
	const b = byTransId(theirs.lines);
	const transIds = [...new Set([...a.keys(), ...b.keys()])].sort((x, y) => x - y);
	const lines = transIds.map((transId) => {
		if (!a.has(transId)) return { transId, missing: 'ours', diffs: [] };
		if (!b.has(transId)) return { transId, missing: 'theirs', diffs: [] };
		return { transId, diffs: diffRows(a.get(transId), b.get(transId), { ignore: ignoreSet }) };
	});

	const identical = header.length === 0 && lines.every((l) => !l.missing && l.diffs.length === 0);
	return { header, lines, identical };
}

/** Plain-text report of a comparison. */
export function formatComparison(result, { oursLabel = 'ours', theirsLabel = 'theirs' } = {}) {
	const out = [];
	const table = (diffs) => {
		for (const d of diffs) out.push(`    ${d.column.padEnd(32)} ${oursLabel}: ${show(d.ours).padEnd(30)} ${theirsLabel}: ${show(d.theirs)}`);
	};
	out.push(result.header.length ? `  Header: ${result.header.length} difference(s)` : '  Header: identical');
	table(result.header);
	for (const line of result.lines) {
		if (line.missing) {
			out.push(`  Line TransID ${line.transId}: missing from ${line.missing === 'ours' ? oursLabel : theirsLabel}`);
		} else {
			out.push(line.diffs.length ? `  Line TransID ${line.transId}: ${line.diffs.length} difference(s)` : `  Line TransID ${line.transId}: identical`);
			table(line.diffs);
		}
	}
	out.push(result.identical ? '  RESULT: indistinguishable (ignoring identity, number and timestamp columns)' : '  RESULT: DIFFERENT');
	return out.join('\n');
}

/** Check named expectations: { column: expectedValue } against a row. */
export function checkExpectations(row, expected) {
	const failures = [];
	for (const [column, value] of Object.entries(expected)) {
		if (normalise(row?.[column]) !== normalise(value)) {
			failures.push({ column, expected: value, actual: row?.[column] });
		}
	}
	return failures;
}
