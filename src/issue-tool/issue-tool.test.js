import { test } from 'node:test';
import assert from 'node:assert/strict';

import { todayInKolkata, addDays, daysBetween, financialYear, toIsoDate } from './dates.js';
import { parse, postIssueBody, picklistsQuery, itemsQuery } from './schemas.js';
import { ApiError, fromSqlError } from './errors.js';
import { interpretPostResult, dryRunReason } from './services/issues.js';
import { buildRequirements } from './queries/job-contents.js';
import { mergeItems } from './queries/items.js';
import { groupWarehouses } from './queries/lookups.js';
import { assembleIssues } from './queries/issues.js';
import { likePattern, inList, bigIntsToNumbers, sql } from './db.js';
import { companyIdFor } from './config.js';
import { pickUser, verifyToken } from './auth.js';
import jwt from 'jsonwebtoken';
import { loginBody } from './schemas.js';
import { compareVouchers, checkExpectations, normalise } from './compare.js';

// ── dates ───────────────────────────────────────────────────────────────────

test('today is computed in India, not in the server timezone', () => {
	// 20:00 UTC on 4 Oct is 01:30 IST on 5 Oct.
	assert.equal(todayInKolkata(new Date('2026-10-04T20:00:00Z')), '2026-10-05');
	assert.equal(todayInKolkata(new Date('2026-10-04T18:00:00Z')), '2026-10-04');
});

test('financial year runs April to March', () => {
	assert.deepEqual(financialYear('2026-10-03'), { fYear: '2026-2027', suffix: '_26_27' });
	assert.deepEqual(financialYear('2027-03-31'), { fYear: '2026-2027', suffix: '_26_27' });
	assert.deepEqual(financialYear('2027-04-01'), { fYear: '2027-2028', suffix: '_27_28' });
});

test('date helpers', () => {
	assert.equal(addDays('2026-10-01', -3), '2026-09-28');
	assert.equal(daysBetween('2026-09-28', '2026-10-01'), 3);
	assert.equal(toIsoDate(new Date('2026-10-03T00:00:00Z')), '2026-10-03');
});

// ── validation ──────────────────────────────────────────────────────────────

const allocated = {
	mode: 'ALLOCATED',
	requestId: '3f2b8a52-6c1d-4a8e-9f0b-1d2c3e4f5a6b',
	voucherDate: '2026-10-03',
	picklistDetailId: 109873,
	floorWarehouseId: 16,
	lines: [
		{ itemId: 9409, parentTransactionId: 60325, warehouseId: 17, batchNo: '60325_PO02095_26_27_9409_1.00', quantity: 1500 },
		{ itemId: 9409, parentTransactionId: 61902, warehouseId: 17, batchNo: '61902_PO02095_26_27_9409_2.00', quantity: 1458 },
	],
};

test('a valid allocated issue parses, with dryRun and acknowledgeWarnings defaulted', () => {
	const body = parse(postIssueBody, allocated);
	assert.equal(body.dryRun, false);
	assert.equal(body.acknowledgeWarnings, false);
	assert.equal(body.lines.length, 2);
});

test('hard validation errors are 400 VALIDATION_FAILED with every field listed', () => {
	const bad = { ...allocated, picklistDetailId: undefined, lines: [{ ...allocated.lines[0], quantity: 0 }] };
	assert.throws(() => parse(postIssueBody, bad), (err) => {
		assert.ok(err instanceof ApiError);
		assert.equal(err.status, 400);
		assert.equal(err.code, 'VALIDATION_FAILED');
		const paths = err.extra.details.map((d) => d.path);
		assert.ok(paths.includes('picklistDetailId'));
		assert.ok(paths.includes('lines.0.quantity'));
		return true;
	});
});

test('no lines, negative quantity, missing floor warehouse and bad request id are rejected', () => {
	assert.throws(() => parse(postIssueBody, { ...allocated, lines: [] }), ApiError);
	assert.throws(() => parse(postIssueBody, { ...allocated, lines: [{ ...allocated.lines[0], quantity: -5 }] }), ApiError);
	assert.throws(() => parse(postIssueBody, { ...allocated, floorWarehouseId: undefined }), ApiError);
	assert.throws(() => parse(postIssueBody, { ...allocated, requestId: 'not-a-uuid' }), ApiError);
	assert.throws(() => parse(postIssueBody, { ...allocated, lines: [{ ...allocated.lines[0], quantity: '12' }] }), ApiError);
});

test('a direct issue needs a job content and a department', () => {
	const direct = { ...allocated, mode: 'DIRECT', picklistDetailId: undefined };
	assert.throws(() => parse(postIssueBody, direct), (err) => {
		const paths = err.extra.details.map((d) => d.path);
		return paths.includes('jobContentId') && paths.includes('departmentId');
	});
	assert.ok(parse(postIssueBody, { ...direct, jobContentId: 23524, departmentId: 100 }));
});

test('query strings coerce and default', () => {
	assert.deepEqual(parse(picklistsQuery, { page: '2', showFullyIssued: 'true' }),
		{ search: '', page: 2, pageSize: 50, showFullyIssued: true });
	assert.equal(parse(picklistsQuery, {}).showFullyIssued, false);
	assert.throws(() => parse(itemsQuery, { search: 'a' }), ApiError);
	assert.deepEqual(parse(itemsQuery, { jobContentId: '23524' }), { search: '', jobContentId: 23524 });
});

// ── procedure results ───────────────────────────────────────────────────────

test('procedure errors 51xxx become coded API errors', () => {
	const err = Object.assign(new Error('BATCH_NOT_OF_ITEM: Line 2 uses a batch that does not belong to its item.'), { number: 51005 });
	const api = fromSqlError(err);
	assert.equal(api.status, 400);
	assert.equal(api.code, 'BATCH_NOT_OF_ITEM');
	assert.match(api.message, /^Line 2/);

	const conflict = fromSqlError(Object.assign(new Error('VOUCHER_NUMBER_CONFLICT: x'), { number: 51091 }));
	assert.equal(conflict.status, 409);
	assert.equal(fromSqlError(Object.assign(new Error('Deadlock'), { number: 1205 })), null);
});

const warningRow = {
	Code: 'OVER_BATCH_STOCK', LineNum: 1, ItemID: 9681, Quantity: 152, Limit: 100, StockUnit: 'Kg', Message: 'Line 1 takes 152 Kg…',
};

test('warnings without acknowledgement are a 409 carrying the warnings', () => {
	const recordsets = [[{ Status: 'WARNINGS', VoucherDate: new Date('2026-10-03T00:00:00Z') }], [warningRow], []];
	assert.throws(() => interpretPostResult(recordsets, { dryRunReason: null }), (err) => {
		assert.equal(err.status, 409);
		assert.equal(err.code, 'WARNINGS_NOT_ACKNOWLEDGED');
		assert.deepEqual(err.extra.warnings[0], {
			code: 'OVER_BATCH_STOCK', lineNo: 1, itemId: 9681, quantity: 152, limit: 100, stockUnit: 'Kg', message: 'Line 1 takes 152 Kg…',
		});
		return true;
	});
});

test('a dry run returns the would-be rows and never a transaction id', () => {
	const header = { VoucherNo: 'IS17252_26_27', TotalQuantity: 2958 };
	const lines = [{ TransID: 1, IssueQuantity: 1500 }, { TransID: 2, IssueQuantity: 1458 }];
	const out = interpretPostResult([
		[{ Status: 'DRY_RUN', TransactionID: null, VoucherNo: 'IS17252_26_27', FYear: '2026-2027',
			VoucherDate: new Date('2026-10-03T00:00:00Z'), DryRunHeaderJson: JSON.stringify(header), DryRunLinesJson: JSON.stringify(lines) }],
		[], [{ TransID: 1, TransactionDetailID: 5 }],
	], { dryRunReason: 'WRITES_DISABLED' });
	assert.equal(out.status, 'DRY_RUN');
	assert.equal(out.dryRun, true);
	assert.equal(out.dryRunReason, 'WRITES_DISABLED');
	assert.equal(out.transactionId, undefined);
	assert.equal(out.voucherNo, undefined);
	assert.deepEqual(out.wouldWrite, { header, lines });
});

test('a posted or replayed issue returns the voucher number and line ids', () => {
	const sets = (status) => [
		[{ Status: status, TransactionID: 70001, VoucherNo: 'IS17255_26_27', FYear: '2026-2027', VoucherDate: new Date('2026-10-05T00:00:00Z') }],
		[], [{ TransID: 1, TransactionDetailID: 120001 }],
	];
	const posted = interpretPostResult(sets('POSTED'), { dryRunReason: null });
	assert.equal(posted.status, 'POSTED');
	assert.equal(posted.replayed, false);
	assert.equal(posted.voucherNo, 'IS17255_26_27');
	assert.equal(posted.voucherDate, '2026-10-05');
	assert.deepEqual(posted.lines, [{ transId: 1, transactionDetailId: 120001 }]);
	assert.equal(interpretPostResult(sets('REPLAYED'), { dryRunReason: null }).replayed, true);
});

test('writes disabled always wins over a client asking for a real post', () => {
	assert.equal(dryRunReason({ requested: false, allowWrites: false }), 'WRITES_DISABLED');
	assert.equal(dryRunReason({ requested: true, allowWrites: true }), 'REQUESTED');
	assert.equal(dryRunReason({ requested: false, allowWrites: true }), null);
});

// ── read-side shaping ───────────────────────────────────────────────────────

const plannedR01312 = {
	JobBookingJobCardContentsID: 23524, RequiredQuantity: 68.84,
	ItemID: 9001, ItemCode: 'R01312', ItemName: 'Reel A', ItemGroupID: 2, ItemGroupName: 'REEL',
	Quality: 'Kraft', GSM: 120, SizeW: 1000, SizeL: null, Manufacturer: 'Mill A', StockUnit: 'Kg', PhysicalStock: 500,
};

test('a substitute counts against the job requirement of its item group and unit', () => {
	const issued = [
		// 20 KG of the substitute already issued; casing differs from the plan.
		{ JobBookingJobCardContentsID: 23524, ItemID: 9681, ItemGroupID: 2, StockUnit: 'KG', IssuedQuantity: 20 },
	];
	const req = buildRequirements([plannedR01312], issued).get(23524);
	assert.equal(req.plannedItems[0].required, 68.84);
	assert.equal(req.plannedItems[0].issued, 0);      // the planned item itself has none
	assert.equal(req.plannedItems[0].pending, 68.84);
	assert.deepEqual(req.requirementGroups, [
		{ itemGroupId: 2, stockUnit: 'Kg', required: 68.84, issued: 20, pending: 48.84 },
	]);

	const merged = mergeItems(req, [
		{ itemId: 9681, itemCode: 'R01175', itemGroupId: 2, stockUnit: 'Kg' },
		{ itemId: 9001, itemCode: 'R01312', itemGroupId: 2, stockUnit: 'Kg' },
		{ itemId: 7000, itemCode: 'P1', itemGroupId: 14, stockUnit: 'Sheet' },
	]);
	assert.deepEqual(merged.map((i) => [i.itemCode, i.planned, i.pendingForJob]), [
		['R01312', true, 48.84],
		['R01175', false, 48.84],
		['P1', false, 0],
	]);
});

test('floor warehouses group bins under their warehouse', () => {
	assert.deepEqual(groupWarehouses([
		{ WarehouseID: 16, WarehouseName: 'Floor-Panchla', BinName: 'Paper' },
		{ WarehouseID: 18, WarehouseName: 'Floor-Panchla', BinName: 'Board' },
		{ WarehouseID: 20, WarehouseName: 'Floor-Tangra', BinName: null },
	]), [
		{ warehouseName: 'Floor-Panchla', bins: [{ warehouseId: 16, binName: 'Paper' }, { warehouseId: 18, binName: 'Board' }] },
		{ warehouseName: 'Floor-Tangra', bins: [{ warehouseId: 20, binName: '(no bin)' }] },
	]);
});

test('history marks mode from the lines and blocks delete when consumed', () => {
	const rows = assembleIssues(
		[
			{ TransactionID: 1, VoucherNo: 'IS1', VoucherDate: new Date('2026-10-03T00:00:00Z'), IsConsumed: 0, CreatedByIssueTool: 1, CreatedDate: new Date('2026-10-03T11:15:00Z') },
			{ TransactionID: 2, VoucherNo: 'IS2', VoucherDate: new Date('2026-10-03T00:00:00Z'), IsConsumed: 1, CreatedByIssueTool: 0 },
		],
		[
			{ TransactionID: 1, TransID: 1, PicklistTransactionID: 64534, IssueQuantity: 1500, ItemID: 9409, StockUnit: 'Sheet' },
			{ TransactionID: 2, TransID: 1, PicklistTransactionID: 0, IssueQuantity: 152, ItemID: 9681, StockUnit: 'Kg' },
		],
	);
	assert.equal(rows[0].mode, 'ALLOCATED');
	assert.equal(rows[0].canDelete, true);
	assert.equal(rows[0].createdByIssueTool, true);
	assert.equal(rows[0].createdDate, '2026-10-03T11:15:00');
	assert.equal(rows[1].mode, 'DIRECT');
	assert.equal(rows[1].canDelete, false);
	assert.equal(rows[1].lines[0].picklistTransactionId, null);
});

// ── helpers ─────────────────────────────────────────────────────────────────

test('LIKE patterns escape wildcards, IN lists are parameterised', () => {
	assert.equal(likePattern('J06482_26'), '%J06482\\_26%');
	assert.equal(likePattern('50%[a]'), '%50\\%\\[a]%');
	const list = inList('c', [1, 2]);
	assert.equal(list.sql, '@c0, @c1');
	assert.deepEqual(Object.keys(list.params), ['c0', 'c1']);
	assert.equal(inList('c', []).sql, 'NULL');
});

test('company id comes from config, per site when overridden', () => {
	const saved = { ...process.env };
	delete process.env.ISSUE_TOOL_COMPANY_ID;
	delete process.env.ISSUE_TOOL_COMPANY_ID_AHM;
	assert.equal(companyIdFor('KOL'), 2);
	process.env.ISSUE_TOOL_COMPANY_ID = '5';
	process.env.ISSUE_TOOL_COMPANY_ID_AHM = '7';
	assert.equal(companyIdFor('KOL'), 5);
	assert.equal(companyIdFor('AHM'), 7);
	process.env = saved;
});

// ── voucher comparison ──────────────────────────────────────────────────────


test('voucher comparison ignores identity, number and timestamp columns, but not blanks', () => {
	const erp = {
		header: { TransactionID: 1, VoucherNo: 'IS17252_26_27', MaxVoucherNo: 17252, CreatedDate: new Date(1), DeliveryNoteNo: '', TotalQuantity: 2958 },
		lines: [{ TransactionDetailID: 10, TransID: 1, IssueQuantity: '1500.000', BatchNo: 'B1' }],
	};
	const ours = {
		header: { TransactionID: 2, VoucherNo: 'IS17300_26_27', MaxVoucherNo: 17300, CreatedDate: new Date(2), DeliveryNoteNo: ' ', TotalQuantity: 2958 },
		lines: [{ TransactionDetailID: 99, TransID: 1, IssueQuantity: 1500, BatchNo: 'B1' }],
	};
	const result = compareVouchers(ours, erp);
	assert.equal(result.identical, false);
	assert.deepEqual(result.header.map((d) => d.column), ['DeliveryNoteNo']);   // ' ' is not ''
	assert.deepEqual(result.lines, [{ transId: 1, diffs: [] }]);                // 1500 equals '1500.000'

	ours.header.DeliveryNoteNo = '';
	assert.equal(compareVouchers(ours, erp).identical, true);
	assert.equal(compareVouchers({ ...ours, lines: [] }, erp).lines[0].missing, 'ours');
});

test('normalise keeps NULL, empty and space apart', () => {
	assert.equal(normalise(null), null);
	assert.equal(normalise(''), '');
	assert.equal(normalise(' '), ' ');
	assert.equal(normalise(true), 1);
	assert.deepEqual(checkExpectations({ JobBookingID: 0, DepartmentID: 100 }, { JobBookingID: 0, DepartmentID: 100 }), []);
	assert.equal(checkExpectations({ JobBookingID: 15607 }, { JobBookingID: 0 }).length, 1);
});

test('BIGINT columns come back from the driver as strings and are turned into numbers', () => {
	const rs = [{ TransactionID: '66933', VoucherID: '-19', VoucherNo: 'IS17300_26_27', PicklistTransactionID: '0', Qty: 363 }];
	rs.columns = {
		TransactionID: { type: sql.BigInt },
		VoucherID: { type: sql.BigInt },
		VoucherNo: { type: sql.NVarChar },
		PicklistTransactionID: { type: sql.BigInt },
		Qty: { type: sql.Float },
	};
	bigIntsToNumbers(rs);
	assert.deepEqual(rs[0], { TransactionID: 66933, VoucherID: -19, VoucherNo: 'IS17300_26_27', PicklistTransactionID: 0, Qty: 363 });
	assert.equal(rs[0].PicklistTransactionID || null, null);   // "0" would have been truthy
	assert.deepEqual(bigIntsToNumbers(undefined), []);
});

// ── sign-in ─────────────────────────────────────────────────────────────────

test('username lookup: one match wins, an exact UserName beats a LoginUserName, two exact names are refused', () => {
	assert.equal(pickUser([], 'store1'), null);
	assert.equal(pickUser([{ UserID: 24, UserName: 'STORE1' }], 'store1').UserID, 24);
	assert.equal(pickUser([
		{ UserID: 24, UserName: 'Store1', LoginUserName: 'x' },
		{ UserID: 99, UserName: 'Other', LoginUserName: 'store1' },
	], 'store1').UserID, 24);
	assert.throws(() => pickUser([{ UserID: 1, UserName: 'A' }, { UserID: 2, UserName: 'a ' }], 'a'),
		(err) => err.code === 'AMBIGUOUS_USERNAME' && err.status === 409);
});

test('login body takes a username and KOL / AHM in any case', () => {
	assert.deepEqual(parse(loginBody, { username: ' store1 ', database: 'kol' }), { username: 'store1', database: 'KOL' });
	assert.throws(() => parse(loginBody, { username: 'x', database: 'BOM' }), ApiError);
	assert.throws(() => parse(loginBody, { username: '', database: 'KOL' }), ApiError);
});

test('session tokens: valid ones carry the ERP user and site, anything else is a 401', () => {
	const saved = process.env.JWT_SECRET;
	process.env.JWT_SECRET = 'test-secret';
	try {
		const good = jwt.sign({ kind: 'issue-tool', site: 'KOL', erpUserId: 24, userName: 'STORE1' }, 'test-secret', { expiresIn: 60 });
		assert.equal(verifyToken(good).erpUserId, 24);

		const expired = jwt.sign({ kind: 'issue-tool', site: 'KOL', erpUserId: 24, exp: Math.floor(Date.now() / 1000) - 10 }, 'test-secret');
		const otherTool = jwt.sign({ username: 'x', tool: 'voice-note' }, 'test-secret');
		const forged = jwt.sign({ kind: 'issue-tool', site: 'KOL', erpUserId: 24 }, 'wrong-secret');
		for (const t of [expired, otherTool, forged, 'garbage']) {
			assert.throws(() => verifyToken(t), (err) => err.status === 401 && err.code === 'SESSION_EXPIRED');
		}
	} finally {
		if (saved === undefined) delete process.env.JWT_SECRET;
		else process.env.JWT_SECRET = saved;
	}
});
