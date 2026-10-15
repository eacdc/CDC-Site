/**
 * Stock Issue Tool — acceptance tests A and B, in dry run (brief section 8).
 *
 * Rebuilds the two issues captured on 3 Oct 2026 through
 * dbo.usp_IssueTool_PostIssue with @DryRun = 1, then checks the would-be rows
 *
 *   1. against the values the brief confirms, field by field, and
 *   2. against the ERP's own vouchers for the same issues (IS17252_26_27 and
 *      IS17254_26_27, deleted after the capture), column by column, ignoring
 *      identity, number, timestamp and deletion columns.
 *
 * Every write happens inside a transaction that the procedure rolls back, so
 * nothing is saved — but the procedure must already be deployed
 * (sql/issue-tool/001–003). It does not need ISSUE_TOOL_ALLOW_WRITES.
 *
 * The batches have been issued from since the capture, so batch-stock warnings
 * are expected; they are acknowledged and printed.
 *
 * Run from the backend folder:
 *   npm run issue-tool:acceptance
 *   node scripts/issue-tool-acceptance.js --site KOL --company 2 --user 24
 */

import dotenv from 'dotenv';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { getPool, closeAllPools, sql } = await import('../src/db.js');
const { compareVouchers, formatComparison, checkExpectations, show, DELETION_COLUMNS } = await import('../src/issue-tool/compare.js');
const { POST_PROC } = await import('../src/issue-tool/config.js');

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SITE = arg('site', 'KOL').toUpperCase();
const COMPANY_ID = Number(arg('company', 2));
const USER_ID = Number(arg('user', 24));

const COMMON_HEADER = {
	VoucherID: -19,
	VoucherPrefix: 'IS',
	VoucherDate: '2026-10-03T00:00:00',
	CompanyID: COMPANY_ID,
	FYear: '2026-2027',
	UserID: USER_ID,
	CreatedBy: USER_ID,
	ModifiedBy: USER_ID,
};

const COMMON_LINE = {
	FloorWarehouseID: 16,
	PicklistReleaseTransactionID: 0,
	CompanyID: COMPANY_ID,
	FYear: '2026-2027',
	UserID: USER_ID,
	CreatedBy: USER_ID,
	ModifiedBy: USER_ID,
};

const TESTS = [
	{
		name: 'A. Allocated issue across two batches',
		erpVoucherNo: 'IS17252_26_27',
		params: {
			Mode: 'ALLOCATED',
			PicklistDetailID: 109873,
			FloorWarehouseID: 16,
			lines: [
				{ itemId: 9409, parentTransactionId: 60325, warehouseId: 17, batchNo: '60325_PO02095_26_27_9409_1.00', quantity: 1500 },
				{ itemId: 9409, parentTransactionId: 61902, warehouseId: 17, batchNo: '61902_PO02095_26_27_9409_2.00', quantity: 1458 },
			],
		},
		header: {
			...COMMON_HEADER,
			DepartmentID: 100,
			JobBookingID: 16077,
			JobBookingJobCardContentsID: 24188,
			TotalQuantity: 2958,
			DeliveryNoteNo: ' ',   // one space, as on the ERP's IS17252
			Narration: '',
		},
		lines: {
			1: { IssueQuantity: 1500, ParentTransactionID: 60325, BatchID: 101864, BatchNo: '60325_PO02095_26_27_9409_1.00', WarehouseID: 17 },
			2: { IssueQuantity: 1458, ParentTransactionID: 61902, BatchID: 104789, BatchNo: '61902_PO02095_26_27_9409_2.00', WarehouseID: 17 },
		},
		everyLine: {
			...COMMON_LINE,
			ItemID: 9409,
			ItemGroupID: 14,
			StockUnit: 'Sheet',
			JobBookingID: 16077,
			JobBookingJobCardContentsID: 24188,
			PicklistTransactionID: 64534,
			MachineID: 14,
			DepartmentID: 100,
			ProcessID: 10337,
		},
	},
	{
		name: 'B. Direct issue of a substitute item',
		erpVoucherNo: 'IS17254_26_27',
		params: {
			Mode: 'DIRECT',
			JobContentID: 23524,
			DepartmentID: 100,
			SlipNo: 'IS17253_26_27',
			FloorWarehouseID: 16,
			lines: [
				{ itemId: 9681, parentTransactionId: 52873, warehouseId: 13, batchNo: '52873_PO01565_26_27_9681_1.00', quantity: 152 },
			],
		},
		header: {
			...COMMON_HEADER,
			DepartmentID: 100,
			JobBookingID: 0,
			JobBookingJobCardContentsID: 23524,
			TotalQuantity: 152,
			DeliveryNoteNo: 'IS17253_26_27',
			Narration: '',
		},
		lines: {
			1: { IssueQuantity: 152, ParentTransactionID: 52873, BatchID: 87880, BatchNo: '52873_PO01565_26_27_9681_1.00', WarehouseID: 13 },
		},
		everyLine: {
			...COMMON_LINE,
			ItemID: 9681,
			ItemGroupID: 2,
			StockUnit: 'Kg',
			JobBookingID: 15607,
			JobBookingJobCardContentsID: 23524,
			PicklistTransactionID: 0,
			MachineID: 0,
			DepartmentID: 0,
			ProcessID: 0,
		},
	},
];

async function dryRun(pool, test) {
	const requestId = crypto.randomUUID();
	const { lines, ...rest } = test.params;
	const result = await pool.request()
		.input('CompanyID', sql.Int, COMPANY_ID)
		.input('UserID', sql.Int, USER_ID)
		.input('VoucherDate', sql.Date, '2026-10-03')
		.input('Mode', sql.VarChar(10), rest.Mode)
		.input('PicklistDetailID', sql.BigInt, rest.PicklistDetailID ?? null)
		.input('JobContentID', sql.BigInt, rest.JobContentID ?? null)
		.input('DepartmentID', sql.BigInt, rest.DepartmentID ?? null)
		.input('SlipNo', sql.NVarChar(100), rest.SlipNo ?? null)
		.input('FloorWarehouseID', sql.BigInt, rest.FloorWarehouseID)
		.input('Remark', sql.NVarChar(500), null)
		.input('LinesJson', sql.NVarChar(sql.MAX), JSON.stringify(lines))
		.input('RequestID', sql.UniqueIdentifier, requestId)
		.input('PayloadJson', sql.NVarChar(sql.MAX), JSON.stringify({ acceptance: test.name, ...test.params }))
		.input('AcknowledgeWarnings', sql.Bit, 1)
		.input('DryRun', sql.Bit, 1)
		.execute(POST_PROC);
	const [[status], warnings] = result.recordsets;
	if (status?.Status !== 'DRY_RUN') throw new Error(`Expected a DRY_RUN status, got ${status?.Status}.`);
	return {
		status,
		warnings,
		header: JSON.parse(status.DryRunHeaderJson),
		lines: JSON.parse(status.DryRunLinesJson),
		rfs: {
			header: status.DryRunRfsHeaderJson ? JSON.parse(status.DryRunRfsHeaderJson) : null,
			lines: status.DryRunRfsLinesJson ? JSON.parse(status.DryRunRfsLinesJson) : [],
		},
	};
}

/** The floor receipt (RFS, -53) the ERP wrote with an issue, deleted or not. */
async function erpFloorReceipt(pool, issueTransactionId) {
	const header = (await pool.request()
		.input('id', sql.BigInt, issueTransactionId)
		.input('c', sql.Int, COMPANY_ID)
		.query(`SELECT TOP (1) * FROM dbo.ItemConsumptionMain
		        WHERE ReturnTransactionID = @id AND VoucherID = -53 AND CompanyID = @c
		        ORDER BY ConsumptionTransactionID`)).recordset[0];
	if (!header) return null;
	const lines = (await pool.request().input('id', sql.BigInt, header.ConsumptionTransactionID)
		.query('SELECT * FROM dbo.ItemConsumptionDetail WHERE ConsumptionTransactionID = @id ORDER BY TransID')).recordset;
	return { header, lines };
}

/** Columns that point at rows whose IDs differ between a dry run and the ERP's voucher. */
const RFS_ID_COLUMNS = ['ConsumptionTransactionID', 'ConsumptionTransactionDetailID', 'ReturnTransactionID', 'IssueTransactionID'];

async function erpVoucher(pool, voucherNo) {
	const header = (await pool.request()
		.input('no', sql.NVarChar(50), voucherNo)
		.input('c', sql.Int, COMPANY_ID)
		.query(`SELECT TOP (1) * FROM dbo.ItemTransactionMain
		        WHERE VoucherID = -19 AND VoucherNo = @no AND CompanyID = @c AND FYear = '2026-2027'
		        ORDER BY TransactionID DESC`)).recordset[0];
	if (!header) return null;
	const lines = (await pool.request().input('id', sql.Int, header.TransactionID)
		.query('SELECT * FROM dbo.ItemTransactionDetail WHERE TransactionID = @id ORDER BY TransID')).recordset;
	return { header, lines };
}

async function main() {
	const pool = await getPool(SITE);
	let failed = 0;

	for (const test of TESTS) {
		console.log(`\n=== ${test.name} ===`);
		const run = await dryRun(pool, test);
		console.log(`Would have been ${run.status.VoucherNo} (MaxVoucherNo ${run.status.MaxVoucherNo}, FYear ${run.status.FYear}, attempts ${run.status.Attempts}). Rolled back.`);
		for (const w of run.warnings) console.log(`  warning ${w.Code}: ${w.Message}`);

		const problems = [];
		for (const f of checkExpectations(run.header, test.header)) problems.push(`header.${f.column}: expected ${show(f.expected)}, got ${show(f.actual)}`);
		if (run.lines.length !== Object.keys(test.lines).length) {
			problems.push(`expected ${Object.keys(test.lines).length} line(s), got ${run.lines.length}`);
		}
		for (const line of run.lines) {
			const expected = { ...test.everyLine, ...(test.lines[line.TransID] ?? {}) };
			for (const f of checkExpectations(line, expected)) {
				problems.push(`line ${line.TransID}.${f.column}: expected ${show(f.expected)}, got ${show(f.actual)}`);
			}
		}
		console.log(problems.length ? `Brief expectations: ${problems.length} FAILED` : 'Brief expectations: all passed');
		for (const msg of problems) console.log(`    ${msg}`);

		const erp = await erpVoucher(pool, test.erpVoucherNo);
		if (!erp) {
			console.log(`ERP voucher ${test.erpVoucherNo} not found, so the column-by-column comparison was skipped.`);
		} else {
			console.log(`Against the ERP's ${test.erpVoucherNo} (TransactionID ${erp.header.TransactionID}, deleted columns ignored):`);
			const result = compareVouchers(run, erp, { ignore: DELETION_COLUMNS });
			console.log(formatComparison(result, { oursLabel: 'dry-run', theirsLabel: 'erp' }));
			if (!result.identical) failed += 1;

			// The floor receipt that goes with the issue.
			const rfsProblems = [];
			if (!run.rfs.header) rfsProblems.push('the dry run wrote no floor receipt (RFS)');
			else {
				if (Number(run.rfs.header.ReturnTransactionID) !== Number(run.header.TransactionID)) {
					rfsProblems.push('RFS header ReturnTransactionID does not point at the issue');
				}
				for (const l of run.rfs.lines) {
					const issueLine = run.lines.find((x) => x.TransID === l.TransID);
					if (Number(l.IssueTransactionID) !== Number(run.header.TransactionID)) rfsProblems.push(`RFS line ${l.TransID}: IssueTransactionID does not point at the issue`);
					if (!issueLine || Number(l.ReceivedQuantity) !== Number(issueLine.IssueQuantity)) rfsProblems.push(`RFS line ${l.TransID}: ReceivedQuantity differs from the issue line`);
				}
				if (run.rfs.lines.length !== run.lines.length) rfsProblems.push(`RFS has ${run.rfs.lines.length} line(s), the issue ${run.lines.length}`);
			}
			for (const msg of rfsProblems) console.log(`    ${msg}`);
			if (rfsProblems.length) failed += 1;

			const erpRfs = await erpFloorReceipt(pool, erp.header.TransactionID);
			if (!erpRfs) {
				console.log('  No ERP floor receipt found for this issue, so its comparison was skipped.');
			} else if (run.rfs.header) {
				console.log(`Floor receipt against the ERP's ${erpRfs.header.VoucherNo} (deleted columns ignored):`);
				const rfsResult = compareVouchers(run.rfs, erpRfs, { ignore: [...DELETION_COLUMNS, ...RFS_ID_COLUMNS] });
				console.log(formatComparison(rfsResult, { oursLabel: 'dry-run', theirsLabel: 'erp' }));
				if (!rfsResult.identical) failed += 1;
			}
		}
		if (problems.length) failed += 1;
	}

	console.log(failed ? `\n${failed} check group(s) failed.` : '\nAcceptance tests A and B pass.');
	process.exitCode = failed ? 1 : 0;
}

main()
	.catch((err) => {
		console.error('Acceptance run failed:', err.message);
		process.exitCode = 2;
	})
	.finally(() => closeAllPools().catch(() => {}));
