// The CRX is the half of auto-update that Chrome acts on, and there is no browser here to install it,
// so the format is checked by taking the package apart again: magic, lengths, the protobuf header, the
// signature over exactly the bytes Chrome signs, and the id Chrome identifies the extension by.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { build, extensionId, inspect, signedPayload, updatesXml, verifyCrx } from '../scripts/crx.mjs';

const keyPair = () => generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
}).privateKey;

const keys = keyPair();
const zip = Buffer.concat([Buffer.from('PK\x03\x04', 'binary'), Buffer.alloc(512, 7)]);

test('a built CRX is Cr24 version 3, and the zip comes back byte for byte', () => {
  const { crx } = build({ zip, privateKey: keys });
  assert.equal(crx.subarray(0, 4).toString('ascii'), 'Cr24');
  assert.equal(crx.readUInt32LE(4), 3);
  const headerLength = crx.readUInt32LE(8);
  assert.ok(headerLength > 0 && headerLength < 4096, 'header length is plausible');
  // Everything after the header must be the input zip, unchanged: Chrome verifies the signature over it.
  assert.deepEqual(crx.subarray(12 + headerLength), zip);
});

test('the signature verifies, and the id in the signed header is the signer', () => {
  const { crx, id } = build({ zip, privateKey: keys });
  const parsed = verifyCrx(crx);
  assert.equal(parsed.ok, true, 'RSA-SHA256 over the CRX3 payload');
  assert.equal(parsed.idMatches, true, 'the header names the key that signed it');
  assert.equal(parsed.id, id);
  assert.match(id, /^[a-p]{32}$/, 'Chrome extension ids are 32 characters a–p');
});

test('a changed zip no longer verifies', () => {
  const { crx } = build({ zip, privateKey: keys });
  const damaged = Buffer.from(crx);
  damaged[damaged.length - 1] ^= 0xff;
  assert.equal(verifyCrx(damaged).ok, false);
  // The signed header is covered too, so rewriting the id it names is caught.
  const retagged = Buffer.from(crx);
  const headerLength = retagged.readUInt32LE(8);
  const idAt = retagged.indexOf(Buffer.from([0x0a, 0x10]), 12);
  assert.ok(idAt > 0 && idAt < 12 + headerLength);
  retagged[idAt + 2] ^= 0xff;
  assert.equal(verifyCrx(retagged).ok, false);
});

test('the same key always yields the same id, and a different key a different one', () => {
  const first = build({ zip, privateKey: keys });
  const second = build({ zip, privateKey: keys });
  assert.equal(first.id, second.id, 'otherwise Chrome would treat a release as a different extension');
  assert.equal(first.signature.equals(second.signature), true, 'RSA PKCS#1 v1.5 is deterministic');
  assert.notEqual(build({ zip, privateKey: keyPair() }).id, first.id);
});

test('the update feed names the package and the version the manifest carries', () => {
  const { id } = build({ zip, privateKey: keys });
  const xml = updatesXml({ codebase: 'https://example.com/mezze.crx', version: '1.10.0', id });
  assert.match(xml, /<gupdate xmlns='http:\/\/www\.google\.com\/update2\/response' protocol='2\.0'>/);
  assert.match(xml, new RegExp(`<app appid='${id}'>`));
  assert.match(xml, /<updatecheck codebase='https:\/\/example\.com\/mezze\.crx' version='1\.10\.0' \/>/);
});

test('a malformed package is refused instead of half-read', () => {
  assert.throws(() => inspect(Buffer.from('not a crx at all')), /bad magic/);
  const empty = build({ zip: Buffer.alloc(0), privateKey: keys });
  assert.equal(verifyCrx(empty.crx).ok, true, 'an empty zip still verifies; version and id do not depend on it');
});

test('the signature covers the header length, not just the bytes', () => {
  // Chrome signs a 4-byte length prefix followed by the header. Signing the bare concatenation would
  // let two different header/zip splits verify against each other.
  const header = Buffer.from([0x0a, 0x10]);
  assert.deepEqual(signedPayload(zip, header), Buffer.concat([
    Buffer.from('CRX3 SignedData\x00', 'binary'),
    Buffer.from([2, 0, 0, 0]),
    header,
    zip,
  ]));
  assert.equal(extensionId(Buffer.alloc(16)).length, 32);
});
