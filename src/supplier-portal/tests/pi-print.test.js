/**
 * The printed purchase invoice. Figures from PI04732_26_27 (Kolkata) and
 * PI00846_26_27 (Ahmedabad), as the ERP returned them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { shapePrint } from '../services/pi-print.js';

const header = {
  VoucherNo: 'PI04732_26_27', InvoiceNo: 'NS/26-27/5194', TotalBasicAmount: 160000, NetAmount: 188800, Narration: '',
  SupplierName: 'N S Traders (Sanjay Saha)', Address1: '19/2A, Patwar Bagan Lane', City: 'West Bengal',
  District: 'West Bengal', State: 'West Bengal', Country: 'India', GSTNo: '19BGCPS8409L1ZR',
  PreparedBy: 'Manik Khanra', CompanyName: 'CDC Printers Pvt. Ltd.', CompanyAddress: 'Regd. Office: Tangra', CompanyGstin: '19AABCC2946B1ZZ',
};

test('a Kolkata invoice prints as the ERP prints it', () => {
  const p = shapePrint('KOL', header, [{
    ItemCode: 'RM00003', PoNo: 'PO03487_26_27', ItemName: 'AQUENCE GA 5000', PurchaseUnit: 'KGS', ReceiptQuantity: 500,
    StockUnit: 'Kg', ChallanQuantity: 500, ReceiptRate: 175, BasicAmount: 87500, CGSTPercentage: 9, CGSTAmount: 7875,
    SGSTPercentage: 9, SGSTAmount: 7875, IGSTPercentage: 18, IGSTAmount: 0, NetAmount: 103250,
  }], [{ LedgerName: 'CGST', Amount: 14400 }, { LedgerName: 'SGST', Amount: 14400 }],
  'M.J. Industrial Park, Nh-6 Bombay Road Mouza - Satgharia, J.L.No.27, P.O. - Bikihakola, P.S.- Panchla, Dist- Howrah, Pin - 711322');

  assert.equal(p.letterhead.lines[0][0], 'Regd Off');
  assert.deepEqual(p.supplier.address, ['19/2A, Patwar Bagan Lane', 'West Bengal', 'Dist./Province -West Bengal,West Bengal - India']);
  assert.match(p.delivery.address, /^M\.J\. Industrial Park/);
  assert.equal(p.lines[0].qtyPu, 500);
  assert.equal(p.lines[0].amount, 87500);
  assert.equal(p.lines[0].gross, 103250);
  assert.deepEqual(p.taxes, [{ ledger: 'CGST', amount: 14400 }, { ledger: 'SGST', amount: 14400 }]);
  assert.equal(p.amountInWords, 'Rupees One Lakh Eighty Eight Thousand Eight Hundred Only');
  assert.equal(p.preparedBy, 'Manik Khanra');
});

test("Ahmedabad's delivery address drops its first line, the company's name", () => {
  const p = shapePrint('AHM', { ...header, CompanyGstin: '24AABCC2946B1Z8' }, [], [],
    'CDC Printers Pvt. Ltd.\r\nSuper Industrial Park, Plot No. : 46, 47, 52, 53\r\nVillage : Dhanvada Taluka : Bavla,\r\nAhmedabad Pin : 382220');
  assert.equal(p.delivery.address, 'Super Industrial Park, Plot No. : 46, 47, 52, 53, Village : Dhanvada Taluka : Bavla, Ahmedabad Pin : 382220');
  assert.equal(p.delivery.gstin, '24AABCC2946B1Z8');
  assert.equal(p.letterhead.lines.length, 1);
});
