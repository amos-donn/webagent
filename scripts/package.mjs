#!/usr/bin/env node
// Builds dist/mezze-extension.zip from extension/, or checks that the committed zip still matches.
//
// The zip used to be produced by hand with `zip -r`, which appends to an archive that already exists:
// running the documented command twice silently doubled every entry and doubled the file size. So the
// archive is always rebuilt from empty here, and `--check` compares every entry against the source so
// a stale zip fails loudly instead of shipping.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'extension');
const output = join(root, 'dist', 'mezze-extension.zip');
const checking = process.argv.includes('--check');
const SKIP = new Set(['.DS_Store', 'Thumbs.db']);

function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, base, out);
    else out.push(relative(base, path).split(/[\\/]/).join('/'));
  }
  return out.sort();
}

function zip(target) {
  rmSync(target, { force: true });
  execFileSync('zip', ['-qr', target, '.'], { cwd: source });
}

function entries(archive) {
  const list = execFileSync('unzip', ['-Z1', archive]).toString().split('\n').map(line => line.trim()).filter(Boolean);
  return list.filter(name => !name.endsWith('/'));
}

function content(archive, name) {
  return execFileSync('unzip', ['-p', archive, name], { cwd: undefined, maxBuffer: 64 * 1024 * 1024 });
}

const files = walk(source);
const problems = [];
const temporary = join(root, 'dist', `.check-${process.pid}.zip`);
const archive = checking ? temporary : output;

mkdirSync(join(root, 'dist'), { recursive: true });
// In check mode the archive is built beside the committed one and thrown away, so a check can never be
// the thing that hides a drift.
zip(archive);

try {
  const names = entries(archive);
  const duplicated = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicated.length) problems.push(`duplicate entries: ${[...new Set(duplicated)].join(', ')}`);

  for (const name of files) {
    if (!names.includes(name)) { problems.push(`missing from the zip: ${name}`); continue; }
    const packed = content(archive, name);
    const disk = readFileSync(join(source, name));
    if (!packed.equals(disk)) problems.push(`out of date in the zip: ${name}`);
  }
  for (const name of names) if (!files.includes(name)) problems.push(`in the zip but not in extension/: ${name}`);

  let version = '?';
  try { version = JSON.parse(content(archive, 'manifest.json').toString()).version; } catch { problems.push('manifest.json is not readable JSON inside the zip'); }

  if (problems.length) {
    console.error(`the committed zip does not match extension/ — run: node scripts/package.mjs`);
    for (const problem of problems.slice(0, 20)) console.error(`  ${problem}`);
    if (problems.length > 20) console.error(`  …and ${problems.length - 20} more`);
    process.exitCode = 1;
  } else {
    console.log(`dist/mezze-extension.zip — ${names.length} files, manifest ${version}${checking ? ', current' : ', rebuilt'}`);
  }
  if (!checking && process.exitCode !== 1) {
    console.log('Load it unpacked from the extracted folder in chrome://extensions.');
  }
} finally {
  if (checking) rmSync(archive, { force: true });
}
