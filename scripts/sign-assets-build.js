/**
 * Build the Gmail-signature images from the source PNGs in sign-icons/ into
 * the Render static site (sign-assets/public/), served at
 * https://assets.cdcprinters.com/sign/<version>/<name>.png
 *
 *   node scripts/sign-assets-build.js                 # builds into sign/v1/
 *   node scripts/sign-assets-build.js --version v2    # after changing an image
 *
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
 * NEVER OVERWRITE. Gmail's image proxy caches hard, so once a URL is in a
 * signature its bytes must not change. Every file written is recorded in
 * sign-assets/published.json with its SHA-256, and a rebuild that would
 * change a recorded file is refused — publish under the next --version
 * instead. `npm test` checks the same thing against what is committed.
 * --force overrides this; use it only for a URL nobody has ever opened —
 * pasting it into a Gmail signature even once to test counts, because
 * Gmail's proxy has then cached it (that is how sign/v1/ went stale).
 *
 * Sources that are absent are skipped, so the strip can ship before the
 * social icons arrive.
 */

import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'sign-icons');
export const PUBLIC_DIR = path.join(ROOT, 'sign-assets', 'public');
export const MANIFEST = path.join(ROOT, 'sign-assets', 'published.json');

export const ASSETS = [
  { name: 'facebook', kind: 'icon' },
  { name: 'instagram', kind: 'icon' },
  { name: 'youtube', kind: 'icon' },
  { name: 'linkedin', kind: 'icon' },
  { name: 'certifications', kind: 'banner' },
];

export const ICON_PX = 48;
export const ICON_MAX_BYTES = 2048;
const BANNER_PX = 1200;
const BANNER_MAX_BYTES = 80 * 1024;

// Anything at least this light on every channel becomes pure white.
const WHITE_THRESHOLD = 246;

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export function readManifest() {
  return fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : {};
}

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
  // Flat logo colours survive a smaller palette well; step down until the
  // budget is met (256 colours ran to 125 KB on the two-row strip, 128 to 39 KB).
  let buf;
  for (const colours of [256, 128, 64]) {
    buf = await sharp(padded)
      .resize({ width: BANNER_PX })
      .png({ palette: true, colours, compressionLevel: 9, effort: 10, dither: 0.5 })
      .toBuffer();
    if (buf.length <= BANNER_MAX_BYTES) return buf;
  }
  throw new Error(`${buf.length} bytes, over ${BANNER_MAX_BYTES} even at 64 colours`);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const version = arg('--version') || 'v1';
  const force = process.argv.includes('--force');
  if (!/^v\d+$/.test(version)) throw new Error(`--version must look like v1, v2, ... (got "${version}")`);

  const manifest = readManifest();
  const outDir = path.join(PUBLIC_DIR, 'sign', version);
  fs.mkdirSync(outDir, { recursive: true });
  let built = 0;
  let refused = 0;

  for (const asset of ASSETS) {
    const src = path.join(SRC_DIR, `${asset.name}.png`);
    const rel = `sign/${version}/${asset.name}.png`;
    if (!fs.existsSync(src)) {
      console.log(`skip     ${asset.name}.png (no source in sign-icons/)`);
      continue;
    }

    let buf;
    try {
      buf = asset.kind === 'icon' ? await buildIcon(src) : await buildBanner(src);
    } catch (err) {
      throw new Error(`${asset.name}.png: ${err.message}`);
    }
    const hash = sha256(buf);
    const prior = manifest[rel];

    if (prior && prior.sha256 === hash) {
      console.log(`same     ${rel}`);
      continue;
    }
    if (prior && !force) {
      const next = `v${Number(version.slice(1)) + 1}`;
      console.error(`REFUSED  ${rel} is already published with different bytes. Use --version ${next}.`);
      refused++;
      continue;
    }

    const meta = await sharp(buf).metadata();
    fs.writeFileSync(path.join(PUBLIC_DIR, rel), buf);
    manifest[rel] = { sha256: hash, bytes: buf.length, width: meta.width, height: meta.height };
    console.log(`${prior ? 'REPLACED' : 'built   '} ${rel}  ${meta.width}x${meta.height}  ${buf.length} bytes`);
    built++;
  }

  const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(MANIFEST, JSON.stringify(sorted, null, 2) + '\n');

  if (refused) process.exit(1);
  if (built === 0) console.log('Nothing new to build.');
}

// Run only when executed directly, so the test can import the constants.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
