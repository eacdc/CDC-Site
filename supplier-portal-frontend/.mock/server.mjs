/** Throwaway mock API, just enough to render every screen for a smoke test. */
import http from 'node:http';

const json = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
};

const SESSION = {
  user: { id: 'u1', email: 'manu@cdcprinters.com', displayName: 'Manu', roles: ['ADMIN'], allowedSites: ['KOL','AHM'], defaultSite: 'KOL' },
  context: { site: 'KOL', erpUserId: 42, employeeLedgerId: 9879, warehouseId: 13 },
};

const ITEM_DETAIL = {
  item: { itemId: 3845, itemCode: 'INK-0042', name: 'UV Ink - Process-Cyan', groupId: 3, groupName: 'INK & ADDITIVES', subGroupId: null, subGroupName: null, stockUnit: 'KG', purchaseUnit: 'KG' },
  plant: 'KOLKATA',
  rankingMode: 'BRAND',
  lastPaid: { rate: 820, date: '2026-06-14', supplierName: 'Siegwerk India Pvt Ltd', voucherNo: 'PO02201_26_27' },
  quotes: [
    { supplierGroupId: 'g1', supplierName: 'Siegwerk', supplierProductName: 'SICURA PLAST 770 HS CYAN', state: 'QUOTED', rate: 810, uom: 'KG', plant: 'KOLKATA', effectiveTo: '2026-11-01', isExpired: false, quoteStrength: 'FIRM' },
    { supplierGroupId: 'g2', supplierName: 'Sakata', supplierProductName: 'SKT ENVIRO NEO CYAN', state: 'QUOTED', rate: 308, uom: 'KG', plant: 'KOLKATA', effectiveTo: '2026-09-15', isExpired: false, quoteStrength: 'SOFT' },
    { supplierGroupId: 'g3', supplierName: 'NR Agarwal', state: 'NOT_AT_PLANT', rate: null, quotedAtPlant: 'AHMEDABAD', displayNote: 'not quoted (Ahmedabad only)' },
  ],
  best: { supplierName: 'Siegwerk', rate: 810 },
  deltaVsLastPaid: { rupees: 10, percent: 1.22 },
  purchaseHistory: [
    { VoucherDate: '2026-04-02', VoucherNo: 'PO02100_26_27', LedgerName: 'Siegwerk India Pvt Ltd', PurchaseRate: 830, PurchaseOrderQuantity: 50, PurchaseUnit: 'KG' },
    { VoucherDate: '2026-06-14', VoucherNo: 'PO02201_26_27', LedgerName: 'Siegwerk India Pvt Ltd', PurchaseRate: 820, PurchaseOrderQuantity: 60, PurchaseUnit: 'KG' },
  ],
  sparkline: [
    { month: '2026-04', min: 820, max: 840, avg: 830, count: 2 },
    { month: '2026-05', min: 815, max: 835, avg: 825, count: 3 },
    { month: '2026-06', min: 810, max: 828, avg: 820, count: 2 },
  ],
  annualSpend: 4200000,
  purchaseCount: 18,
  ranking: {
    mode: 'BRAND',
    ranked: null,
    byBrand: [
      { brand: 'Siegwerk', quotes: [{ supplierGroupId: 'g1', supplierName: 'Siegwerk', supplierProductName: 'SICURA PLAST 770 HS CYAN', state: 'QUOTED', rate: 810, uom: 'KG', effectiveTo: '2026-11-01', quoteStrength: 'FIRM' }] },
      { brand: 'Sakata', quotes: [{ supplierGroupId: 'g2', supplierName: 'Sakata', supplierProductName: 'SKT ENVIRO NEO CYAN', state: 'QUOTED', rate: 308, uom: 'KG', effectiveTo: '2026-09-15', quoteStrength: 'SOFT' }] },
    ],
    crossBrandNote: 'Cross-brand prices are shown separately: substituting a brand is a technical decision, not a price decision.',
  },
};

const ROUTES = {
  'POST /api/supplier-portal/auth/login': () => ({ token: 'mock-token', expiresAt: '2026-12-31', ...SESSION }),
  'GET /api/supplier-portal/auth/me': () => SESSION,
  'GET /api/supplier-portal/items/search': () => ({ plant: 'KOLKATA', site: 'KOL', results: [
    { ItemID: 3845, ItemCode: 'INK-0042', ItemName: 'UV Ink - Process-Cyan', ItemGroupName: 'INK & ADDITIVES', ItemSubGroupName: null, StockUnit: 'KG', PurchaseUnit: 'KG', matchedVia: 'SUPPLIER_NAME' },
    { ItemID: 4102, ItemCode: 'INK-0088', ItemName: 'INK, Maplitho - Process Ink-Black', ItemGroupName: 'INK & ADDITIVES', ItemSubGroupName: null, StockUnit: 'KG', PurchaseUnit: 'KG', matchedVia: 'CDC_NAME' },
  ] }),
  'GET /api/supplier-portal/items/3845': () => ITEM_DETAIL,
  'GET /api/supplier-portal/mappings/queue': () => ({ site: 'KOL', total: 2, entries: [{
    _id: 'q1', reason: 'AMBIGUOUS', site: 'KOL', priority: 1250000, status: 'OPEN',
    supplierGroup: { _id: 'g1', name: 'Ultimate Logistix' },
    document: { _id: 'd1', originalFilename: 'ultimate-aug.pdf', docType: 'PRICE_LIST', effectiveFrom: '2026-08-01' },
    line: { _id: 'l1', lineNo: 4, raw: { productName: 'G.I WIRE SPOOL BIG 26', productCode: null, packSize: '15 kg Spool', uom: 'KG', rate: '149.00', text: 'G.I WIRE SPOOL BIG 26 (15 kg Spool) | 149.00/KG' }, normalised: { rate: 149, uom: 'KG', ratePerBaseUom: 149, packQty: 15, packUom: 'KG', conversionNote: '149 per KG; pack of 15 KG = 2235 per Nos' } },
    candidates: [
      { itemId: 5501, itemName: 'G.I WIRE SPOOL BIG 26', itemCode: 'OM-5501', subGroupName: 'Binding Materials', lastPaidRate: 2235, lastSupplier: 'Ultimate Logistix', purchaseCount: 12, score: 0.94, rationale: 'within 0.0% of last paid; this supplier supplies it' },
      { itemId: 5502, itemName: 'G.I WIRE SPOOL SMALL 24', itemCode: 'OM-5502', subGroupName: 'Binding Materials', lastPaidRate: 1800, lastSupplier: 'Trilochan', purchaseCount: 3, score: 0.62, rationale: 'name similarity 0.71' },
    ],
  }] }),
  'GET /api/supplier-portal/mappings/queue-stats': () => ({ site: 'KOL', openCount: 546, openSpend: 38500000, byStatus: [] }),
  'GET /api/supplier-portal/quotes': () => ({ total: 1, documents: [{ _id: 'd1', uploadedAt: '2026-08-19T10:00:00Z', supplierGroupId: 'g1', originalFilename: 'siegwerk-price-revision.xlsx', docType: 'WORKSHEET', quoteStrength: 'FIRM', plantScope: ['KOLKATA'], plantScopeBasis: 'ASSUMED', effectiveTo: '2026-11-02', validityBasis: 'DEFAULTED', status: 'NEEDS_REVIEW' }] }),
  'GET /api/supplier-portal/suppliers': () => ([
    { _id: 'g1', name: 'Siegwerk', ledgerRefs: [{ site: 'KOL', ledgerId: 7375 }], aliases: ['SIEGWORK','Siegwerk India'], tradesAs: [], isInternal: false },
    { _id: 'g4', name: 'CDC Printers (Ahmedabad)', ledgerRefs: [{ site: 'KOL', ledgerId: 9001 }], aliases: [], isInternal: true },
  ]),
  'GET /api/supplier-portal/reports/leakage': () => ({ plant: 'KOLKATA', totalLeakage: 1842000, poCount: 96, window: { from: '2026-05-20', to: '2026-08-20' }, lines: [
    { poVoucherNo: 'PO02359_26_27', poDate: '2026-08-18', itemId: 3845, itemName: 'UV Ink - Process-Cyan', supplierName: 'Siegwerk', poRate: 860, bestRate: 810, bestSupplier: 'Siegwerk', quantity: 500, perUnitDelta: 50, leakage: 25000, plant: 'KOLKATA' },
  ] }),
  'GET /api/supplier-portal/po-check/sweep': () => ({ window: { from: '2026-08-19', to: '2026-08-20' }, plant: 'KOLKATA', checked: 14, needingAttention: 1, results: [{
    poTransactionId: 58682, poVoucherNo: 'PO02359_26_27', poDate: '2026-08-18', supplierName: 'Siegwerk India Pvt Ltd', plant: 'KOLKATA',
    verdict: { level: 'BLOCK', summary: 'PO rate ₹860 is 6.2% above Siegwerk\'s own quote of ₹810', blocking: 1, warnings: 1 },
    lines: [{ transactionDetailId: 1, itemId: 3845, itemName: 'UV Ink - Process-Cyan', quantity: 500, uom: 'KG', poRate: 860, bestQuote: { rate: 810, supplier: 'Siegwerk' }, lastPaid: { rate: 820 }, plant: 'KOLKATA', verdict: { level: 'BLOCK' }, checks: [
      { code: 'PO002', severity: 'BLOCK', passed: false, message: "PO rate ₹860 is 6.2% above Siegwerk's own quote of ₹810", actualValue: 860, expectedValue: 810 },
      { code: 'PO006', severity: 'WARN', passed: false, message: 'PO rate ₹860 differs from last paid ₹820 by 4.9%', actualValue: 860, expectedValue: 820 },
    ] }],
  }] }),
  'GET /api/supplier-portal/receiving/document-sets': () => ({ total: 0, documentSets: [] }),
};

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }); return res.end(); }
  const url = new URL(req.url, 'http://x');
  const key = `${req.method} ${url.pathname}`;
  const handler = ROUTES[key];
  if (handler) { let b=''; req.on('data',c=>b+=c); return req.on('end',()=>json(res, handler(b))); }
  return json(res, { error: `mock: no route for ${key}` }, 404);
}).listen(3001, () => console.log('mock API on 3001'));
