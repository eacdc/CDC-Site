import test from 'node:test';
import assert from 'node:assert/strict';

import {
	severityOf,
	mapTemplateItem,
	mapTemplate,
	mapAql,
	isMissingProcedure,
	SEVERITY_UNCLASSIFIED
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
