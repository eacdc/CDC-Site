/*
 * A byte-for-byte copy of eacdc/Create-PO po-math.js, so the server works out
 * every PO figure exactly as the screen showed it. Change both together.
 */
/**
 * PO arithmetic and the rules a line must pass before it can be saved.
 *
 * Pure functions only, so they can be checked without a browser or a server
 * (tests/po-math.test.js). The server repeats every rule before it writes to
 * the ERP: this copy is what lets the buyer see a problem while typing, not
 * the guard.
 *
 * The arithmetic copies what the ERP's own PO screen stores, studied on
 * FY 2026-27 POs (Purchase Order Tool/ANALYSIS.md section 3):
 *   - sheet paper bought by KG: kg = round2(sheets x L x W x GSM / 1e9),
 *     amount = round2(round3(kg) x rate) - the amount uses kg to 3 places
 *   - GST % from the item's HSN; CGST + SGST inside the home state, IGST
 *     outside it (by the supplier's GSTIN prefix)
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PoMath = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** GSTIN state code of each plant: West Bengal, Gujarat. */
  var HOME_STATE = { KOL: '19', AHM: '24' };

  /** Paper item groups the buffer-stock rule applies to. */
  var PAPER_GROUPS = [14, 2]; // 14 sheet paper, 2 reel

  /** Rate warnings: above this share over the best price or the last paid. */
  var WARN_OVER = 0.05;
  /** At or past twice (or half) the last paid rate, a typo is the likelier story. */
  var TYPO_FACTOR = 2;

  function round(n, dp) {
    if (!isFinite(n)) return null;
    var f = Math.pow(10, dp);
    return Math.round((n + (n >= 0 ? 1 : -1) * Number.EPSILON) * f) / f;
  }

  /** The ERP spells one unit several ways: Kg, KG, Kgs, kgs. */
  function normUnit(unit) {
    var u = String(unit == null ? '' : unit).trim().toUpperCase().replace(/[.\s]/g, '');
    if (/^(KG|KGS|KILO|KILOS|KILOGRAMS?)$/.test(u)) return 'KG';
    if (/^(MT|MTS|TON|TONS|TONNE|TONNES|METRICTONNE)$/.test(u)) return 'MT';
    if (/^(SHEET|SHEETS|SHT|SHTS)$/.test(u)) return 'SHEET';
    if (/^(NOS|NO|PCS|PC|PIECES?)$/.test(u)) return 'NOS';
    if (/^(LTR|LTRS|LITRE|LITRES|LITER|LITERS|L)$/.test(u)) return 'LTR';
    return u;
  }

  function isPaperItem(item) {
    return PAPER_GROUPS.indexOf(Number(item && item.groupId)) !== -1;
  }

  /** Stocked in sheets, bought by weight: the buyer types sheets, the PO carries kg. */
  function isSheetByKg(item) {
    return normUnit(item.stockUnit) === 'SHEET' && normUnit(item.purchaseUnit) === 'KG';
  }

  function sheetKg(sheets, item) {
    return (Number(sheets) || 0) * Number(item.sizeL) * Number(item.sizeW) * Number(item.gsm) / 1e9;
  }

  /**
   * One line's quantities and amount, from what the buyer typed.
   *
   * @param item  { stockUnit, purchaseUnit, sizeW, sizeL, gsm, qtyPerPack }
   * @param qty   sheets for sheet-by-kg paper; otherwise the purchase-unit quantity
   * @param rate  per purchase unit
   * @returns { stockQty, poQty, packs, amount, kgForAmount }
   */
  function lineQuantities(item, qty, rate) {
    var q = Number(qty) || 0;
    var r = Number(rate) || 0;
    if (isSheetByKg(item)) {
      var kg = sheetKg(q, item);
      var pack = Number(item.qtyPerPack) || 0;
      return {
        stockQty: q,
        poQty: round(kg, 2),
        packs: pack ? round(q / pack, 2) : null,
        // The ERP works the amount on kg to 3 places, then stores kg to 2.
        amount: round(round(kg, 3) * r, 2),
        kgForAmount: round(kg, 3),
      };
    }
    return { stockQty: q, poQty: q, packs: null, amount: round(q * r, 2), kgForAmount: null };
  }

  /** Weight of the line in kg, for the buffer-stock comparison. Null when it has none. */
  function lineKg(item, qty) {
    if (isSheetByKg(item)) return round(sheetKg(qty, item), 2);
    if (normUnit(item.purchaseUnit) === 'KG') return Number(qty) || 0;
    if (normUnit(item.purchaseUnit) === 'MT') return (Number(qty) || 0) * 1000;
    return null;
  }

  function isIntraState(supplierGstin, site) {
    var home = HOME_STATE[site];
    return Boolean(home) && String(supplierGstin || '').trim().slice(0, 2) === home;
  }

  /** GST on one line. Only the tax that applies is non-zero. */
  function lineTax(taxable, gstPct, intraState) {
    var pct = Number(gstPct) || 0;
    if (intraState) {
      var half = round(taxable * pct / 2 / 100, 2);
      return { cgstPct: pct / 2, sgstPct: pct / 2, igstPct: 0, cgst: half, sgst: half, igst: 0, tax: round(half * 2, 2) };
    }
    var igst = round(taxable * pct / 100, 2);
    return { cgstPct: 0, sgstPct: 0, igstPct: pct, cgst: 0, sgst: 0, igst: igst, tax: igst };
  }

  /**
   * A quoted rate in the line's purchase unit. Null when the two units
   * cannot be converted - such a price is shown but cannot be ordered against.
   */
  function convertRate(rate, fromUnit, toUnit) {
    var r = Number(rate);
    if (!isFinite(r)) return null;
    var from = normUnit(fromUnit);
    var to = normUnit(toUnit);
    if (!from || from === to) return r;
    if (from === 'MT' && to === 'KG') return round(r / 1000, 4);
    if (from === 'KG' && to === 'MT') return round(r * 1000, 2);
    return null;
  }

  /** An offer's rate in the purchase unit, as the PO line would carry it. */
  function offerRate(offer, purchaseUnit) {
    var rate = offer && offer.rate ? offer.rate : {};
    var value = rate.ratePerBaseUom != null ? rate.ratePerBaseUom : rate.rate;
    return convertRate(value, rate.uom, purchaseUnit);
  }

  function sameSupplier(offer, supplier) {
    if (!offer || !supplier) return false;
    var a = String((offer.supplier && offer.supplier.gstin) || '').toUpperCase();
    var b = String(supplier.gstin || '').toUpperCase();
    if (a && b) return a === b;
    return String((offer.supplier && offer.supplier.name) || '').trim().toUpperCase()
      === String(supplier.name || '').trim().toUpperCase();
  }

  /**
   * The checks on one line's rate.
   *
   * A PO can only be made against a price a person approved in the supplier
   * portal, so no approved price from this supplier, or a rate above it,
   * blocks the line. Being well above the best price or the last paid rate is
   * a warning; twice or half the last paid rate needs confirming as a likely
   * typo.
   *
   * @returns [{ severity: 'BLOCK'|'CONFIRM'|'WARN', code, message }]
   */
  function rateChecks(input) {
    var out = [];
    var rate = Number(input.rate);
    var approved = input.approvedRate;
    var unit = input.unit || '';

    if (approved == null) {
      out.push({ severity: 'BLOCK', code: 'NO_APPROVED_PRICE',
        message: 'This supplier has no approved price for this item. A PO can only use an approved price.' });
    }
    if (!(rate > 0)) {
      out.push({ severity: 'BLOCK', code: 'NO_RATE', message: 'Enter a rate.' });
      return out;
    }
    if (approved != null && rate > approved + 0.00001) {
      out.push({ severity: 'BLOCK', code: 'ABOVE_APPROVED',
        message: 'Above this supplier\'s approved price of ' + money(approved) + '/' + unit + '.' });
    }
    if (input.bestRate != null && input.bestRate > 0 && rate > input.bestRate * (1 + WARN_OVER)) {
      out.push({ severity: 'WARN', code: 'ABOVE_BEST',
        message: pct((rate - input.bestRate) / input.bestRate) + ' above the best approved price ('
          + money(input.bestRate) + (input.bestSupplier ? ', ' + input.bestSupplier : '') + ').' });
    }
    var last = input.lastPaidRate;
    if (last != null && last > 0) {
      if (rate >= last * TYPO_FACTOR || rate <= last / TYPO_FACTOR) {
        out.push({ severity: 'CONFIRM', code: 'TYPO',
          message: 'The rate is ' + (rate > last ? 'over twice' : 'under half') + ' the last paid rate of '
            + money(last) + '. Check it is not a typing mistake.' });
      } else if (rate > last * (1 + WARN_OVER)) {
        out.push({ severity: 'WARN', code: 'ABOVE_LAST_PAID',
          message: pct((rate - last) / last) + ' above the last paid rate of ' + money(last) + '.' });
      }
    }
    return out;
  }

  /**
   * The buffer-stock rule for one paper line.
   *
   * Free stock of the item and similar items (GetItemDetailsWithBufferTotal_Manu_v4),
   * on the floor and on open POs, counted separately. Any client's tag counts.
   * Approval is needed when the free stock physically on the floor covers what
   * is being ordered; stock still on order is shown but never triggers it
   * (Manu, 23 Nov 2026).
   */
  function bufferCheck(orderKg, stockRows) {
    var floorFree = 0;
    var onOrderFree = 0;
    (stockRows || []).forEach(function (r) {
      var free = Number(r.freeKg);
      if (!(free > 0)) return;
      if (r.section === 'ON ORDER') onOrderFree += free;
      else floorFree += free;
    });
    floorFree = round(floorFree, 2);
    onOrderFree = round(onOrderFree, 2);
    var kg = Number(orderKg) || 0;
    return {
      floorFree: floorFree,
      onOrderFree: onOrderFree,
      needsApproval: kg > 0 && floorFree >= kg,
    };
  }

  /** How far a stock row is from the item ordered: 0 for the same item. */
  function matchDistance(r) {
    if (r.matchType === 'Same item') return 0;
    return 1 + Math.abs(Number(r.gsmDiff) || 0) * 10 + Math.abs(Number(r.sizeWDiff) || 0) + Math.abs(Number(r.sizeLDiff) || 0);
  }

  /**
   * The floor lots printed on the approval page: lots whose free kg alone
   * covers the order, closest match first (same item, then the smallest GSM
   * and size difference); when fewer than `n` do, the largest other lots
   * fill the list.
   */
  function topFloorStock(orderKg, stockRows, n) {
    var kg = Number(orderKg) || 0;
    var count = n || 3;
    var floor = (stockRows || []).filter(function (r) { return r.section !== 'ON ORDER' && Number(r.freeKg) > 0; });
    var covering = floor.filter(function (r) { return Number(r.freeKg) >= kg; })
      .sort(function (a, b) { return (matchDistance(a) - matchDistance(b)) || (Number(b.freeKg) - Number(a.freeKg)); });
    var others = floor.filter(function (r) { return covering.indexOf(r) === -1; })
      .sort(function (a, b) { return Number(b.freeKg) - Number(a.freeKg); });
    return covering.concat(others).slice(0, count).map(function (r) {
      return Object.assign({}, r, { coversAlone: Number(r.freeKg) >= kg });
    });
  }

  /** PO totals. The grand total is rounded to the rupee, and the words say that figure. */
  function totals(lines) {
    var t = { basic: 0, cgst: 0, sgst: 0, igst: 0, tax: 0, quantity: 0 };
    (lines || []).forEach(function (l) {
      t.basic += l.amount || 0;
      t.cgst += l.cgst || 0;
      t.sgst += l.sgst || 0;
      t.igst += l.igst || 0;
      t.quantity += l.poQty || 0;
    });
    ['basic', 'cgst', 'sgst', 'igst', 'quantity'].forEach(function (k) { t[k] = round(t[k], 2); });
    t.tax = round(t.cgst + t.sgst + t.igst, 2);
    t.net = round(t.basic + t.tax, 2);
    t.grand = Math.round(t.net);
    t.roundOff = round(t.grand - t.net, 2);
    t.words = amountInWords(t.grand);
    return t;
  }

  var ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  var TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  function belowHundred(n) {
    if (n < 20) return ONES[n];
    return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
  }

  function belowThousand(n) {
    var h = Math.floor(n / 100);
    var rest = n % 100;
    return [h ? ONES[h] + ' Hundred' : '', rest ? belowHundred(rest) : ''].filter(Boolean).join(' ');
  }

  /** Indian numbering: crore, lakh, thousand. 11306 -> "Rupees Eleven Thousand Three Hundred Six Only". */
  function amountInWords(amount) {
    var n = Math.round(Math.abs(Number(amount) || 0));
    if (n === 0) return 'Rupees Zero Only';
    var parts = [];
    var crore = Math.floor(n / 10000000); n %= 10000000;
    var lakh = Math.floor(n / 100000); n %= 100000;
    var thousand = Math.floor(n / 1000); n %= 1000;
    if (crore) parts.push(belowThousand(crore) + ' Crore');
    if (lakh) parts.push(belowHundred(lakh) + ' Lakh');
    if (thousand) parts.push(belowHundred(thousand) + ' Thousand');
    if (n) parts.push(belowThousand(n));
    return 'Rupees ' + parts.join(' ') + ' Only';
  }

  /** Days in a payment-terms label: "Payment in 90 Days" -> 90. */
  function creditDays(text) {
    var m = String(text || '').match(/(\d+)\s*days?/i);
    return m ? Number(m[1]) : null;
  }

  function money(n) {
    return '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function pct(f) {
    return (Math.round(f * 1000) / 10).toFixed(1) + '%';
  }

  return {
    HOME_STATE: HOME_STATE,
    round: round,
    normUnit: normUnit,
    isPaperItem: isPaperItem,
    isSheetByKg: isSheetByKg,
    lineQuantities: lineQuantities,
    lineKg: lineKg,
    isIntraState: isIntraState,
    lineTax: lineTax,
    convertRate: convertRate,
    offerRate: offerRate,
    sameSupplier: sameSupplier,
    rateChecks: rateChecks,
    bufferCheck: bufferCheck,
    topFloorStock: topFloorStock,
    totals: totals,
    amountInWords: amountInWords,
    creditDays: creditDays,
    money: money,
  };
});
