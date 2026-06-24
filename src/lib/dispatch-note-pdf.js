import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMAGES_DIR = join(__dirname, '..', '..', 'images');
const LOGO_CANDIDATES = [
    'cdc logo.png',
    'cdc_logo.png',
    'cdc_logo.jpg',
    'cdc_logo.jpeg',
    'cdc_logo.webp',
    'cdc_logo.PNG'
];

const COMPANY_LINES = [
    'CDC Printers (P) Ltd.',
    'Regd Off: Tangra Industrial Estate - II, 45, Radhanath Chowdhury Road, Kolkata - 700015, India.',
    'Unit II: Village - Kulai, P.O.: Bikihakola, P.S.: Panchla, Dist: Howrah, Pin: 711322, India.'
];

const TABLE_COLUMNS = [
    { key: 'pwoNo', label: 'PWO No', width: 68 },
    { key: 'productName', label: 'Product Name', width: 126 },
    { key: 'hsnCode', label: 'HSN Code', width: 50 },
    { key: 'noOfBoxes', label: 'No of Boxes', width: 46 },
    { key: 'totalQuantity', label: 'Total Quantity', width: 50 },
    { key: 'grossWeightKg', label: 'Gross Weight (Kg)', width: 68 },
    { key: 'batchNo', label: 'Batch No.', width: 48 },
    { key: 'barcodeRange', label: 'Barcode Range', width: 59 }
];

function pickField(row, ...keys) {
    if (!row || typeof row !== 'object') return '';
    for (const key of keys) {
        if (row[key] != null && row[key] !== '') return row[key];
        const target = String(key).toLowerCase();
        for (const [rk, rv] of Object.entries(row)) {
            if (String(rk).toLowerCase() === target && rv != null && rv !== '') return rv;
        }
    }
    return '';
}

export function normalizeDispatchHeader(row) {
    if (!row) return null;
    return {
        status: pickField(row, 'Status'),
        fgTransactionId: pickField(row, 'FGTransactionID', 'FGTransactionId'),
        challanNo: pickField(row, 'ChallanNo', 'Challan No', 'VoucherNo'),
        challanDate: pickField(row, 'ChallanDate', 'Challan Date'),
        poNo: pickField(row, 'PONo', 'PO No'),
        clientName: pickField(row, 'ClientName', 'Client Name'),
        clientAddress: pickField(row, 'ClientAddress', 'Client Address'),
        deliveredToName: pickField(row, 'DeliveredToName', 'Delivered To Name'),
        deliveredToAddress: pickField(row, 'DeliveredToAddress', 'Delivered To Address'),
        containerNo: pickField(row, 'ContainerNo', 'Container No') || '-',
        sealNo: pickField(row, 'SealNo', 'Seal No') || '-',
        transporterName: pickField(row, 'TransporterName', 'Transporter Name'),
        vehicleNo: pickField(row, 'VehicleNo', 'Vehicle No'),
        remark: pickField(row, 'Remark') || ''
    };
}

export function normalizeDispatchLine(row) {
    if (!row) return null;
    const barcodeRange = pickField(row, 'BarcodeRange', 'Barcode Range');
    const barcodeFrom = pickField(row, 'BarcodeFrom', 'Barcode From');
    const barcodeTo = pickField(row, 'BarcodeTo', 'Barcode To');
    const rangeText = barcodeRange || (barcodeFrom && barcodeTo ? `${barcodeFrom}-${barcodeTo}` : '');
    const grossRaw = pickField(row, 'GrossWeightKg', 'Gross Weight (Kg)', 'GrossWeight');
    return {
        pwoNo: pickField(row, 'PWONo', 'PWO No'),
        productName: pickField(row, 'ProductName', 'Product Name'),
        hsnCode: pickField(row, 'HSNCode', 'HSN Code'),
        noOfBoxes: pickField(row, 'NoOfBoxes', 'No of Boxes'),
        totalQuantity: pickField(row, 'TotalQuantity', 'Total Quantity'),
        grossWeightKg: grossRaw === '' || grossRaw == null ? '0.000' : String(grossRaw),
        batchNo: pickField(row, 'BatchNo', 'Batch No') || '',
        barcodeRange: rangeText
    };
}

function formatDispatchDate(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) {
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return `${parsed.getDate()}-${months[parsed.getMonth()]}-${parsed.getFullYear()}`;
    }
    return text.replace(/\s+/g, '-');
}

function displayValue(value, fallback = '-') {
    const text = String(value ?? '').trim();
    return text || fallback;
}

function wrapText(text, maxWidth, font, size) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    if (words.length === 0) return [''];
    const lines = [];
    let current = words[0];
    for (let i = 1; i < words.length; i += 1) {
        const next = `${current} ${words[i]}`;
        if (font.widthOfTextAtSize(next, size) <= maxWidth) {
            current = next;
        } else {
            lines.push(current);
            current = words[i];
        }
    }
    lines.push(current);
    return lines;
}

function findLogoPath() {
    for (const name of LOGO_CANDIDATES) {
        const full = join(IMAGES_DIR, name);
        if (existsSync(full)) return full;
    }
    return null;
}

function detectImageType(bytes) {
    if (!bytes || bytes.length < 4) return null;
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
    return null;
}

async function embedLogo(pdfDoc) {
    const logoPath = findLogoPath();
    if (!logoPath) return null;
    const rawBytes = readFileSync(logoPath);
    const imageType = detectImageType(rawBytes);
    if (!imageType) return null;

    const bytes = await sharp(rawBytes)
        .modulate({ brightness: 0.78, saturation: 1.2 })
        .toBuffer();

    if (imageType === 'png') return pdfDoc.embedPng(bytes);
    if (imageType === 'jpg') return pdfDoc.embedJpg(bytes);
    return null;
}

function drawTextLines(page, lines, x, y, font, size, color = rgb(0, 0, 0), lineHeight = 11) {
    let cursorY = y;
    lines.forEach((line) => {
        page.drawText(line, { x, y: cursorY, size, font, color });
        cursorY -= lineHeight;
    });
    return cursorY;
}

function drawBox(page, x, y, width, height, borderColor = rgb(0, 0, 0)) {
    page.drawRectangle({
        x,
        y: y - height,
        width,
        height,
        borderColor,
        borderWidth: 1
    });
}

function drawTableHeader(page, fonts, x, y, width) {
    const fontSize = 7;
    const lineHeight = 8;
    const cellPadding = 3;
    const headerLines = TABLE_COLUMNS.map((col) =>
        wrapText(col.label, col.width - cellPadding * 2, fonts.bold, fontSize)
    );
    const maxLines = Math.max(1, ...headerLines.map((lines) => lines.length));
    const headerHeight = maxLines * lineHeight + 8;
    drawBox(page, x, y, width, headerHeight);
    let colX = x;
    TABLE_COLUMNS.forEach((col, idx) => {
        let textY = y - 11;
        headerLines[idx].forEach((line) => {
            page.drawText(line, {
                x: colX + cellPadding,
                y: textY,
                size: fontSize,
                font: fonts.bold
            });
            textY -= lineHeight;
        });
        colX += col.width;
    });
    return y - headerHeight;
}

function drawTableRow(page, fonts, x, y, row, width) {
    const cellPadding = 3;
    const fontSize = 7;
    const lineHeight = 9;
    const cellLines = TABLE_COLUMNS.map((col) =>
        wrapText(String(row[col.key] ?? ''), col.width - cellPadding * 2, fonts.regular, fontSize)
    );
    const maxLines = Math.max(1, ...cellLines.map((lines) => lines.length));
    const rowHeight = maxLines * lineHeight + 8;
    drawBox(page, x, y, width, rowHeight);

    let colX = x;
    TABLE_COLUMNS.forEach((col, idx) => {
        let textY = y - 11;
        cellLines[idx].forEach((line) => {
            page.drawText(line, {
                x: colX + cellPadding,
                y: textY,
                size: fontSize,
                font: fonts.regular
            });
            textY -= lineHeight;
        });
        colX += col.width;
    });
    return y - rowHeight;
}

function drawCopyLabel(page, fonts, label, pageWidth, margin, pageHeight) {
    const size = 10;
    const textWidth = fonts.bold.widthOfTextAtSize(label, size);
    const x = pageWidth - margin - textWidth;
    const y = pageHeight - margin - 8;
    page.drawText(label, { x, y, size, font: fonts.bold, color: rgb(0, 0, 0) });
    page.drawLine({
        start: { x, y: y - 2 },
        end: { x: x + textWidth, y: y - 2 },
        thickness: 0.8,
        color: rgb(0, 0, 0)
    });
}

function renderDispatchCopy(pdfDoc, ctx, copyLabel) {
    const { fonts, logo, header, lines, pageWidth, pageHeight, margin, contentWidth, createdBy } = ctx;

    let page = pdfDoc.addPage([pageWidth, pageHeight]);
    let y = pageHeight - margin;

    const LOGO_SIZE = 58;
    const LOGO_GAP = 10;
    const COMPANY_FONT_SIZE = 8;
    const COMPANY_LINE_HEIGHT = 10;
    const headerTopY = pageHeight - margin;
    const logoBottomY = headerTopY - LOGO_SIZE;

    if (logo) {
        page.drawImage(logo, { x: margin, y: logoBottomY, width: LOGO_SIZE, height: LOGO_SIZE });
    }

    const logoCenterY = logoBottomY + LOGO_SIZE / 2;
    const companyFirstBaselineY =
        logoCenterY + ((COMPANY_LINES.length - 1) / 2) * COMPANY_LINE_HEIGHT;
    const companyX = margin + LOGO_SIZE + LOGO_GAP;
    drawTextLines(
        page,
        COMPANY_LINES,
        companyX,
        companyFirstBaselineY,
        fonts.regular,
        COMPANY_FONT_SIZE,
        rgb(0, 0, 0),
        COMPANY_LINE_HEIGHT
    );

    drawCopyLabel(page, fonts, copyLabel, pageWidth, margin, pageHeight);

    const title = 'Dispatch Details';
    const titleWidth = fonts.bold.widthOfTextAtSize(title, 16);
    page.drawText(title, {
        x: (pageWidth - titleWidth) / 2,
        y: pageHeight - margin - 72,
        size: 16,
        font: fonts.bold
    });

    y = pageHeight - margin - 92;

    const metaHeight = 118;
    drawBox(page, margin, y, contentWidth, metaHeight);

    page.drawText(`Challan No. : ${displayValue(header.challanNo)}`, {
        x: margin + 8,
        y: y - 16,
        size: 9,
        font: fonts.bold
    });
    page.drawText(`Date : ${formatDispatchDate(header.challanDate)}`, {
        x: margin + 220,
        y: y - 16,
        size: 9,
        font: fonts.bold
    });
    page.drawText(`PO No. : ${displayValue(header.poNo)}`, {
        x: margin + 380,
        y: y - 16,
        size: 9,
        font: fonts.bold
    });

    page.drawLine({
        start: { x: margin, y: y - 24 },
        end: { x: margin + contentWidth, y: y - 24 },
        thickness: 0.8,
        color: rgb(0, 0, 0)
    });

    const leftColX = margin + 8;
    const rightColX = margin + contentWidth / 2 + 8;
    const colWidth = contentWidth / 2 - 16;

    page.drawText('Delivered To', { x: leftColX, y: y - 36, size: 9, font: fonts.bold });
    page.drawText('Client', { x: rightColX, y: y - 36, size: 9, font: fonts.bold });

    let leftY = y - 48;
    leftY = drawTextLines(
        page,
        wrapText(displayValue(header.deliveredToName), colWidth, fonts.bold, 9),
        leftColX,
        leftY,
        fonts.bold,
        9,
        rgb(0, 0, 0),
        10
    );
    drawTextLines(
        page,
        wrapText(displayValue(header.deliveredToAddress), colWidth, fonts.regular, 8),
        leftColX,
        leftY - 2,
        fonts.regular,
        8,
        rgb(0, 0, 0),
        9
    );

    let rightY = y - 48;
    rightY = drawTextLines(
        page,
        wrapText(displayValue(header.clientName), colWidth, fonts.bold, 9),
        rightColX,
        rightY,
        fonts.bold,
        9,
        rgb(0, 0, 0),
        10
    );
    drawTextLines(
        page,
        wrapText(displayValue(header.clientAddress), colWidth, fonts.regular, 8),
        rightColX,
        rightY - 2,
        fonts.regular,
        8,
        rgb(0, 0, 0),
        9
    );

    page.drawText(`Container No : ${displayValue(header.containerNo)}`, {
        x: leftColX,
        y: y - metaHeight + 18,
        size: 9,
        font: fonts.bold
    });
    page.drawText(`Seal No : ${displayValue(header.sealNo)}`, {
        x: rightColX,
        y: y - metaHeight + 18,
        size: 9,
        font: fonts.bold
    });

    y -= metaHeight + 14;
    page.drawText('Dear Sir, Kindly receive the materials as per detail below :', {
        x: margin,
        y,
        size: 9,
        font: fonts.regular
    });
    y -= 16;

    const tableWidth = TABLE_COLUMNS.reduce((sum, col) => sum + col.width, 0);
    const tableX = margin + (contentWidth - tableWidth) / 2;

    y = drawTableHeader(page, fonts, tableX, y, tableWidth);
    (lines || []).forEach((line) => {
        if (y < 130) {
            page = pdfDoc.addPage([pageWidth, pageHeight]);
            y = pageHeight - margin;
            y = drawTableHeader(page, fonts, tableX, y, tableWidth);
        }
        y = drawTableRow(page, fonts, tableX, y, line, tableWidth);
    });

    y -= 8;
    if (y < 110) {
        page = pdfDoc.addPage([pageWidth, pageHeight]);
        y = pageHeight - margin;
    }

    const footerRowHeight = 18;
    drawBox(page, tableX, y, tableWidth / 2, footerRowHeight);
    drawBox(page, tableX + tableWidth / 2, y, tableWidth / 2, footerRowHeight);
    page.drawText(`Transporter : ${displayValue(header.transporterName)}`, {
        x: tableX + 4,
        y: y - 12,
        size: 8,
        font: fonts.bold
    });
    page.drawText(`Vehicle No : ${displayValue(header.vehicleNo)}`, {
        x: tableX + tableWidth / 2 + 4,
        y: y - 12,
        size: 8,
        font: fonts.bold
    });
    y -= footerRowHeight;

    const remarkHeight = 22;
    drawBox(page, tableX, y, tableWidth, remarkHeight);
    page.drawText(`Remark : ${displayValue(header.remark, '')}`, {
        x: tableX + 4,
        y: y - 14,
        size: 8,
        font: fonts.regular
    });
    y -= remarkHeight + 24;

    page.drawText('Receiver Signature', { x: margin, y, size: 9, font: fonts.regular });
    const createdText = `Created By ${createdBy}`;
    const createdWidth = fonts.regular.widthOfTextAtSize(createdText, 9);
    page.drawText(createdText, {
        x: (pageWidth - createdWidth) / 2,
        y,
        size: 9,
        font: fonts.regular
    });
    page.drawText('For : CDC Printers Pvt. Ltd.', {
        x: pageWidth - margin - 130,
        y,
        size: 9,
        font: fonts.regular
    });
    page.drawText('Authorized Signatory', {
        x: pageWidth - margin - 95,
        y: y - 28,
        size: 9,
        font: fonts.regular
    });
}

export async function generateDispatchNotePdf(header, lines, options = {}) {
    const pdfDoc = await PDFDocument.create();
    const fonts = {
        regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
        bold: await pdfDoc.embedFont(StandardFonts.HelveticaBold)
    };
    const logo = await embedLogo(pdfDoc);

    const pageWidth = 595.28;
    const pageHeight = 841.89;
    const margin = 36;
    const contentWidth = pageWidth - margin * 2;
    const createdBy = displayValue(options.createdBy, '');

    const ctx = {
        fonts,
        logo,
        header,
        lines,
        pageWidth,
        pageHeight,
        margin,
        contentWidth,
        createdBy
    };

    renderDispatchCopy(pdfDoc, ctx, 'ORIGINAL');
    renderDispatchCopy(pdfDoc, ctx, 'DUPLICATE');

    return pdfDoc.save();
}
