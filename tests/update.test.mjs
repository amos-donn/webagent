import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Update = require('../extension/update.js');

const feed = (version, codebase = 'https://example.com/mezze.crx') =>
  `<?xml version='1.0' encoding='UTF-8'?>\n<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n  <app appid='abcdefghijklmnopabcdefghijklmnop'>\n    <updatecheck codebase='${codebase}' version='${version}' />\n  </app>\n</gupdate>\n`;

test('a version is newer when its components are, numerically', () => {
  // String comparison says "1.9.10" < "1.9.9" and "1.10" < "1.9"; Chrome does not.
  assert.equal(Update.newer('1.10.0', '1.9.0'), true);
  assert.equal(Update.newer('1.9.10', '1.9.9'), true);
  assert.equal(Update.newer('2.0', '1.99.99'), true);
  assert.equal(Update.newer('1.10.0.1', '1.10.0'), true);
});

test('the same version, an older one, and junk are not updates', () => {
  assert.equal(Update.newer('1.9.0', '1.9.0'), false);
  assert.equal(Update.newer('1.8.9', '1.9.0'), false);
  assert.equal(Update.newer('', '1.9.0'), false);
  assert.equal(Update.newer('1.9.0-beta', '1.9.0'), false);
  assert.equal(Update.newer('1.9.0', 'not a version'), false);
});

test('a short version is compared with the missing components as zero', () => {
  assert.deepEqual(Update.parts('1.9'), [1, 9, 0, 0]);
  assert.deepEqual(Update.parts('1.9.0.4'), [1, 9, 0, 4]);
  assert.equal(Update.newer('1.9.0.0', '1.9'), false);
});

test('the feed yields the version and where to get it', () => {
  assert.deepEqual(Update.parse(feed('1.10.1')), {
    version: '1.10.1',
    codebase: 'https://example.com/mezze.crx',
  });
});

test('a feed over http, without a version, or not a feed at all is rejected', () => {
  // Chrome ignores an http codebase, and a download button built from it would fail for the user.
  assert.equal(Update.parse(feed('1.10.1', 'http://example.com/mezze.crx')), null);
  assert.equal(Update.parse("<gupdate><app><updatecheck codebase='https://x/y.crx'/></app></gupdate>"), null);
  assert.equal(Update.parse(''), null);
  assert.equal(Update.parse('<html>404</html>'), null);
  // A 404 page served as XML should not turn into a download link to nothing.
  assert.equal(Update.parse("<updatecheck codebase='https://x/y.crx' version='latest'/>"), null);
});

test('both stable links point at the latest release', () => {
  assert.match(Update.FEED_URL, /^https:\/\/github\.com\/amos-donn\/webagent\/releases\/latest\/download\/updates\.xml$/);
  assert.match(Update.ZIP_URL, /releases\/latest\/download\/mezze-extension\.zip$/);
});
