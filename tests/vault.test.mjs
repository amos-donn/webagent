import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Vault = require('../extension/vault.js');

test('a path inside the vault is normalised and accepted', () => {
  assert.equal(Vault.safePath('reports/weekly.md'), 'reports/weekly.md');
  assert.equal(Vault.safePath('/reports//weekly.md'), 'reports/weekly.md');
  assert.equal(Vault.safePath('drafts/./today.md'), 'drafts/today.md');
  assert.equal(Vault.safePath('memory.md'), 'memory.md');
  assert.equal(Vault.safePath('uploads/1729-shot.png'), 'uploads/1729-shot.png');
  assert.equal(Vault.safePath('data\\table.csv'), 'data/table.csv', 'a Windows separator is still a separator');
});

test('a path that would escape or invent a folder is refused with a reason', () => {
  assert.throws(() => Vault.safePath('../memory.md'), /outside the vault/);
  assert.throws(() => Vault.safePath('reports/../../etc/passwd'), /outside the vault/);
  assert.throws(() => Vault.safePath('secrets/key.txt'), /Files live in/);
  assert.throws(() => Vault.safePath('reports'), /folder, not a file/, 'a folder is not a file');
  assert.throws(() => Vault.safePath('memory.md/notes.md'), /not a folder/);
  assert.throws(() => Vault.safePath(''), /needs a name/);
  assert.throws(() => Vault.safePath('reports/a/b/c/d/e/f/g.md'), /too deep/);
  assert.throws(() => Vault.safePath('reports/con.md'), /reserved on Windows/);
  assert.throws(() => Vault.safePath('reports/bad:name.md'), /characters a file cannot have/);
  assert.throws(() => Vault.safePath(`reports/${'a'.repeat(130)}.md`), /name is too long/);
});

test('a name becomes a slug that is safe on disk', () => {
  assert.equal(Vault.slug('Weekly Report: Q3 2026'), 'weekly-report-q3-2026');
  assert.equal(Vault.slug('  --hello--  '), 'hello');
  assert.equal(Vault.slug('!!!'), 'file', 'nothing usable falls back to a neutral name');
  assert.equal(Vault.slug('Ünïcode näme'), 'unicode-name');
  assert.equal(Vault.slug('a'.repeat(80)).length, 48);
});

test('text and binary files are told apart, and sizes read like sizes', () => {
  assert.equal(Vault.isText('reports/a.md'), true);
  assert.equal(Vault.isText('data/rows.csv'), true);
  assert.equal(Vault.isText('uploads/scan.pdf'), false);
  assert.equal(Vault.isText('uploads/photo.PNG'), false);
  assert.equal(Vault.humanSize(0), '0 B');
  assert.equal(Vault.humanSize(999), '999 B');
  assert.equal(Vault.humanSize(1536), '1.5 KB');
  assert.equal(Vault.humanSize(5 * 1024 * 1024), '5.0 MB');
  assert.equal(Vault.humanSize(null), '0 B');
});

test('the list puts folders first, then sorts by name', () => {
  const sorted = Vault.sortEntries([
    { name: 'b.md', kind: 'file' },
    { name: 'memory', kind: 'directory' },
    { name: 'a.md', kind: 'file' },
    { name: 'uploads', kind: 'directory' }
  ]);
  assert.deepEqual(sorted.map(entry => entry.name), ['memory', 'uploads', 'a.md', 'b.md']);
});

test('the caps the vault enforces are the documented ones', () => {
  assert.equal(Vault.MAX_TEXT, 2 * 1024 * 1024);
  assert.equal(Vault.MAX_UPLOAD, 25 * 1024 * 1024);
  assert.deepEqual(Vault.DIRS, ['memory', 'plans', 'reports', 'drafts', 'data', 'runs', 'transcripts', 'uploads']);
});
