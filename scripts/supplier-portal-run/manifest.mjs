/** The prepared files of the current run (Work/manifest.json, written by prepare.mjs). */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { DIRS, readJson } from './common.mjs';

export function findManifestItem(sha) {
  const file = path.join(DIRS.work, 'manifest.json');
  if (!existsSync(file)) return null;
  return (readJson(file).items || []).find((i) => i.sha256 === sha) || null;
}
