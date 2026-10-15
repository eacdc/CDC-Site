/**
 * Stock Issue Tool — read-only database discovery (brief section 4).
 *
 * Inspects the live ERP database and writes a Markdown report: every column
 * the module references, the full ITM / ITD schemas, warehouses, the voucher
 * numbering scope, ERP-created template vouchers, and which template columns
 * the posting procedure does not yet write. Review the report and carry the
 * decisions into docs/issue-tool-schema-notes.md before deploying the
 * procedures.
 *
 * It only runs SELECTs. Nothing is written to the database.
 *
 * Run from the backend folder:
 *   npm run issue-tool:discover
 *   node scripts/issue-tool-discover.js --site KOL --company 2 --out docs/issue-tool-schema-discovery.md
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { getPool, closeAllPools, sql } = await import('../src/db.js');
const { REFERENCED_COLUMNS, POST_HEADER_COLUMNS, POST_LINE_COLUMNS } = await import('../src/issue-tool/schema-manifest.js');
const { show } = await import('../src/issue-tool/compare.js');
const { todayInKolkata, financialYear } = await import('../src/issue-tool/dates.js');

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SITE = arg('site', 'KOL').toUpperCase();
const COMPANY_ID = Number(arg('company', process.env.ISSUE_TOOL_COMPANY_ID || 2));
const OUT = path.resolve(path.join(__dirname, '..'), arg('out', 'docs/issue-tool-schema-discovery.md'));

const out = [];
const h = (level, text) => out.push('', `${'#'.repeat(level)} ${text}`, '');
const p = (text) => out.push(text);

function table(rows, columns) {
	if (!rows.length) {
		p('_(no rows)_');
		return;
	}
	const cols = columns ?? Object.keys(rows[0]);
	p(`| ${cols.join(' | ')} |`);
	p(`| ${cols.map(() => '---').join(' | ')} |`);
	for (const r of rows) p(`| ${cols.map((c) => show(r[c]).replace(/\|/g, '\\|')).join(' | ')} |`);
}

let pool;
async function q(text, params = {}) {
	const request = pool.request();
	for (const [name, [type, value]] of Object.entries(params)) request.input(name, type, value);
	const result = await request.query(text);
	return result.recordset || [];
}

async function safe(label, fn) {
	try {
		await fn();
	} catch (err) {
		p(`> **${label} failed:** ${err.message}`);
	}
}

async function columnsOf(tableName) {
	return q(`
		SELECT c.name AS ColumnName, TYPE_NAME(c.user_type_id) AS DataType, c.max_length AS MaxLength,
		       c.precision AS [Precision], c.scale AS Scale, c.is_nullable AS Nullable, c.is_identity AS IsIdentity,
		       dc.definition AS DefaultValue
		FROM sys.columns c
		LEFT JOIN sys.default_constraints dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
		WHERE c.object_id = OBJECT_ID(@t)
		ORDER BY c.column_id
	`, { t: [sql.NVarChar(256), `dbo.${tableName}`] });
}

/** '((0))' → 0, "(N'')" → '', '(getdate())' → undefined (not comparable). */
function parseDefault(definition) {
	if (definition === null || definition === undefined) return null;
	let d = String(definition).trim();
	while (d.startsWith('(') && d.endsWith(')')) d = d.slice(1, -1).trim();
	const str = /^N?'([\s\S]*)'$/.exec(d);
	if (str) return str[1].replace(/''/g, "'");
	if (/^-?\d+(\.\d+)?$/.test(d)) return Number(d);
	if (/^null$/i.test(d)) return null;
	return undefined;
}

function sameAsDefault(value, column) {
	const def = parseDefault(column?.DefaultValue);
	if (def === undefined) return false;
	if (value === null || value === undefined) return def === null;
	if (typeof value === 'boolean') return Number(value) === def;
	if (typeof value === 'number' || typeof def === 'number') return Number(value) === Number(def);
	return String(value) === String(def);
}

async function main() {
	pool = await getPool(SITE);
	const today = todayInKolkata();
	const { fYear } = financialYear(today);

	p('# Stock Issue Tool — schema discovery report');
	p('');
	p(`Generated ${new Date().toISOString()} by \`scripts/issue-tool-discover.js\` against site **${SITE}**, CompanyID **${COMPANY_ID}**, current FYear **${fYear}**. Read-only.`);
	p('');
	p('Values are shown quoted so `""` (empty), `" "` (one space) and `NULL` can be told apart.');

	h(2, '0. Server');
	await safe('Server info', async () => {
		table(await q(`
			SELECT DB_NAME() AS DatabaseName, d.compatibility_level AS CompatibilityLevel,
			       d.is_read_committed_snapshot_on AS ReadCommittedSnapshot, d.snapshot_isolation_state_desc AS SnapshotIsolation,
			       CAST(SERVERPROPERTY('ProductVersion') AS NVARCHAR(50)) AS ProductVersion,
			       CAST(SERVERPROPERTY('Edition') AS NVARCHAR(100)) AS Edition,
			       CONVERT(VARCHAR(19), GETDATE(), 126) AS ServerNow
			FROM sys.databases d WHERE d.name = DB_NAME()
		`));
		p('');
		p('- OPENJSON / FOR JSON need CompatibilityLevel ≥ 130; `CREATE OR ALTER` needs SQL Server 2016 SP1 (13.0.4001) or later.');
		p('- With ReadCommittedSnapshot = 1, an ERP save that reads MAX(MaxVoucherNo) does not wait for our uncommitted header, which widens the duplicate-number window the post-insert check covers.');
		p(`- ServerNow should be IST; compare with ${today} in Asia/Kolkata.`);
	});

	h(2, '1. Every column the module references');
	const missing = [];
	for (const [tableName, cols] of Object.entries(REFERENCED_COLUMNS)) {
		await safe(tableName, async () => {
			const existing = new Map((await columnsOf(tableName)).map((c) => [c.ColumnName.toLowerCase(), c]));
			if (!existing.size) {
				missing.push(`${tableName} (table not found)`);
				return;
			}
			for (const c of cols) if (!existing.has(c.toLowerCase())) missing.push(`${tableName}.${c}`);
		});
	}
	p(missing.length
		? `**Missing (${missing.length}) — fix the code or the ASSUMPTION before deploying:**\n\n${missing.map((m) => `- \`${m}\``).join('\n')}`
		: 'All referenced tables and columns exist.');

	for (const tableName of ['ItemTransactionMain', 'ItemTransactionDetail']) {
		h(2, `2. ${tableName}: columns, nullability, defaults`);
		await safe(tableName, async () => table(await columnsOf(tableName)));
	}
	h(3, 'Indexes on ItemTransactionMain');
	await safe('ITM indexes', async () => table(await q(`
		SELECT i.name AS IndexName, i.type_desc AS Type, i.is_unique AS IsUnique, i.has_filter AS HasFilter,
		       STUFF((SELECT ', ' + c.name + CASE WHEN ic.is_descending_key = 1 THEN ' DESC' ELSE '' END
		              FROM sys.index_columns ic JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
		              WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
		              ORDER BY ic.key_ordinal FOR XML PATH('')), 1, 2, '') AS KeyColumns,
		       STUFF((SELECT ', ' + c.name
		              FROM sys.index_columns ic JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
		              WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 1
		              FOR XML PATH('')), 1, 2, '') AS IncludedColumns
		FROM sys.indexes i
		WHERE i.object_id = OBJECT_ID('dbo.ItemTransactionMain') AND i.type > 0
		ORDER BY i.index_id
	`)));

	h(2, '3. WarehouseMaster (discovery item 2)');
	await safe('WarehouseMaster columns', async () => {
		p('Columns: ' + (await columnsOf('WarehouseMaster')).map((c) => `\`${c.ColumnName}\``).join(', '));
	});
	p('');
	p('Known: 13 and 17 are store bins in Panchla; 16 is Floor-Panchla / Paper.');
	await safe('WarehouseMaster rows', async () => table(await q(`
		SELECT * FROM dbo.WarehouseMaster WHERE WarehouseID IN (13, 16, 17) ORDER BY WarehouseID
	`)));
	p('');
	p('Every warehouse flagged as a floor warehouse:');
	await safe('Floor warehouses', async () => table(await q(`
		SELECT WarehouseID, WarehouseName, BinName, IsFloorWarehouse, IsDeleted, IsDeletedTransaction
		FROM dbo.WarehouseMaster
		WHERE CompanyID = @c AND ISNULL(IsFloorWarehouse, 0) = 1
		ORDER BY WarehouseName, BinName
	`, { c: [sql.Int, COMPANY_ID] })));

	h(2, '4. Master name columns (discovery item 3)');
	for (const tableName of ['DepartmentMaster', 'ProcessMaster', 'MachineMaster', 'LedgerMaster', 'UserMaster']) {
		await safe(tableName, async () => {
			const cols = await columnsOf(tableName);
			p(`- **${tableName}**: ${cols.map((c) => `\`${c.ColumnName}\``).join(', ') || '_(table not found)_'}`);
		});
	}
	p('');
	p('Department 100 (used by both captured issues) and the processes on the captured picklist line:');
	await safe('Department 100', async () => table(await q(`SELECT * FROM dbo.DepartmentMaster WHERE DepartmentID = 100`)));
	await safe('Process 10337', async () => table(await q(`SELECT * FROM dbo.ProcessMaster WHERE ProcessID = 10337`)));

	h(2, '5. Job tables (discovery items 4 and 5)');
	for (const tableName of ['JobBookingJobCard', 'JobBookingJobCardContents', 'JobBookingJobCardProcessMaterialRequirement']) {
		await safe(tableName, async () => {
			p(`- **${tableName}**: ${(await columnsOf(tableName)).map((c) => `\`${c.ColumnName}\``).join(', ')}`);
		});
	}
	p('');
	p('Job content J06482_26_27[1_1] (test B) and its material requirement:');
	await safe('Job content 23524', async () => table(await q(`
		SELECT JC.JobBookingJobCardContentsID, JC.JobBookingID, JC.JobCardContentNo, JC.PlanContName,
		       JB.JobBookingNo, JB.JobName, JB.ClientName, JB.OrderBookingID
		FROM dbo.JobBookingJobCardContents JC
		JOIN dbo.JobBookingJobCard JB ON JB.JobBookingID = JC.JobBookingID AND JB.CompanyID = JC.CompanyID
		WHERE JC.JobBookingJobCardContentsID = 23524
	`)));
	await safe('Requirement 23524', async () => table(await q(`
		SELECT JM.JobBookingID, JM.JobBookingJobCardContentsID, JM.ProcessID, JM.MachineID, JM.ItemID, IM.ItemCode,
		       IM.StockUnit, JM.RequiredQuantityInStockUnit, JM.RequiredQty, JM.SequenceNo
		FROM dbo.JobBookingJobCardProcessMaterialRequirement JM
		JOIN dbo.ItemMaster IM ON IM.ItemID = JM.ItemID AND IM.CompanyID = JM.CompanyID
		WHERE JM.JobBookingJobCardContentsID = 23524 AND ISNULL(JM.IsDeletedTransaction, 0) = 0
	`)));

	h(2, '6. Voucher numbering scope (discovery item 6)');
	p('FYear values on -19 vouchers (confirms the stored format):');
	await safe('FYear values', async () => table(await q(`
		SELECT TOP (5) FYear, COUNT(*) AS Vouchers, MIN(MaxVoucherNo) AS MinNo, MAX(MaxVoucherNo) AS MaxNo
		FROM dbo.ItemTransactionMain WHERE VoucherID = -19
		GROUP BY FYear ORDER BY MAX(TransactionID) DESC
	`)));
	p('');
	p(`Per company in ${fYear}:`);
	await safe('Per company', async () => table(await q(`
		SELECT CompanyID, COUNT(*) AS Vouchers, MIN(MaxVoucherNo) AS MinNo, MAX(MaxVoucherNo) AS MaxNo,
		       SUM(CASE WHEN ISNULL(IsDeletedTransaction, 0) = 1 THEN 1 ELSE 0 END) AS Deleted
		FROM dbo.ItemTransactionMain WHERE VoucherID = -19 AND FYear = @f
		GROUP BY CompanyID ORDER BY CompanyID
	`, { f: [sql.NVarChar(20), fYear] })));
	p('');
	p('(a) The same MaxVoucherNo in more than one CompanyID:');
	await safe('Across companies', async () => table(await q(`
		SELECT TOP (20) MaxVoucherNo, COUNT(DISTINCT CompanyID) AS Companies, COUNT(*) AS Vouchers
		FROM dbo.ItemTransactionMain WHERE VoucherID = -19 AND FYear = @f
		GROUP BY MaxVoucherNo HAVING COUNT(DISTINCT CompanyID) > 1 ORDER BY MaxVoucherNo DESC
	`, { f: [sql.NVarChar(20), fYear] })));
	p('');
	p('(b) The same MaxVoucherNo on both a deleted and a live voucher (same company):');
	await safe('Deleted and live', async () => table(await q(`
		SELECT TOP (20) CompanyID, MaxVoucherNo, COUNT(*) AS Vouchers
		FROM dbo.ItemTransactionMain WHERE VoucherID = -19 AND FYear = @f
		GROUP BY CompanyID, MaxVoucherNo
		HAVING MIN(ISNULL(CAST(IsDeletedTransaction AS INT), 0)) = 0 AND MAX(ISNULL(CAST(IsDeletedTransaction AS INT), 0)) = 1
		ORDER BY MaxVoucherNo DESC
	`, { f: [sql.NVarChar(20), fYear] })));
	p('');
	p('Any duplicate MaxVoucherNo at all within one company (should be none):');
	await safe('Duplicates', async () => table(await q(`
		SELECT TOP (20) CompanyID, MaxVoucherNo, COUNT(*) AS Vouchers
		FROM dbo.ItemTransactionMain WHERE VoucherID = -19 AND FYear = @f
		GROUP BY CompanyID, MaxVoucherNo HAVING COUNT(*) > 1 ORDER BY MaxVoucherNo DESC
	`, { f: [sql.NVarChar(20), fYear] })));
	p('');
	p('Decision: if (a) has rows, numbering is shared across companies — keep `@NumberPerCompany = 0`. If there is only one company, or (a) is empty while several companies have overlapping ranges, numbering is per company — set `@NumberPerCompany = 1` in `002_usp_IssueTool_PostIssue.sql`. (b) having rows would mean the ERP reuses deleted numbers; the procedure assumes it does not.');

	h(2, '7. Template vouchers (discovery item 7)');
	const hasLog = (await q(`SELECT OBJECT_ID('dbo.IssueTool_PostLog', 'U') AS Id`))[0]?.Id;
	const notOurs = hasLog
		? 'AND NOT EXISTS (SELECT 1 FROM dbo.IssueTool_PostLog L WHERE L.TransactionID = M.TransactionID)'
		: '';
	const itmCols = new Map((await columnsOf('ItemTransactionMain')).map((c) => [c.ColumnName, c]));
	const itdCols = new Map((await columnsOf('ItemTransactionDetail')).map((c) => [c.ColumnName, c]));

	for (const kind of [
		{ label: 'Allocated (lines carry PicklistTransactionID)', cond: 'ISNULL(D.PicklistTransactionID, 0) <> 0' },
		{ label: 'Direct (no PicklistTransactionID)', cond: 'ISNULL(D.PicklistTransactionID, 0) = 0' },
	]) {
		h(3, kind.label);
		await safe(kind.label, async () => {
			const pick = await q(`
				SELECT TOP (1) M.TransactionID
				FROM dbo.ItemTransactionMain M
				WHERE M.VoucherID = -19 AND M.CompanyID = @c AND ISNULL(M.IsDeletedTransaction, 0) = 0
				  AND EXISTS (SELECT 1 FROM dbo.ItemTransactionDetail D WHERE D.TransactionID = M.TransactionID AND ${kind.cond})
				  ${kind.cond.includes('= 0') ? 'AND NOT EXISTS (SELECT 1 FROM dbo.ItemTransactionDetail D WHERE D.TransactionID = M.TransactionID AND ISNULL(D.PicklistTransactionID, 0) <> 0)' : ''}
				  ${notOurs}
				ORDER BY M.TransactionID DESC
			`, { c: [sql.Int, COMPANY_ID] });
			const id = pick[0]?.TransactionID;
			if (!id) {
				p('_No ERP-created voucher of this kind found._');
				return;
			}
			const header = (await q(`SELECT * FROM dbo.ItemTransactionMain WHERE TransactionID = @id`, { id: [sql.Int, id] }))[0];
			const lines = await q(`SELECT * FROM dbo.ItemTransactionDetail WHERE TransactionID = @id ORDER BY TransID`, { id: [sql.Int, id] });
			p(`TransactionID **${id}**, ${show(header.VoucherNo)}, ${lines.length} line(s).`);

			p('');
			p('**Header**, every column:');
			table(Object.entries(header).map(([column, value]) => ({ column, value, written: POST_HEADER_COLUMNS.includes(column) ? 'yes' : '' })));
			p('');
			p('**Lines**, every column:');
			table(Object.keys(lines[0] || {}).map((column) => ({
				column,
				...Object.fromEntries(lines.map((l, i) => [`TransID ${l.TransID ?? i + 1}`, l[column]])),
				written: POST_LINE_COLUMNS.includes(column) ? 'yes' : '',
			})));

			p('');
			p('**TEMPLATE gaps** — columns the procedure does not write where this ERP voucher holds something other than the column default. Each needs a decision before the first real post: add it to the INSERT in `002_usp_IssueTool_PostIssue.sql` with the ERP\'s value, or note why it differs.');
			const gaps = [];
			for (const [column, value] of Object.entries(header)) {
				if (!POST_HEADER_COLUMNS.includes(column) && !itmCols.get(column)?.IsIdentity && !sameAsDefault(value, itmCols.get(column))) {
					gaps.push({ table: 'ItemTransactionMain', column, value, default: itmCols.get(column)?.DefaultValue ?? null });
				}
			}
			for (const column of Object.keys(lines[0] || {})) {
				if (POST_LINE_COLUMNS.includes(column) || itdCols.get(column)?.IsIdentity) continue;
				const values = [...new Set(lines.map((l) => show(l[column])))];
				if (!lines.every((l) => sameAsDefault(l[column], itdCols.get(column)))) {
					gaps.push({ table: 'ItemTransactionDetail', column, value: values.join(' / '), default: itdCols.get(column)?.DefaultValue ?? null });
				}
			}
			table(gaps, ['table', 'column', 'value', 'default']);

			p('');
			p('**Blank strings** on this voucher (decides `@Blank` in the procedure):');
			const blanks = [];
			for (const [column, value] of Object.entries(header)) {
				if (typeof value === 'string' && value.trim() === '') blanks.push({ table: 'ITM', column, value });
				if (value === null && /char/i.test(itmCols.get(column)?.DataType ?? '')) blanks.push({ table: 'ITM', column, value });
			}
			table(blanks, ['table', 'column', 'value']);
		});
	}

	h(2, '8. Acceptance-test source rows (brief section 8)');
	await safe('Picklist line 109873', async () => table(await q(`
		SELECT P.TransactionDetailID, P.TransactionID, PM.VoucherNo, P.ItemID, P.RequiredQuantity, P.JobBookingID,
		       P.JobBookingJobCardContentsID, P.MachineID, P.DepartmentID, P.ProcessID, P.IsCompleted
		FROM dbo.ItemTransactionDetail P JOIN dbo.ItemTransactionMain PM ON PM.TransactionID = P.TransactionID
		WHERE P.TransactionDetailID = 109873
	`)));
	p('');
	p('The captured ERP test vouchers (deleted afterwards):');
	await safe('Test vouchers', async () => table(await q(`
		SELECT TransactionID, VoucherNo, MaxVoucherNo, FYear, CompanyID, IsDeletedTransaction, DeletedBy, DeletedDate,
		       DepartmentID, JobBookingID, JobBookingJobCardContentsID, TotalQuantity, DeliveryNoteNo
		FROM dbo.ItemTransactionMain
		WHERE VoucherID = -19 AND VoucherNo IN ('IS17252_26_27', 'IS17254_26_27')
	`)));
	p('');
	p('Batch total against ItemMaster.PhysicalStock for the two test items (should be equal):');
	await safe('Stock check', async () => table(await q(`
		SELECT IM.ItemID, IM.ItemCode, IM.StockUnit, IM.PhysicalStock, IM.FloorStock, B.BatchTotal
		FROM dbo.ItemMaster IM
		OUTER APPLY (
			SELECT SUM(G.Stock) AS BatchTotal FROM (
				SELECT SUM(ISNULL(D.ReceiptQuantity, 0) - ISNULL(D.IssueQuantity, 0) - ISNULL(D.RejectedQuantity, 0)) AS Stock
				FROM dbo.ItemTransactionDetail D JOIN dbo.ItemTransactionMain M ON M.TransactionID = D.TransactionID
				WHERE D.ItemID = IM.ItemID AND D.CompanyID = IM.CompanyID
				  AND ISNULL(D.IsDeletedTransaction, 0) = 0 AND ISNULL(D.IsCancelled, 0) = 0
				  AND ISNULL(M.IsDeletedTransaction, 0) = 0 AND M.VoucherID NOT IN (-8, -9, -11)
				GROUP BY ISNULL(D.ParentTransactionID, 0), ISNULL(D.WarehouseID, 0), NULLIF(D.BatchNo, '')
				HAVING SUM(ISNULL(D.ReceiptQuantity, 0) - ISNULL(D.IssueQuantity, 0) - ISNULL(D.RejectedQuantity, 0)) > 0
			) G
		) B
		WHERE IM.ItemID IN (9409, 9681) AND IM.CompanyID = @c
	`, { c: [sql.Int, COMPANY_ID] })));

	h(2, '9. Procedures');
	await safe('UPDATE_ITEM_STOCK_VALUES parameters', async () => {
		p('Parameters of `dbo.UPDATE_ITEM_STOCK_VALUES`:');
		table(await q(`
			SELECT name AS Parameter, TYPE_NAME(user_type_id) AS DataType, is_output AS IsOutput
			FROM sys.parameters WHERE object_id = OBJECT_ID('dbo.UPDATE_ITEM_STOCK_VALUES') ORDER BY parameter_id
		`));
	});
	p('');
	await safe('Module objects', async () => {
		p('This module\'s objects (deployed yet?):');
		table(await q(`
			SELECT n.name AS ObjectName, OBJECT_ID('dbo.' + n.name) AS ObjectId
			FROM (VALUES ('IssueTool_PostLog'), ('usp_IssueTool_PostIssue'), ('usp_IssueTool_DeleteIssue')) n(name)
		`));
	});

	fs.writeFileSync(OUT, `${out.join('\n')}\n`);
	console.log(`Wrote ${OUT}`);
	if (missing.length) console.log(`${missing.length} referenced column(s) are missing — see section 1.`);
}

main()
	.catch((err) => {
		console.error('Discovery failed:', err);
		process.exitCode = 1;
	})
	.finally(() => closeAllPools().catch(() => {}));
