/**
 * Guards the signature images served by the Render static site.
 *
 * Once a URL is in someone's signature, Gmail's proxy may serve its cached
 * copy for months, so a published file must never change. This test fails
 * if a committed file under sign-assets/public/sign/ differs from the hash
 * recorded in sign-assets/published.json, or is not recorded at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { PUBLIC_DIR, ICON_PX, ICON_MAX_BYTES, ASSETS, readManifest, sha256 } from './sign-assets-build.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const manifest = readManifest();

function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? filesUnder(path.join(dir, d.name)) : [path.join(dir, d.name)]
  );
}

test('every published file still has its recorded bytes', () => {
  for (const [rel, entry] of Object.entries(manifest)) {
    const file = path.join(PUBLIC_DIR, rel);
    assert.ok(fs.existsSync(file), `${rel} was published and must not be deleted`);
    assert.equal(
      sha256(fs.readFileSync(file)),
      entry.sha256,
      `${rel} changed after publishing. Restore it and put the new image under the next version folder.`
    );
  }
});

test('every file under sign/ is recorded in published.json', () => {
  const recorded = new Set(Object.keys(manifest));
  for (const file of filesUnder(path.join(PUBLIC_DIR, 'sign'))) {
    const rel = path.relative(PUBLIC_DIR, file).split(path.sep).join('/');
    assert.ok(recorded.has(rel), `${rel} is not in published.json. Add it with npm run sign-assets:build.`);
  }
});

test('published files are PNG, and icons are 48x48 under 2 KB', () => {
  const icons = new Set(ASSETS.filter((a) => a.kind === 'icon').map((a) => `${a.name}.png`));
  for (const [rel, entry] of Object.entries(manifest)) {
    const buf = fs.readFileSync(path.join(PUBLIC_DIR, rel));
    assert.ok(buf.subarray(0, 8).equals(PNG_MAGIC), `${rel} is not a PNG`);
    if (icons.has(path.basename(rel))) {
      assert.equal(entry.width, ICON_PX, `${rel} width`);
      assert.equal(entry.height, ICON_PX, `${rel} height`);
      assert.ok(buf.length <= ICON_MAX_BYTES, `${rel} is ${buf.length} bytes`);
    }
  }
});
