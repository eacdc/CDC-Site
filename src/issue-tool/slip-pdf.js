/**
 * Item Issue Slip PDF, in the ERP's format: company header with logo, "Item
 * Issue Slip", job card / department / client on the left, issue no. /
 * date / job name on the right, the lines (Item Code, ItemName, Unit,
 * Quantity, Batch No, Warehouse, GRN No., Bin), Total, Narration, and
 * Checked By / Received By / Issued By.
 *
 * Two copies on one A4 page with a cut line between them, as the ERP prints
 * it. A slip too long for half a page gets a page per copy (continuing over
 * more pages if needed).
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = join(__dirname, '..', '..', 'images', 'cdc logo.png');

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 28;
const CONTENT_W = PAGE_W - MARGIN * 2;
const PAD = 8;
const TABLE_W = CONTENT_W - PAD * 2;
const HALF_GAP = 10; // space either side of the cut line

const BLACK = rgb(0, 0, 0);
const GREY_HEAD = rgb(0.35, 0.35, 0.35);
const WHITE = rgb(1, 1, 1);
const RED = rgb(0.75, 0.1, 0.1);

/** Column widths in proportion to the ERP slip. */
const COLUMNS = [
	{ key: 'itemCode', label: 'Item Code', w: 52 },
	{ key: 'itemName', label: 'ItemName', w: 100 },
	{ key: 'unit', label: 'Unit', w: 34 },
	{ key: 'quantity', label: 'Quantity', w: 48, align: 'right' },
	{ key: 'batchNo', label: 'Batch No', w: 82 },
	{ key: 'warehouse', label: 'Warehouse', w: 62 },
	{ key: 'grnNo', label: 'GRN No.', w: 80 },
	{ key: 'bin', label: 'Bin', w: 52 },
];
const SCALE = TABLE_W / COLUMNS.reduce((s, c) => s + c.w, 0);
const COLS = COLUMNS.map((c) => ({ ...c, w: c.w * SCALE }));

const CELL_SIZE = 8;
const CELL_LINE = 9.5;
const HEAD_H = 18;

/** Helvetica is WinAnsi: anything else would throw, so it becomes "?". */
function safe(text) {
	return String(text ?? '').replace(/[^\x20-\x7E\xA0-\xFF–—‘’“”•]/g, '?');
}

function formatDate(iso) {
	if (!iso) return '';
	const [y, m, d] = iso.slice(0, 10).split('-');
	const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	return `${d}-${months[Number(m) - 1] ?? m}-${y}`;
}

function formatQty(n) {
	return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 }).format(n ?? 0);
}

/** Words to lines within a width; a word longer than the width (a batch no.) is broken by characters. */
function wrap(text, font, size, width) {
	const out = [];
	for (const para of safe(text).split('\n')) {
		let line = '';
		for (const word of para.split(/\s+/).filter(Boolean)) {
			const candidate = line ? `${line} ${word}` : word;
			if (font.widthOfTextAtSize(candidate, size) <= width) {
				line = candidate;
				continue;
			}
			if (line) out.push(line);
			line = '';
			let rest = word;
			while (font.widthOfTextAtSize(rest, size) > width) {
				let cut = rest.length - 1;
				while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > width) cut -= 1;
				out.push(rest.slice(0, cut));
				rest = rest.slice(cut);
			}
			line = rest;
		}
		out.push(line);
	}
	return out.length ? out : [''];
}

function cellText(line, key) {
	return key === 'quantity' ? formatQty(line.quantity) : line[key] ?? '';
}

function rowLines(fonts, line) {
	return COLS.map((c) => wrap(cellText(line, c.key), fonts.regular, CELL_SIZE, c.w - 6));
}

function rowHeight(cells) {
	return Math.max(...cells.map((l) => l.length)) * CELL_LINE + 6;
}

/** "2958", or "1500 Sheet + 2 Kg" when the slip mixes units. */
function totalText(lines) {
	const byUnit = new Map();
	for (const l of lines) {
		const key = String(l.unit ?? '').trim().toUpperCase();
		const e = byUnit.get(key) ?? { unit: l.unit ?? '', total: 0 };
		e.total += l.quantity;
		byUnit.set(key, e);
	}
	const totals = [...byUnit.values()];
	if (totals.length <= 1) return formatQty(totals[0]?.total ?? 0);
	return totals.map((t) => `${formatQty(t.total)} ${t.unit}`.trim()).join(' + ');
}

/** Everything above the table: company header, title, fields. Returns the y below it. */
function drawTop(page, ctx, topY) {
	const { fonts, logo, slip } = ctx;
	const logoW = 52;
	if (logo) {
		const h = (logo.height / logo.width) * logoW;
		page.drawImage(logo, { x: MARGIN, y: topY - h - 4, width: logoW, height: h });
	}
	const x = MARGIN + logoW + 18;
	const valueX = x + 62;
	page.drawText('CDC Printers (P) Ltd.', { x, y: topY - 12, size: 12, font: fonts.bold, color: BLACK });
	page.drawText('Regd Off -', { x, y: topY - 26, size: 9, font: fonts.bold, color: BLACK });
	page.drawText('Tangra Industrial Estate - II ,45. Radhanath Chowdhury Road', { x: x + 48, y: topY - 26, size: 9, font: fonts.regular });
	page.drawText('Kolkata - 700015, India', { x: valueX + 30, y: topY - 37, size: 9, font: fonts.regular });
	page.drawText('Unit II -', { x, y: topY - 54, size: 9, font: fonts.bold, color: BLACK });
	page.drawText('Village - Kulai, P.O.: Bikihakola, P.S.: Panchla, Dist: Howrah,', { x: valueX, y: topY - 54, size: 9, font: fonts.regular });
	page.drawText('Pin: 711322 , India', { x: valueX + 4, y: topY - 65, size: 9, font: fonts.regular });

	const boxTop = topY - 74;
	const title = 'Item Issue Slip';
	const titleW = fonts.bold.widthOfTextAtSize(title, 11);
	page.drawText(title, { x: MARGIN + (CONTENT_W - titleW) / 2, y: boxTop - 14, size: 11, font: fonts.bold });
	if (slip.deleted) {
		page.drawText('DELETED', { x: MARGIN + (CONTENT_W + titleW) / 2 + 12, y: boxTop - 14, size: 11, font: fonts.bold, color: RED });
	}
	page.drawLine({ start: { x: MARGIN, y: boxTop - 20 }, end: { x: MARGIN + CONTENT_W, y: boxTop - 20 }, thickness: 0.8 });

	const leftLabelX = MARGIN + PAD + 4;
	const leftValueX = leftLabelX + 92;
	const rightLabelX = MARGIN + CONTENT_W * 0.6;
	const rightValueX = rightLabelX + 64;
	const rightValueW = MARGIN + CONTENT_W - PAD - rightValueX;
	const rowY = (i) => boxTop - 34 - i * 14;

	const field = (label, value, lx, vx, y, bold = false) => {
		page.drawText(label, { x: lx, y, size: 8.5, font: fonts.bold });
		page.drawText(safe(value), { x: vx, y, size: 8.5, font: bold ? fonts.bold : fonts.regular });
	};
	field('Job Card No:', slip.jobCardNo ?? '', leftLabelX, leftValueX, rowY(0), true);
	field('Department Name:', slip.departmentName ?? '', leftLabelX, leftValueX, rowY(1));
	field('Client Name:', slip.clientName ?? '', leftLabelX, leftValueX, rowY(2));
	field('Issue No:', slip.voucherNo ?? '', rightLabelX, rightValueX, rowY(0));
	field('Issue Date:', formatDate(slip.voucherDate), rightLabelX, rightValueX, rowY(1));

	page.drawText('Job Name :', { x: rightLabelX, y: rowY(2), size: 8.5, font: fonts.bold });
	const jobLines = wrap(slip.jobName ?? '', fonts.regular, 8.5, rightValueW);
	jobLines.forEach((l, i) => page.drawText(l, { x: rightValueX, y: rowY(2) - i * 10.5, size: 8.5, font: fonts.regular }));

	return Math.min(rowY(2), rowY(2) - (jobLines.length - 1) * 10.5) - 12;
}

function drawTableHeader(page, fonts, y) {
	let x = MARGIN + PAD;
	page.drawRectangle({ x, y: y - HEAD_H, width: TABLE_W, height: HEAD_H, color: GREY_HEAD, borderColor: BLACK, borderWidth: 0.6 });
	for (const c of COLS) {
		const w = fonts.bold.widthOfTextAtSize(c.label, 8.5);
		page.drawText(c.label, { x: x + (c.w - w) / 2, y: y - 12, size: 8.5, font: fonts.bold, color: WHITE });
		if (x > MARGIN + PAD) page.drawLine({ start: { x, y }, end: { x, y: y - HEAD_H }, thickness: 0.6, color: WHITE });
		x += c.w;
	}
	return y - HEAD_H;
}

function drawRow(page, fonts, y, cells) {
	const h = rowHeight(cells);
	let x = MARGIN + PAD;
	page.drawRectangle({ x, y: y - h, width: TABLE_W, height: h, borderColor: BLACK, borderWidth: 0.6 });
	COLS.forEach((c, i) => {
		if (i > 0) page.drawLine({ start: { x, y }, end: { x, y: y - h }, thickness: 0.6 });
		cells[i].forEach((text, k) => {
			const w = fonts.regular.widthOfTextAtSize(text, CELL_SIZE);
			const tx = c.align === 'right' ? x + c.w - 4 - w : x + (c.w - w) / 2;
			page.drawText(text, { x: tx, y: y - 10 - k * CELL_LINE, size: CELL_SIZE, font: fonts.regular });
		});
		x += c.w;
	});
	return y - h;
}

/** Total, narration and signatures. Returns the y below them. */
function drawBottom(page, ctx, y) {
	const { fonts, slip } = ctx;
	const qtyCol = COLS.findIndex((c) => c.key === 'quantity');
	const qtyX = MARGIN + PAD + COLS.slice(0, qtyCol).reduce((s, c) => s + c.w, 0);
	const label = 'Total :';
	page.drawText(label, { x: qtyX - 6 - fonts.bold.widthOfTextAtSize(label, 8.5), y: y - 12, size: 8.5, font: fonts.bold });
	const total = totalText(slip.lines);
	const totalW = fonts.bold.widthOfTextAtSize(safe(total), 8.5);
	const totalX = totalW <= COLS[qtyCol].w - 4 ? qtyX + COLS[qtyCol].w - 4 - totalW : qtyX + 2;
	page.drawText(safe(total), { x: totalX, y: y - 12, size: 8.5, font: fonts.bold });

	let cy = y - 22;
	page.drawLine({ start: { x: MARGIN, y: cy }, end: { x: MARGIN + CONTENT_W, y: cy }, thickness: 0.8 });
	page.drawText('Narration', { x: MARGIN + PAD + 4, y: cy - 13, size: 8.5, font: fonts.bold });
	const narr = wrap(slip.narration ?? '', fonts.regular, 8.5, CONTENT_W - 80);
	narr.forEach((l, i) => page.drawText(l, { x: MARGIN + 70, y: cy - 13 - i * 10.5, size: 8.5, font: fonts.regular }));
	cy = cy - 13 - Math.max(1, narr.length) * 10.5 - 14;

	page.drawText('Checked By', { x: MARGIN + PAD + 4, y: cy, size: 8.5, font: fonts.bold });
	const rec = 'Received By';
	page.drawText(rec, { x: MARGIN + (CONTENT_W - fonts.bold.widthOfTextAtSize(rec, 8.5)) / 2, y: cy, size: 8.5, font: fonts.bold });
	const iss = 'Issued By';
	page.drawText(iss, { x: MARGIN + CONTENT_W - PAD - 4 - fonts.bold.widthOfTextAtSize(iss, 8.5), y: cy, size: 8.5, font: fonts.bold });
	return cy - 10;
}

function boxOutline(page, top, bottom) {
	page.drawRectangle({ x: MARGIN, y: bottom, width: CONTENT_W, height: top - bottom, borderColor: BLACK, borderWidth: 0.8 });
}

/** Height a whole copy needs, to decide whether two fit on a page. */
function copyHeight(ctx, rows) {
	const { fonts, slip } = ctx;
	const rightValueW = MARGIN + CONTENT_W - 8 - (MARGIN + CONTENT_W * 0.6 + 64);
	const jobExtra = (wrap(slip.jobName ?? '', fonts.regular, 8.5, rightValueW).length - 1) * 10.5;
	const narrLines = Math.max(1, wrap(slip.narration ?? '', fonts.regular, 8.5, CONTENT_W - 80).length);
	const tableH = HEAD_H + rows.reduce((s, r) => s + rowHeight(r), 0);
	return 74 + 74 + jobExtra + 12 + tableH + 22 + 13 + narrLines * 10.5 + 14 + 18;
}

/** One copy between topY and bottomY on a page that is known to fit it. */
function drawCopy(page, ctx, rows, topY) {
	let y = drawTop(page, ctx, topY);
	y = drawTableHeader(page, ctx.fonts, y);
	for (const r of rows) y = drawRow(page, ctx.fonts, y, r);
	const bottom = drawBottom(page, ctx, y);
	boxOutline(page, topY - 74, bottom);
}

/** One copy over as many full pages as it needs, the table header repeated on each. */
function drawCopyPaged(pdfDoc, ctx, rows) {
	let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
	const topY = PAGE_H - MARGIN;
	let boxTop = topY - 74;
	let y = drawTableHeader(page, ctx.fonts, drawTop(page, ctx, topY));
	const footerNeed = 90;
	for (const r of rows) {
		if (y - rowHeight(r) < MARGIN + 10) {
			boxOutline(page, boxTop, y - 6);
			page = pdfDoc.addPage([PAGE_W, PAGE_H]);
			boxTop = PAGE_H - MARGIN;
			const cont = `${ctx.slip.voucherNo ?? ''} (continued)`;
			page.drawText(safe(cont), { x: MARGIN + PAD, y: boxTop - 14, size: 9, font: ctx.fonts.bold });
			y = drawTableHeader(page, ctx.fonts, boxTop - 22);
		}
		y = drawRow(page, ctx.fonts, y, r);
	}
	if (y - footerNeed < MARGIN) {
		boxOutline(page, boxTop, y - 6);
		page = pdfDoc.addPage([PAGE_W, PAGE_H]);
		boxTop = PAGE_H - MARGIN;
		y = boxTop - 4;
	}
	boxOutline(page, boxTop, drawBottom(page, ctx, y));
}

/** Dashed cut line with a pair of scissors at each end. */
function drawCutLine(page, y) {
	page.drawLine({ start: { x: MARGIN + 26, y }, end: { x: PAGE_W - MARGIN - 26, y }, thickness: 0.8, dashArray: [6, 4] });
	for (const [cx, dir] of [[MARGIN + 10, 1], [PAGE_W - MARGIN - 10, -1]]) {
		page.drawCircle({ x: cx - dir * 6, y: y + 4, size: 3, borderColor: BLACK, borderWidth: 0.9 });
		page.drawCircle({ x: cx - dir * 6, y: y - 4, size: 3, borderColor: BLACK, borderWidth: 0.9 });
		page.drawLine({ start: { x: cx - dir * 3.5, y: y + 2.5 }, end: { x: cx + dir * 12, y: y - 3 }, thickness: 1 });
		page.drawLine({ start: { x: cx - dir * 3.5, y: y - 2.5 }, end: { x: cx + dir * 12, y: y + 3 }, thickness: 1 });
	}
}

export async function generateIssueSlipPdf(slip) {
	const pdfDoc = await PDFDocument.create();
	pdfDoc.setTitle(`Item Issue Slip ${slip.voucherNo ?? ''}`.trim());
	pdfDoc.setCreator('CDC Stock Issue Tool');
	const fonts = {
		regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
		bold: await pdfDoc.embedFont(StandardFonts.HelveticaBold),
	};
	let logo = null;
	if (existsSync(LOGO_PATH)) {
		const bytes = readFileSync(LOGO_PATH);
		try {
			// The file is named .png but holds a JPEG; embed by content.
			logo = bytes[0] === 0x89 ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
		} catch {
			logo = null;
		}
	}
	const ctx = { fonts, logo, slip };
	const rows = slip.lines.map((l) => rowLines(fonts, l));
	const half = PAGE_H / 2 - MARGIN - HALF_GAP;

	if (copyHeight(ctx, rows) <= half) {
		const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
		drawCopy(page, ctx, rows, PAGE_H - MARGIN);
		drawCutLine(page, PAGE_H / 2);
		drawCopy(page, ctx, rows, PAGE_H / 2 - HALF_GAP);
	} else {
		drawCopyPaged(pdfDoc, ctx, rows);
		drawCopyPaged(pdfDoc, ctx, rows);
	}
	return pdfDoc.save();
}

export const _test = { wrap, totalText, safe };
