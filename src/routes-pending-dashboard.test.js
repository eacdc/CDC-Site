import test from 'node:test';
import assert from 'node:assert/strict';

import {
	JOB_MODES,
	parseMode,
	emptyToNull,
	dateOrNull,
	intOrNull,
	bitOrUndefined,
	sumPendingValue,
	serializeRow,
	cacheKey,
	cacheGet,
	cacheSet,
	cacheClear
} from './routes-pending-dashboard.js';

test('parseMode accepts the four whitelist values and nothing else', () => {
	assert.deepEqual(JOB_MODES, ['DELIVERY', 'POSTPRINT', 'PARTIAL', 'ALL']);
	assert.equal(parseMode('DELIVERY'), 'DELIVERY');
	assert.equal(parseMode('postprint'), 'POSTPRINT');
	assert.equal(parseMode(' Partial '), 'PARTIAL');
	assert.equal(parseMode('all'), 'ALL');
	assert.equal(parseMode(''), null);
	assert.equal(parseMode(null), null);
	assert.equal(parseMode('DELIVER'), undefined);
	assert.equal(parseMode('DROP TABLE'), undefined);
	assert.equal(parseMode("DELIVERY'; --"), undefined);
});

test('emptyToNull and dateOrNull leave missing as null and reject junk', () => {
	assert.equal(emptyToNull(''), null);
	assert.equal(emptyToNull('  '), null);
	assert.equal(emptyToNull('J05941'), 'J05941');
	assert.equal(dateOrNull(''), null);
	assert.equal(dateOrNull('2026-04-01'), '2026-04-01');
	assert.equal(dateOrNull('01-04-2026'), undefined);
	assert.equal(intOrNull(''), null);
	assert.equal(intOrNull('12'), 12);
	assert.equal(intOrNull('12.5'), undefined);
});

test('bitOrUndefined omits missing so the proc default stands', () => {
	assert.equal(bitOrUndefined(undefined), undefined);
	assert.equal(bitOrUndefined(''), undefined);
	assert.equal(bitOrUndefined('1'), true);
	assert.equal(bitOrUndefined('true'), true);
	assert.equal(bitOrUndefined('0'), false);
	assert.equal(bitOrUndefined('no'), false);
	assert.equal(bitOrUndefined('maybe'), undefined);
});

test('sumPendingValue adds numeric and numeric-string PendingValue', () => {
	assert.equal(sumPendingValue([
		{ PendingValue: 100 },
		{ PendingValue: '50.5' },
		{ PendingValue: null },
		{ PendingValue: 'x' }
	]), 150.5);
	assert.equal(sumPendingValue([]), 0);
});

test('serializeRow keeps contract column names and coerces dates and numbers', () => {
	const row = serializeRow({
		PODetailID: '97398',
		PODate: new Date('2026-08-12T00:00:00.000Z'),
		PendingValue: '1557375',
		Supplier: 'Balaji'
	}, {
		dateCols: new Set(['PODate']),
		numCols: new Set(['PendingValue'])
	});
	assert.equal(row.PODetailID, '97398');
	assert.equal(row.PODate, '2026-08-12');
	assert.equal(row.PendingValue, 1557375);
	assert.equal(row.Supplier, 'Balaji');
});

test('cache is keyed by kind + normalised params and expires', () => {
	cacheClear();
	const key = cacheKey('po', { fromDate: null, toDate: null });
	cacheSet(key, { rowCount: 1 }, 1_000);
	assert.equal(cacheGet(key, 1_000 + 1).rowCount, 1);
	assert.equal(cacheGet(key, 1_000 + 60_000 + 1), null);
	cacheClear();
});
