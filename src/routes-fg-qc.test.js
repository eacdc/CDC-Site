import test from 'node:test';
import assert from 'node:assert/strict';

import {
	severityOf,
	mapTemplateItem,
	mapTemplate,
	mapAql,
	isMissingProcedure,
	isStaleProcedure,
	sampleForLot,
	lotKey,
	SEVERITY_UNCLASSIFIED,
	MIN_QC_LOT_QTY
} from './routes-fg-qc.js';

/*
 * Spec section 5 question 1 is open: which column on the parameter master is
 * authoritative for severity. Until it is answered, an unrecognised value must
 * never be guessed — filing a Critical defect under Minor turns a lot that has
 * to be rejected on one defect into a lot that accepts up to the Minor accept
 * number, with nothing on screen to say so.
 */
test('severityOf resolves the three AQL classes', () => {
	assert.equal(severityOf('Critical'), 'Critical');
	assert.equal(severityOf('critical'), 'Critical');
	assert.equal(severityOf('  MAJOR  '), 'Major');
	assert.equal(severityOf('Minor'), 'Minor');
	assert.equal(severityOf('MinorCriteria'), 'Minor');
});

test('severityOf refuses to guess an unrecognised value', () => {
	assert.equal(severityOf(''), null);
	assert.equal(severityOf(null), null);
	assert.equal(severityOf(undefined), null);
	assert.equal(severityOf('Cosmetic'), null);
	assert.equal(severityOf('0'), null);
});

test('an unresolved severity is reported, not defaulted to Minor', () => {
	const item = mapTemplateItem({
		FGQCParameterSettingID: 12,
		Characterstics: 'TEXT PRINT MISSING',
		MasterFieldType: 'Cosmetic'
	});
	assert.equal(item.severity, SEVERITY_UNCLASSIFIED);
	assert.equal(item.severityResolved, false);
	assert.equal(item.rawSeverity, 'Cosmetic');
});

test('a resolved severity is marked resolved', () => {
	const item = mapTemplateItem({ id: 3, parameter: 'SPINE CRACK', severity: 'major' });
	assert.equal(item.severity, 'Major');
	assert.equal(item.severityResolved, true);
	assert.equal(item.characterstics, 'SPINE CRACK');
	assert.equal(item.fgqcParameterSettingID, 3);
});

test('mapTemplate counts the characteristics the master cannot classify', () => {
	const template = mapTemplate({
		lotSize: 5000,
		sampleSize: 200,
		planFound: true,
		referenceAQL: { critical: 0, major: 7, minor: 10 },
		items: [
			{ id: 1, parameter: 'BAD BINDING', severity: 'Critical' },
			{ id: 2, parameter: 'INK SMUDGE', severity: 'Minor' },
			{ id: 3, parameter: 'MYSTERY', severity: '' }
		]
	}, 5000);

	assert.equal(template.unclassifiedCount, 1);
	assert.equal(template.items.length, 3);
	assert.equal(template.items[2].severity, SEVERITY_UNCLASSIFIED);
});

/*
 * Spec section 7.2: if planFound is false the form must say so. The flag is
 * only ever true when the procedure actually resolved a plan.
 */
test('planFound is only true when the procedure says so', () => {
	assert.equal(mapTemplate({ planFound: true }, 100).planFound, true);
	assert.equal(mapTemplate({ planFound: 1 }, 100).planFound, true);
	assert.equal(mapTemplate({ planFound: 'true' }, 100).planFound, true);
	assert.equal(mapTemplate({ planFound: false }, 100).planFound, false);
	assert.equal(mapTemplate({ planFound: 0 }, 100).planFound, false);
	assert.equal(mapTemplate({}, 100).planFound, false);
	assert.equal(mapTemplate(null, 100).planFound, false);
});

test('a missing template payload still reports the lot size it was asked for', () => {
	const template = mapTemplate(null, 5000);
	assert.equal(template.lotSize, 5000);
	assert.deepEqual(template.items, []);
	assert.equal(template.unclassifiedCount, 0);
});

/*
 * Spec section 3: Critical is not allowed, so its accept number is 0. A missing
 * Critical accept number must read as 0, not as "no limit" — the opposite
 * mistake would let a lot with a critical defect through.
 */
test('a missing Critical accept number reads as zero', () => {
	assert.equal(mapAql({ major: 7, minor: 10 }).critical, 0);
	assert.equal(mapAql(null).critical, 0);
	assert.equal(mapAql({ ReferenceAQLCritical: 0 }).critical, 0);
});

test('Major and Minor accept numbers stay null when the plan did not resolve', () => {
	const aql = mapAql(null);
	assert.equal(aql.major, null);
	assert.equal(aql.minor, null);
});

test('accept numbers are read under either naming convention', () => {
	assert.deepEqual(
		{ ...mapAql({ ReferenceAQLCritical: 0, ReferenceAQLMajor: 7, ReferenceAQLMinor: 10 }) },
		{ critical: 0, major: 7, minor: 10, total: null }
	);
	assert.deepEqual(
		{ ...mapAql({ critical: 0, major: 7, minor: 10 }) },
		{ critical: 0, major: 7, minor: 10, total: null }
	);
});

/*
 * The stored-procedure fallback must trigger only on a genuinely missing
 * procedure. Falling back on any other error would mask a real failure behind
 * a second query that fails the same way.
 */
/*
 * A procedure that exists but predates the route calling it fails with 8144 or
 * 8145, not 2812. Without this the dashboard table would 500 on any database
 * still running an older sql/fgqc/010_GetFGQCInspectionList.sql, rather than
 * falling back to the inline query and warning.
 */
test('isStaleProcedure recognises a procedure that is behind the route', () => {
	assert.equal(
		isStaleProcedure(
			{ number: 8144, message: 'Procedure or function GetFGQCInspectionList has too many arguments specified.' },
			'GetFGQCInspectionList'
		),
		true
	);
	assert.equal(
		isStaleProcedure(
			{ number: 8145, message: '@GPNNo is not a parameter for procedure GetFGQCInspectionList.' },
			'GetFGQCInspectionList'
		),
		true
	);
	// No number, so the message has to name the procedure this call was for.
	assert.equal(
		isStaleProcedure(
			{ message: 'Procedure or function GetFGQCInspectionList has too many arguments specified.' },
			'GetFGQCInspectionList'
		),
		true
	);
	assert.equal(
		isStaleProcedure(
			{ message: 'Procedure or function SomethingElse has too many arguments specified.' },
			'GetFGQCInspectionList'
		),
		false
	);
	// A missing procedure is a different case with a different warning.
	assert.equal(
		isStaleProcedure({ number: 2812, message: "Could not find stored procedure 'X'." }, 'X'),
		false
	);
	assert.equal(isStaleProcedure(null, 'GetFGQCInspectionList'), false);
});

/*
 * CDC's Carter's AQL Table, as printed and hung at Panchla: single sampling
 * plan, normal inspection level II, Critical not allowed / Major 1.5 /
 * Minor 2.5.
 *
 * Nine bands, not the fifteen of the textbook Z1.4 table. The small ones are
 * absent: CDC's first band is 0-150 and asks for 20, so a lot of 60 is
 * sampled at 20, not at the 13 a full Z1.4 table would give. Any test that
 * assumes the textbook table is testing a plan CDC does not use.
 *
 * The stored number is ACCEPT, the left half of each printed pair.
 */
const CARTER_BANDS = [
	{ from: 0,      to: 150,    sampleSize: 20,  major: 0,  minor: 1 },
	{ from: 151,    to: 280,    sampleSize: 32,  major: 1,  minor: 2 },
	{ from: 281,    to: 500,    sampleSize: 50,  major: 2,  minor: 3 },
	{ from: 501,    to: 1200,   sampleSize: 80,  major: 3,  minor: 5 },
	{ from: 1201,   to: 3200,   sampleSize: 125, major: 5,  minor: 7 },
	{ from: 3201,   to: 10000,  sampleSize: 200, major: 7,  minor: 10 },
	{ from: 10001,  to: 35000,  sampleSize: 315, major: 10, minor: 14 },
	{ from: 35001,  to: 150000, sampleSize: 500, major: 14, minor: 21 },
	{ from: 150001, to: 500000, sampleSize: 500, major: 14, minor: 21 }
];

test('sampleForLot reads the band the lot actually falls in', () => {
	assert.equal(sampleForLot(CARTER_BANDS, 60), 20);
	assert.equal(sampleForLot(CARTER_BANDS, 100), 20);
	assert.equal(sampleForLot(CARTER_BANDS, 1500), 125);
	assert.equal(sampleForLot(CARTER_BANDS, 30000), 315);
	// Band edges belong to the band, both ends.
	assert.equal(sampleForLot(CARTER_BANDS, 150), 20);
	assert.equal(sampleForLot(CARTER_BANDS, 151), 32);
	assert.equal(sampleForLot(CARTER_BANDS, 35000), 315);
	assert.equal(sampleForLot(CARTER_BANDS, 35001), 500);
});

/*
 * The bug this change exists to kill: a GPN of 100 was being sized against a
 * job of 30,000, so the inspector was asked for 315 pieces out of 100.
 */
test('the GPN quantity and the job quantity give different samples', () => {
	assert.equal(sampleForLot(CARTER_BANDS, 30000), 315);
	assert.equal(sampleForLot(CARTER_BANDS, 100), 20);
	assert.ok(sampleForLot(CARTER_BANDS, 100) <= 100, 'a sample must never exceed the lot it is drawn from');
	assert.ok(sampleForLot(CARTER_BANDS, 30000) > 100, 'the job-sized sample is what used to exceed it');
});

/*
 * The first band starts at 0 and asks for 20, so a lot under 20 cannot satisfy
 * its own plan. MIN_QC_LOT_QTY is what keeps those out of the queue, and this
 * fails if anyone lowers it under the smallest band's sample size.
 */
test('the minimum lot quantity is large enough for the first band', () => {
	const first = CARTER_BANDS[0];
	assert.ok(
		MIN_QC_LOT_QTY >= first.sampleSize,
		`MIN_QC_LOT_QTY (${MIN_QC_LOT_QTY}) is below the first band's sample size (${first.sampleSize}), `
		+ 'so a lot could be queued that cannot supply its own sample'
	);
	for (const band of CARTER_BANDS) {
		const smallest = Math.max(band.from, MIN_QC_LOT_QTY);
		assert.ok(
			band.sampleSize <= smallest,
			`band ${band.from}-${band.to} asks for ${band.sampleSize} from a lot of ${smallest}`
		);
	}
});

/* Critical is "not allowed" on every band — the accept number is always 0. */
test('every band accepts zero critical defects', () => {
	for (const band of CARTER_BANDS) {
		assert.equal(mapAql({ critical: 0, major: band.major, minor: band.minor }).critical, 0);
	}
});

test('sampleForLot returns null when no band covers the lot', () => {
	assert.equal(sampleForLot(CARTER_BANDS, 500001), null);
	assert.equal(sampleForLot(CARTER_BANDS, null), null);
	assert.equal(sampleForLot(null, 100), null);
	// An open-ended band swallows everything above its floor.
	assert.equal(sampleForLot([{ from: 35001, to: null, sampleSize: 500 }], 9e9), 500);
});

test('lotKey separates two jobs shipped on one GPN', () => {
	assert.notEqual(lotKey(7068, 2192), lotKey(7068, 3095));
	assert.equal(lotKey(7068, 2192), lotKey(7068, 2192));
	// A lot with no job resolved must not collide with job 0.
	assert.notEqual(lotKey(7068, null), lotKey(7068, 0));
});

test('isMissingProcedure recognises only a missing procedure', () => {
	assert.equal(
		isMissingProcedure({ number: 2812, message: "Could not find stored procedure 'GetFGQCDashboardKPIs'." }, 'GetFGQCDashboardKPIs'),
		true
	);
	assert.equal(
		isMissingProcedure({ message: "Could not find stored procedure 'GetFGQCDashboardKPIs'." }, 'GetFGQCDashboardKPIs'),
		true
	);
	assert.equal(isMissingProcedure({ number: 208, message: "Invalid object name 'Foo'." }, 'GetFGQCDashboardKPIs'), false);
	assert.equal(isMissingProcedure({ message: 'Timeout: Request failed to complete in 120000ms' }, 'GetFGQCDashboardKPIs'), false);
	assert.equal(isMissingProcedure(null, 'GetFGQCDashboardKPIs'), false);
});
