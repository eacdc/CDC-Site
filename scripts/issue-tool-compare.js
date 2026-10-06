/**
 * Stock Issue Tool — compare two issue vouchers column by column (brief 8C).
 *
 * After the first real post, compare the voucher this tool wrote with one the
 * ERP wrote for a similar issue. Identity, number and timestamp columns are
 * ignored (TransactionID, TransactionDetailID, MaxVoucherNo, VoucherNo,
 * CreatedDate, ModifiedDate); every other column of the header and of each line
 * (matched by TransID) is compared, with '' / ' ' / NULL kept distinct.
 *
 * Also compares the floor receipt (RFS, ItemConsumptionMain/Detail) written
 * with each issue, the same way.
 *
 * Read-only.
 *
 * Run from the backend folder:
 *   npm run issue-tool:compare -- <ourTransactionId> <erpTransactionId>
 *   node scripts/issue-tool-compare.js 70001 69990 --site KOL [--ignore-deletion]
 *
 * Expect differences in the job, item, batch and quantity columns when the two
 * vouchers are different issues; what must match is which columns are filled,
 * and how (0 vs NULL, '' vs ' ').
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { getPool, closeAllPools, sql } = await import('../src/db.js');
const { compareVouchers, formatComparison, DELETION_COLUMNS } = await import('../src/issue-tool/compare.js');

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--site'));
const [ours, theirs] = positional.map(Number);
const SITE = arg('site', 'KOL').toUpperCase();

if (!Number.isInteger(ours) || !Number.isInteger(theirs)) {
	console.error('Usage: node scripts/issue-tool-compare.js <ourTransactionId> <erpTransactionId> [--site KOL] [--ignore-deletion]');
	process.exit(2);
}

async function loadVoucher(pool, transactionId) {
	const header = (await pool.request().input('id', sql.Int, transactionId)
		.query('SELECT * FROM dbo.ItemTransactionMain WHERE TransactionID = @id')).recordset[0];
	if (!header) throw new Error(`No ItemTransactionMain row with TransactionID ${transactionId}.`);
	if (Number(header.VoucherID) !== -19) throw new Error(`TransactionID ${transactionId} is VoucherID ${header.VoucherID}, not an issue (-19).`);
	const lines = (await pool.request().input('id', sql.Int, transactionId)
		.query('SELECT * FROM dbo.ItemTransactionDetail WHERE TransactionID = @id ORDER BY TransID')).recordset;
	return { header, lines };
}

/** The floor receipt (RFS, -53) written with an issue. */
async function loadFloorReceipt(pool, issueTransactionId) {
	const header = (await pool.request().input('id', sql.BigInt, issueTransactionId)
		.query(`SELECT TOP (1) * FROM dbo.ItemConsumptionMain
		        WHERE ReturnTransactionID = @id AND VoucherID = -53 ORDER BY ConsumptionTransactionID`)).recordset[0];
	if (!header) return null;
	const lines = (await pool.request().input('id', sql.BigInt, header.ConsumptionTransactionID)
		.query('SELECT * FROM dbo.ItemConsumptionDetail WHERE ConsumptionTransactionID = @id ORDER BY TransID')).recordset;
	return { header, lines };
}

async function main() {
	const pool = await getPool(SITE);
	const [a, b] = await Promise.all([loadVoucher(pool, ours), loadVoucher(pool, theirs)]);
	const ignore = process.argv.includes('--ignore-deletion') ? DELETION_COLUMNS : [];
	const result = compareVouchers(a, b, { ignore });
	console.log(`Comparing ${a.header.VoucherNo} (TransactionID ${ours}, this tool) with ${b.header.VoucherNo} (TransactionID ${theirs}, ERP) on ${SITE}`);
	console.log(formatComparison(result, { oursLabel: 'tool', theirsLabel: 'erp' }));
	if (!result.identical) process.exitCode = 1;

	const [ra, rb] = await Promise.all([loadFloorReceipt(pool, ours), loadFloorReceipt(pool, theirs)]);
	if (!ra || !rb) {
		console.log(`Floor receipt (RFS): ${!ra ? 'MISSING for the tool voucher' : 'none'}${!rb ? ', none for the ERP voucher' : ''}.`);
		if (!ra) process.exitCode = 1;
		return;
	}
	console.log(`Floor receipt ${ra.header.VoucherNo} (tool) against ${rb.header.VoucherNo} (ERP):`);
	const rfs = compareVouchers(ra, rb, {
		ignore: [...ignore, 'ConsumptionTransactionID', 'ConsumptionTransactionDetailID', 'ReturnTransactionID', 'IssueTransactionID'],
	});
	console.log(formatComparison(rfs, { oursLabel: 'tool', theirsLabel: 'erp' }));
	if (!rfs.identical) process.exitCode = 1;
}

main()
	.catch((err) => {
		console.error('Compare failed:', err.message);
		process.exitCode = 2;
	})
	.finally(() => closeAllPools().catch(() => {}));
