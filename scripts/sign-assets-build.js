/**
 * Build the Gmail-signature images from the source PNGs in sign-icons/.
 *
 *   node scripts/sign-assets-build.js
 *
 * Output goes to sign-icons/dist/ and is what sign-assets-upload.js publishes.
 * Every asset is PNG — Gmail and Outlook do not render SVG or WebP reliably.
 * Each is built at 2x its display size so it stays sharp on retina screens.
 *
 *   facebook / instagram / youtube / linkedin
 *       48x48, displayed at 24x24, must come out under 2 KB.
 *   certifications
 *       the certification strip (BSCI, Disney, Sedex, ISO 9001, ISO 14001,
 *       EcoVadis). 1200 px wide, displayed at 600. Near-white background is
 *       flattened to pure white so no grey box shows against the email body.
 *
 * Sources that are absent are skipped, so the strip can ship before the
 * social icons arrive.
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname, '..', 'sign-icons');
const OUT_DIR = path.join(SRC_DIR, 'dist');

export const ASSETS = [
  { name: 'facebook', kind: 'icon' },
  { name: 'instagram', kind: 'icon' },
  { name: 'youtube', kind: 'icon' },
  { name: 'linkedin', kind: 'icon' },
  { name: 'certifications', kind: 'banner' },
];

const ICON_PX = 48;
const ICON_MAX_BYTES = 2048;
const BANNER_PX = 1200;
const BANNER_MAX_BYTES = 80 * 1024;

// Anything at least this light on every channel becomes pure white.
const WHITE_THRESHOLD = 246;

async function buildIcon(src) {
  // Try progressively smaller palettes until the 2 KB budget is met.
  for (const colours of [256, 128, 64, 32, 16]) {
    const buf = await sharp(src)
      .resize(ICON_PX, ICON_PX, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ palette: true, colours, compressionLevel: 9, effort: 10 })
      .toBuffer();
    if (buf.length <= ICON_MAX_BYTES) return buf;
  }
  throw new Error(`cannot get under ${ICON_MAX_BYTES} bytes even at 16 colours`);
}

async function buildBanner(src) {
  const { data, info } = await sharp(src)
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  for (let i = 0; i < data.length; i += 3) {
    if (data[i] >= WHITE_THRESHOLD && data[i + 1] >= WHITE_THRESHOLD && data[i + 2] >= WHITE_THRESHOLD) {
      data[i] = data[i + 1] = data[i + 2] = 255;
    }
  }

  // Trim the empty margin, keep a little breathing room, then scale to 2x.
  // Separate passes: within one pipeline sharp resizes before it extends,
  // which would leave the result wider than BANNER_PX.
  const trimmed = await sharp(data, { raw: info }).trim({ background: '#ffffff', threshold: 0 }).png().toBuffer();
  const padded = await sharp(trimmed)
    .extend({ top: 6, bottom: 6, left: 6, right: 6, background: '#ffffff' })
    .png()
    .toBuffer();
  return sharp(padded)
    .resize({ width: BANNER_PX })
    .png({ palette: true, colours: 256, compressionLevel: 9, effort: 10, dither: 0.5 })
    .toBuffer();
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let built = 0;

  for (const asset of ASSETS) {
    const src = path.join(SRC_DIR, `${asset.name}.png`);
    if (!fs.existsSync(src)) {
      console.log(`skip   ${asset.name}.png (no source in sign-icons/)`);
      continue;
    }
    const buf = asset.kind === 'icon' ? await buildIcon(src) : await buildBanner(src);
    if (asset.kind === 'banner' && buf.length > BANNER_MAX_BYTES) {
      throw new Error(`${asset.name}.png is ${buf.length} bytes, over ${BANNER_MAX_BYTES}`);
    }
    const meta = await sharp(buf).metadata();
    fs.writeFileSync(path.join(OUT_DIR, `${asset.name}.png`), buf);
    console.log(`built  ${asset.name}.png  ${meta.width}x${meta.height}  ${buf.length} bytes`);
    built++;
  }

  if (built === 0) {
    console.error('Nothing built. Put the source PNGs in sign-icons/ first.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
