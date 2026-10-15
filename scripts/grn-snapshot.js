/**
 * GRN Creator — before/after snapshot of the ERP database.
 *
 * Finds every table the ERP's own screens touch when a GRN and then a
 * purchase invoice are saved, so the tool can write exactly the same rows.
 * Take a snapshot, save a voucher in the ERP, take the next snapshot; each
 * snapshot after the first is compared with the one before it and a Markdown
 * report of what changed is written next to it.
 *
 * It only runs SELECTs. Nothing is written to the database.
 *
 * How changes are found, for every user table:
 *  - tables up to --row-limit rows: a checksum per row, keyed by the primary
 *    key (or identity), so new, changed and deleted rows are each identified;
 *  - larger tables: row count, highest identity value and a table checksum.
 *    New rows are found by identity, changed rows by any Modified / Created
 *    datetime column at or after the previous snapshot. A large table that
 *    changed with neither is reported as such; re-run with --rows <Table> to
 *    track it row by row.
 *  - --po <VoucherNo>: that PO's header and lines, every line received
 *    against it, and its items' and supplier's master rows are stored in full,
 *    so their column-by-column changes (old → new) are shown.
 *
 * Other people working in the ERP between two snapshots show up too: keep the
 * gap short and ignore rows that belong to other vouchers.
 *
 * Run from the backend folder:
 *   node scripts/grn-snapshot.js --site KOL --label 0-before --po PO03408_26_27
 *   (save the GRN in the ERP)
 *   node scripts/grn-snapshot.js --site KOL --label 1-after-grn --po PO03408_26_27
 *   (save the purchase invoice in the ERP)
 *   node scripts/grn-snapshot.js --site KOL --label 2-after-pi --po PO03408_26_27
 *
 * Output: grn-snapshots/<site>/<label>.json and <label>.md (git-ignored).
 * Send the .md files back.
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { getLongQueryPool, closeAllPools, sql } = await import('../src/db.js');
const { show } = await import('../src/issue-tool/compare.js');

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SITE = arg('site', 'KOL').toUpperCase();
const LABEL = arg('label', '');
const PO_NO = arg('po', '');
const ROW_LIMIT = Number(arg('row-limit', 500_000));
const EXTRA_ROW_TABLES = new Set(String(arg('rows', '')).split(',').map((t) => t.trim().toLowerCase()).filter(Boolean));
const SHOW_ROWS = Number(arg('show', 15));
const DIR = path.join(__dirname, '..', 'grn-snapshots', SITE);

const DATE_TYPES = new Set(['datetime', 'datetime2', 'smalldatetime', 'date', 'datetimeoffset']);

let pool;
async function q(text, params = {}) {
	const request = pool.request();
	for (const [name, [type, value]] of Object.entries(params)) request.input(name, type, value);
	const result = await request.query(text);
	return result.recordset || [];
}

const ident = (name) => `[${String(name).replace(/]/g, ']]')}]`;

async function listTables() {
	const tables = await q(`
		SELECT s.name AS SchemaName, t.name AS TableName, t.object_id AS ObjectId,
		       (SELECT SUM(ps.row_count) FROM sys.dm_db_partition_stats ps
		        WHERE ps.object_id = t.object_id AND ps.index_id IN (0, 1)) AS ApproxRows
		FROM sys.tables t
		JOIN sys.schemas s ON s.schema_id = t.schema_id
		WHERE t.is_ms_shipped = 0
		ORDER BY s.name, t.name
	`);
	const columns = await q(`
		SELECT c.object_id AS ObjectId, c.name AS ColumnName, TYPE_NAME(c.system_type_id) AS DataType,
		       c.is_identity AS IsIdentity, c.column_id AS ColumnId
		FROM sys.columns c
		JOIN sys.tables t ON t.object_id = c.object_id AND t.is_ms_shipped = 0
		ORDER BY c.object_id, c.column_id
	`);
	const keys = await q(`
		SELECT ic.object_id AS ObjectId, c.name AS ColumnName, ic.key_ordinal AS KeyOrdinal
		FROM sys.indexes i
		JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
		JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
		JOIN sys.tables t ON t.object_id = i.object_id AND t.is_ms_shipped = 0
		WHERE i.is_primary_key = 1
		ORDER BY ic.object_id, ic.key_ordinal
	`);
	const colsBy = new Map();
	for (const c of columns) {
		if (!colsBy.has(c.ObjectId)) colsBy.set(c.ObjectId, []);
		colsBy.get(c.ObjectId).push(c);
	}
	const pkBy = new Map();
	for (const k of keys) {
		if (!pkBy.has(k.ObjectId)) pkBy.set(k.ObjectId, []);
		pkBy.get(k.ObjectId).push(k.ColumnName);
	}
	return tables.map((t) => {
		const cols = colsBy.get(t.ObjectId) || [];
		const identity = cols.find((c) => c.IsIdentity)?.ColumnName ?? null;
		const pk = pkBy.get(t.ObjectId) || [];
		return {
			name: t.SchemaName === 'dbo' ? t.TableName : `${t.SchemaName}.${t.TableName}`,
			from: `${ident(t.SchemaName)}.${ident(t.TableName)}`,
			approxRows: Number(t.ApproxRows || 0),
			identity,
			key: pk.length ? pk : identity ? [identity] : [],
			dateKeys: new Set(cols.filter((c) => DATE_TYPES.has(c.DataType)).map((c) => c.ColumnName)),
			timeColumns: cols
				.filter((c) => DATE_TYPES.has(c.DataType) && /modif|creat|updat|entry/i.test(c.ColumnName))
				.map((c) => c.ColumnName),
		};
	});
}

/** SQL for a row's key as one string, the same in every snapshot. */
function keyExpr(table) {
	if (!table.key.length) return null;
	// Style 121 only for dates: it is not a valid style for some other types.
	return table.key
		.map((k) => `ISNULL(CONVERT(NVARCHAR(200), ${ident(k)}${table.dateKeys.has(k) ? ', 121' : ''}), N'~')`)
		.join(` + N'|' + `);
}

async function snapshotTable(table) {
	const entry = { approxRows: table.approxRows, identity: table.identity, key: table.key };
	const rowWise = table.approxRows <= ROW_LIMIT || EXTRA_ROW_TABLES.has(table.name.toLowerCase());
	const key = keyExpr(table);

	const [stats] = await q(`
		SELECT COUNT_BIG(*) AS RowTotal,
		       CHECKSUM_AGG(BINARY_CHECKSUM(*)) AS Agg
		       ${table.identity ? `, MAX(${ident(table.identity)}) AS MaxId` : ''}
		FROM ${table.from} WITH (NOLOCK)
	`);
	entry.rows = Number(stats.RowTotal);
	entry.agg = stats.Agg;
	entry.maxId = table.identity ? (stats.MaxId === null ? null : String(stats.MaxId)) : null;

	if (rowWise) {
		if (key) {
			const rows = await q(`SELECT ${key} AS K, BINARY_CHECKSUM(*) AS C FROM ${table.from} WITH (NOLOCK)`);
			entry.perRow = Object.fromEntries(rows.map((r) => [r.K, r.C]));
		} else {
			// No key at all: a multiset of row checksums still shows rows added
			// and removed, and lets them be selected back by checksum.
			const rows = await q(`SELECT BINARY_CHECKSUM(*) AS C, COUNT_BIG(*) AS N FROM ${table.from} WITH (NOLOCK) GROUP BY BINARY_CHECKSUM(*)`);
			entry.perChecksum = Object.fromEntries(rows.map((r) => [String(r.C), Number(r.N)]));
		}
	}
	return entry;
}

async function focusRows() {
	if (!PO_NO) return null;
	const header = await q(`
		SELECT * FROM dbo.ItemTransactionMain WITH (NOLOCK)
		WHERE VoucherNo = @po AND ISNULL(IsDeletedTransaction, 0) = 0
	`, { po: [sql.NVarChar(100), PO_NO] });
	if (!header.length) return { error: `PO ${PO_NO} not found in ItemTransactionMain.` };
	const poId = header[0].TransactionID;
	const lines = await q(`SELECT * FROM dbo.ItemTransactionDetail WITH (NOLOCK) WHERE TransactionID = @id`, { id: [sql.Int, poId] });
	const received = await q(`SELECT * FROM dbo.ItemTransactionDetail WITH (NOLOCK) WHERE PurchaseTransactionID = @id AND TransactionID <> @id`, { id: [sql.Int, poId] });
	const receiptIds = [...new Set(received.map((r) => r.TransactionID))];
	const receiptHeaders = receiptIds.length
		? await q(`SELECT * FROM dbo.ItemTransactionMain WITH (NOLOCK) WHERE TransactionID IN (${receiptIds.map(Number).join(',')})`)
		: [];
	const itemIds = [...new Set(lines.map((l) => l.ItemID).filter((v) => v !== null))];
	const items = itemIds.length
		? await q(`SELECT * FROM dbo.ItemMaster WITH (NOLOCK) WHERE ItemID IN (${itemIds.map(Number).join(',')})`)
		: [];
	const supplier = await q(`SELECT * FROM dbo.LedgerMaster WITH (NOLOCK) WHERE LedgerID = @id`, { id: [sql.Int, header[0].LedgerID] });
	const keyed = (rows, col) => Object.fromEntries(rows.map((r) => [String(r[col]), r]));
	return {
		poTransactionId: poId,
		'PO header (ItemTransactionMain)': keyed(header, 'TransactionID'),
		'PO lines (ItemTransactionDetail)': keyed(lines, 'TransactionDetailID'),
		'Receipt headers against the PO (ItemTransactionMain)': keyed(receiptHeaders, 'TransactionID'),
		'Receipt lines against the PO (ItemTransactionDetail)': keyed(received, 'TransactionDetailID'),
		'Items (ItemMaster)': keyed(items, 'ItemID'),
		'Supplier (LedgerMaster)': keyed(supplier, 'LedgerID'),
	};
}

// ── Report ───────────────────────────────────────────────────────────────────

const out = [];
const h = (level, text) => out.push('', `${'#'.repeat(level)} ${text}`, '');
const p = (text) => out.push(text);
const cell = (v) => show(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** Rows side by side, one line per column: wide ERP tables stay readable. */
function vertical(rows, labels) {
	if (!rows.length) return p('_(no rows)_');
	const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
	p(`| Column | ${labels.join(' | ')} |`);
	p(`| --- | ${labels.map(() => '---').join(' | ')} |`);
	for (const c of columns) p(`| ${c} | ${rows.map((r) => cell(r[c])).join(' | ')} |`);
}

function changedColumns(before, after) {
	const columns = [...new Set([...Object.keys(before), ...Object.keys(after)])];
	return columns.filter((c) => show(normalise(before[c])) !== show(normalise(after[c])))
		.map((c) => ({ column: c, before: before[c], after: after[c] }));
}

const iso = (v) => new Date(v).toISOString().replace('T', ' ').slice(0, 19);

/** Dates and binary values round-trip through JSON in another shape. */
function normalise(v) {
	if (v instanceof Date) return v.toISOString();
	if (Buffer.isBuffer(v)) return v.toString('hex');
	if (v && v.type === 'Buffer' && Array.isArray(v.data)) return Buffer.from(v.data).toString('hex');
	return v;
}

async function fetchByKeys(table, keys) {
	const key = keyExpr(table);
	const list = keys.slice(0, SHOW_ROWS);
	if (!list.length) return [];
	const params = {};
	const names = list.map((k, i) => {
		params[`k${i}`] = [sql.NVarChar(4000), k];
		return `@k${i}`;
	});
	return q(`SELECT * FROM ${table.from} WITH (NOLOCK) WHERE ${key} IN (${names.join(',')})`, params);
}

async function fetchByChecksums(table, checksums) {
	const list = checksums.slice(0, SHOW_ROWS).map(Number).filter(Number.isFinite);
	if (!list.length) return [];
	return q(`SELECT TOP ${SHOW_ROWS} * FROM ${table.from} WITH (NOLOCK) WHERE BINARY_CHECKSUM(*) IN (${list.join(',')})`);
}

async function report(prev, curr, tables) {
	const byName = new Map(tables.map((t) => [t.name, t]));
	h(1, `GRN snapshot: ${prev.label} → ${curr.label}`);
	p(`Site **${SITE}**, database **${curr.database}**. Window (server time): ${iso(prev.takenAt)} → ${iso(curr.startedAt)}. PO: ${PO_NO || '—'}.`);
	p('');
	p('Values are quoted so `""` (empty), `" "` (a space) and `NULL` can be told apart. Rows from other people\'s work in the same window also appear.');

	const changes = [];
	for (const [name, after] of Object.entries(curr.tables)) {
		const before = prev.tables[name];
		const table = byName.get(name);
		if (!before || !table || after.error || before.error) continue;
		const sameStats = before.rows === after.rows && before.agg === after.agg && before.maxId === after.maxId;
		// Row-wise tables are always compared row by row: a table checksum can
		// collide, and an unchanged-looking table is exactly where that hides.
		if (sameStats && !(before.perRow && after.perRow)) continue;

		const change = { name, table, before, after, added: [], updated: [], deleted: [], how: '' };
		if (before.perRow && after.perRow) {
			change.how = 'row checksums';
			for (const [k, c] of Object.entries(after.perRow)) {
				if (!(k in before.perRow)) change.added.push(k);
				else if (before.perRow[k] !== c) change.updated.push(k);
			}
			for (const k of Object.keys(before.perRow)) if (!(k in after.perRow)) change.deleted.push(k);
			if (!change.added.length && !change.updated.length && !change.deleted.length) continue;
		} else if (before.perChecksum && after.perChecksum) {
			change.how = 'row checksums (no key)';
			for (const [c, n] of Object.entries(after.perChecksum)) if (n > (before.perChecksum[c] || 0)) change.added.push(c);
			for (const [c, n] of Object.entries(before.perChecksum)) if (n > (after.perChecksum[c] || 0)) change.deleted.push(c);
		} else {
			change.how = 'table checksum';
		}
		changes.push(change);
	}

	h(2, 'Changed tables');
	if (!changes.length) p('_Nothing changed._');
	else {
		p('| Table | Rows before | Rows after | New | Changed | Deleted | Found by |');
		p('| --- | --- | --- | --- | --- | --- | --- |');
		for (const c of changes) {
			const n = (list) => (c.how === 'table checksum' ? '?' : list.length);
			p(`| ${c.name} | ${c.before.rows} | ${c.after.rows} | ${n(c.added)} | ${n(c.updated)} | ${n(c.deleted)} | ${c.how} |`);
		}
	}

	if (curr.focus && prev.focus && !curr.focus.error) {
		h(2, `PO ${PO_NO}: rows stored in full`);
		for (const [group, rowsAfter] of Object.entries(curr.focus)) {
			if (group === 'poTransactionId') continue;
			const rowsBefore = prev.focus[group] || {};
			const lines = [];
			for (const [id, row] of Object.entries(rowsAfter)) {
				if (!rowsBefore[id]) {
					lines.push({ id, row, isNew: true });
					continue;
				}
				const diffs = changedColumns(rowsBefore[id], row);
				if (diffs.length) lines.push({ id, diffs });
			}
			if (!lines.length) continue;
			h(3, group);
			for (const l of lines) {
				if (l.isNew) {
					p(`**New row ${l.id}**`);
					p('');
					vertical([l.row], ['value']);
				} else {
					p(`**Row ${l.id}: changed columns**`);
					p('');
					p('| Column | Before | After |');
					p('| --- | --- | --- |');
					for (const d of l.diffs) p(`| ${d.column} | ${cell(d.before)} | ${cell(d.after)} |`);
				}
				p('');
			}
		}
	}

	for (const c of changes) {
		h(2, c.name);
		await safe(c.name, async () => {
			if (c.how === 'table checksum') {
				const table = c.table;
				if (table.identity && c.before.maxId !== null && c.after.maxId !== c.before.maxId) {
					const rows = await q(`SELECT TOP ${SHOW_ROWS} * FROM ${table.from} WITH (NOLOCK) WHERE ${ident(table.identity)} > @id ORDER BY ${ident(table.identity)}`,
						{ id: [sql.BigInt, c.before.maxId] });
					h(3, `New rows (${table.identity} > ${c.before.maxId})`);
					vertical(rows, rows.map((r) => String(r[table.identity])));
				}
				if (table.timeColumns.length) {
					const where = table.timeColumns.map((col) => `${ident(col)} >= @since`).join(' OR ');
					const idFilter = table.identity && c.before.maxId !== null ? `AND ${ident(table.identity)} <= @maxId` : '';
					const params = { since: [sql.DateTime, new Date(prev.takenAtServer)] };
					if (idFilter) params.maxId = [sql.BigInt, c.before.maxId];
					const rows = await q(`SELECT TOP ${SHOW_ROWS} * FROM ${table.from} WITH (NOLOCK) WHERE (${where}) ${idFilter}`, params);
					h(3, `Existing rows with ${table.timeColumns.join(' / ')} in the window`);
					vertical(rows, rows.map((_, i) => `row ${i + 1}`));
				} else if (!(table.identity && c.after.maxId !== c.before.maxId)) {
					p(`_Large table changed but the rows cannot be identified. Re-run every snapshot with \`--rows ${c.name}\`._`);
				}
				return;
			}
			if (c.how === 'row checksums (no key)') {
				const rows = await fetchByChecksums(c.table, c.added);
				h(3, `New rows (${c.added.length})`);
				vertical(rows, rows.map((_, i) => `row ${i + 1}`));
				if (c.deleted.length) p(`\n${c.deleted.length} row(s) gone (no key, so not identifiable).`);
				return;
			}
			const label = c.table.key.join('|');
			if (c.added.length) {
				h(3, `New rows (${c.added.length}${c.added.length > SHOW_ROWS ? `, first ${SHOW_ROWS}` : ''}) — key ${label}`);
				const rows = await fetchByKeys(c.table, c.added);
				vertical(rows, rows.map((r) => c.table.key.map((k) => show(r[k])).join('|')));
			}
			if (c.updated.length) {
				h(3, `Changed rows, current values (${c.updated.length}${c.updated.length > SHOW_ROWS ? `, first ${SHOW_ROWS}` : ''}) — key ${label}`);
				const rows = await fetchByKeys(c.table, c.updated);
				vertical(rows, rows.map((r) => c.table.key.map((k) => show(r[k])).join('|')));
			}
			if (c.deleted.length) {
				h(3, `Deleted rows (${c.deleted.length})`);
				p(c.deleted.slice(0, 50).map((k) => `\`${k}\``).join(', '));
			}
		});
	}

	h(2, 'Triggers on the changed tables');
	await safe('Triggers', async () => {
		const names = changes.map((c) => c.table.from);
		if (!names.length) return p('_(none changed)_');
		const rows = await q(`
			SELECT OBJECT_SCHEMA_NAME(tr.parent_id) + '.' + OBJECT_NAME(tr.parent_id) AS TableName, tr.name AS TriggerName,
			       tr.is_disabled AS IsDisabled
			FROM sys.triggers tr
			WHERE tr.parent_id IN (${names.map((n) => `OBJECT_ID(N'${n.replace(/'/g, "''")}')`).join(',')})
		`);
		if (!rows.length) return p('_No triggers._');
		p('| Table | Trigger | Disabled |');
		p('| --- | --- | --- |');
		for (const r of rows) p(`| ${r.TableName} | ${r.TriggerName} | ${r.IsDisabled} |`);
	});
}

async function safe(label, fn) {
	try {
		await fn();
	} catch (err) {
		p(`> **${label} failed:** ${err.message}`);
	}
}

async function main() {
	if (!LABEL || !/^[\w.-]+$/.test(LABEL)) throw new Error('Give a --label made of letters, digits, "-", "_" or "." (e.g. 0-before).');
	fs.mkdirSync(DIR, { recursive: true });
	const file = path.join(DIR, `${LABEL}.json`);
	if (fs.existsSync(file)) throw new Error(`${file} already exists. Use a new --label.`);

	pool = await getLongQueryPool(SITE);
	const [{ ServerNow, DatabaseName }] = await q(`SELECT GETDATE() AS ServerNow, DB_NAME() AS DatabaseName`);
	const tables = await listTables();
	console.log(`[grn-snapshot] ${DatabaseName}: ${tables.length} tables. Taking snapshot "${LABEL}"…`);

	const snapshot = {
		label: LABEL,
		site: SITE,
		database: DatabaseName,
		po: PO_NO || null,
		startedAt: ServerNow,
		tables: {},
	};
	let done = 0;
	for (const table of tables) {
		try {
			snapshot.tables[table.name] = await snapshotTable(table);
		} catch (err) {
			snapshot.tables[table.name] = { error: err.message };
		}
		done += 1;
		if (done % 50 === 0) console.log(`[grn-snapshot]   ${done}/${tables.length}`);
	}
	snapshot.focus = await focusRows();
	const [{ ServerNow: finished }] = await q(`SELECT GETDATE() AS ServerNow`);
	snapshot.takenAt = finished;
	snapshot.takenAtServer = finished;

	const previous = fs.readdirSync(DIR)
		.filter((f) => f.endsWith('.json') && f !== `${LABEL}.json`)
		.map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')))
		.filter((s) => s.database === DatabaseName)
		.sort((a, b) => new Date(b.takenAt) - new Date(a.takenAt))[0];

	fs.writeFileSync(file, JSON.stringify(snapshot));
	console.log(`[grn-snapshot] Saved ${path.relative(process.cwd(), file)}`);

	const errors = Object.entries(snapshot.tables).filter(([, t]) => t.error);
	if (errors.length) console.log(`[grn-snapshot] ${errors.length} table(s) could not be read: ${errors.slice(0, 5).map(([n]) => n).join(', ')}${errors.length > 5 ? '…' : ''}`);

	if (!previous) {
		console.log('[grn-snapshot] First snapshot: nothing to compare yet. Save the voucher in the ERP, then take the next one.');
		return;
	}
	await report(previous, snapshot, tables);
	if (errors.length) {
		h(2, 'Tables that could not be read');
		for (const [name, t] of errors) p(`- ${name}: ${t.error}`);
	}
	const md = path.join(DIR, `${LABEL}.md`);
	fs.writeFileSync(md, out.join('\n') + '\n');
	console.log(`[grn-snapshot] Compared with "${previous.label}". Report: ${path.relative(process.cwd(), md)}`);
}

main()
	.catch((err) => {
		console.error(`[grn-snapshot] ${err.message}`);
		process.exitCode = 1;
	})
	.finally(() => closeAllPools().catch(() => {}));
