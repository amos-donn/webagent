#!/usr/bin/env node
// Signs the built extension into a Chrome package (CRX3) and writes the update feed Chrome reads.
//
// Without a Web Store listing, a CRX is the only way an install can update itself: the packaged
// manifest carries `update_url`, Chrome's updater fetches that XML every few hours, compares its
// version with the installed one, and replaces the extension in place. The extension id is derived
// from the signing key, so every release must be signed by the same key or Chrome sees a different
// extension and refuses the update — the key lives in the CRX_PRIVATE_KEY repository secret.
//
//   node scripts/crx.mjs --generate-key=dist/mezze-key.pem
//   node scripts/crx.mjs --codebase=https://github.com/u/r/releases/latest/download/mezze.crx
//   node scripts/crx.mjs --verify=dist/mezze.crx
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const MAGIC = Buffer.from('Cr24', 'ascii');
const SIGNATURE_CONTEXT = Buffer.from('CRX3 SignedData\x00', 'binary');
// Chrome builds the extension id out of the key fingerprint by naming each nibble.
const NIBBLES = 'abcdefghijklmnop';

const varint = value => {
  const bytes = [];
  let rest = value;
  while (rest > 0x7f) { bytes.push((rest & 0x7f) | 0x80); rest = Math.floor(rest / 128); }
  bytes.push(rest);
  return Buffer.from(bytes);
};
const uint32 = value => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value >>> 0);
  return bytes;
};
const lengthDelimited = (field, payload) => Buffer.concat([varint(field * 8 + 2), varint(payload.length), payload]);

export function extensionId(crxId) {
  return [...crxId].map(byte => NIBBLES[byte >> 4] + NIBBLES[byte & 15]).join('');
}

/**
 * Builds the signature payload Chrome verifies: a fixed context string, the signed header's length,
 * the header itself, then the zip. Anything else — the whole CRX, the zip alone — verifies as nothing.
 */
export function signedPayload(zip, signedHeaderData) {
  return Buffer.concat([SIGNATURE_CONTEXT, uint32(signedHeaderData.length), signedHeaderData, zip]);
}

export function build({ zip, privateKey, zipName = '' }) {
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  const publicKey = createPublicKey(key).export({ type: 'spki', format: 'der' });
  const crxId = createHash('sha256').update(publicKey).digest().subarray(0, 16);
  const signedHeaderData = lengthDelimited(1, crxId);
  const signature = sign('sha256', signedPayload(zip, signedHeaderData), key);
  const proof = Buffer.concat([lengthDelimited(1, publicKey), lengthDelimited(2, signature)]);
  const header = Buffer.concat([lengthDelimited(2, proof), lengthDelimited(10000, signedHeaderData)]);
  const crx = Buffer.concat([MAGIC, uint32(3), uint32(header.length), header, zip]);
  return { crx, crxId, publicKey, signature, signedHeaderData, id: extensionId(crxId), zip, zipName };
}

function readVarint(buffer, offset) {
  let value = 0, shift = 0, cursor = offset;
  for (;;) {
    const byte = buffer[cursor++];
    if (byte === undefined) throw new Error('truncated protobuf');
    value += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return [value, cursor];
    shift += 7;
    if (shift > 49) throw new Error('protobuf varint too long');
  }
}

function fields(buffer) {
  const out = [];
  let offset = 0;
  while (offset < buffer.length) {
    const [tag, afterTag] = readVarint(buffer, offset);
    const number = Math.floor(tag / 8), wire = tag & 7;
    if (wire !== 2) throw new Error(`unexpected wire type ${wire}`);
    const [length, afterLength] = readVarint(buffer, afterTag);
    out.push({ number, payload: buffer.subarray(afterLength, afterLength + length) });
    offset = afterLength + length;
  }
  return out;
}

/** Reads a CRX back into its parts, so the format can be checked without Chrome. */
export function inspect(crx) {
  if (!crx.subarray(0, 4).equals(MAGIC)) throw new Error('not a CRX: bad magic');
  const version = crx.readUInt32LE(4);
  const headerLength = crx.readUInt32LE(8);
  const header = crx.subarray(12, 12 + headerLength);
  const zip = crx.subarray(12 + headerLength);
  const proofs = [];
  let signedHeaderData = null;
  for (const field of fields(header)) {
    if (field.number === 2) {
      const parts = fields(field.payload);
      proofs.push({
        publicKey: parts.find(p => p.number === 1)?.payload,
        signature: parts.find(p => p.number === 2)?.payload,
      });
    }
    if (field.number === 10000) signedHeaderData = field.payload;
  }
  const crxId = signedHeaderData ? fields(signedHeaderData).find(field => field.number === 1)?.payload || null : null;
  return { version, headerLength, header, zip, proofs, signedHeaderData, crxId };
}

export function verifyCrx(crx) {
  const parsed = inspect(crx);
  const proof = parsed.proofs[0];
  if (!proof?.publicKey || !proof?.signature) throw new Error('no rsa proof in the CRX header');
  const keyObject = createPublicKey({ key: proof.publicKey, format: 'der', type: 'spki' });
  const ok = verify('sha256', signedPayload(parsed.zip, parsed.signedHeaderData), keyObject, proof.signature);
  const claimed = parsed.crxId;
  const derived = createHash('sha256').update(proof.publicKey).digest().subarray(0, 16);
  return { ...parsed, ok, id: extensionId(derived), idMatches: Boolean(claimed) && claimed.equals(derived) };
}

export function updatesXml({ codebase, version, id }) {
  return `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${id}'>
    <updatecheck codebase='${codebase}' version='${version}' />
  </app>
</gupdate>
`;
}

function keyFromEnv(name = 'CRX_PRIVATE_KEY') {
  const value = process.env[name];
  if (!value || !value.trim()) return null;
  const text = value.includes('-----BEGIN') ? value : Buffer.from(value, 'base64').toString('utf8');
  if (!text.includes('-----BEGIN PRIVATE KEY') && !text.includes('-----BEGIN RSA PRIVATE KEY')) {
    throw new Error(`${name} does not hold a PEM private key`);
  }
  return text.replace(/\\n/g, '\n');
}

function args(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const [name, inline] = arg.slice(2).split('=');
    out[name] = inline !== undefined ? inline : (argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true);
  }
  return out;
}

function main() {
  const options = args(process.argv.slice(2));
  const out = resolve(ROOT, typeof options.out === 'string' ? options.out : 'dist');
  mkdirSync(out, { recursive: true });

  if (options['generate-key']) {
    const target = resolve(ROOT, typeof options['generate-key'] === 'string' ? options['generate-key'] : join('dist', 'mezze-key.pem'));
    if (existsSync(target)) throw new Error(`${target} already exists — keep the key you have, or every install becomes a different extension`);
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, privateKey, { mode: 0o600 });
    chmodSync(target, 0o600);
    const id = extensionId(createHash('sha256').update(createPublicKey(publicKey).export({ type: 'spki', format: 'der' })).digest().subarray(0, 16));
    console.log(`wrote ${target} (owner-only)`);
    console.log(`extension id: ${id}`);
    console.log('Add the file as the repository secret CRX_PRIVATE_KEY, and never commit it.');
    return;
  }

  if (options.verify) {
    const crx = readFileSync(resolve(ROOT, options.verify));
    const result = verifyCrx(crx);
    if (!result.ok) throw new Error('the signature does not verify');
    if (!result.idMatches) throw new Error('the signed header names a different key than the one that signed it');
    console.log(`${options.verify}: CRX ${result.version}, ${result.zip.length} bytes of zip, signed and consistent, id ${result.id}`);
    return;
  }

  const version = JSON.parse(readFileSync(join(ROOT, 'extension', 'manifest.json'), 'utf8')).version;
  const zipPath = resolve(ROOT, typeof options.zip === 'string' ? options.zip : join('dist', 'mezze-extension.zip'));
  if (!existsSync(zipPath)) throw new Error(`${zipPath} is missing — run node scripts/package.mjs first`);
  const zip = readFileSync(zipPath);

  const keyText = keyFromEnv() || (existsSync(join(out, 'mezze-key.pem')) ? readFileSync(join(out, 'mezze-key.pem'), 'utf8') : null);
  if (!keyText) {
    // A release with no key still ships the zip; only the self-updating half is missing, and saying
    // that loudly beats a signature made with a throwaway key that no install would accept.
    console.log('::warning::no CRX_PRIVATE_KEY and no dist/mezze-key.pem — skipping the signed package');
    console.log('Generate one with --generate-key, add it as the CRX_PRIVATE_KEY secret, then push again.');
    return;
  }

  const result = build({ zip, privateKey: keyText, zipName: zipPath });
  const codebase = typeof options.codebase === 'string' ? options.codebase : '';
  if (codebase && !/^https:\/\//i.test(codebase)) throw new Error('--codebase must be an https URL: Chrome will not update from http');
  writeFileSync(join(out, 'mezze.crx'), result.crx);
  console.log(`dist/mezze.crx — ${result.crx.length} bytes, manifest ${version}, id ${result.id}`);
  if (codebase) {
    writeFileSync(join(out, 'updates.xml'), updatesXml({ codebase, version, id: result.id }));
    console.log(`dist/updates.xml — appid ${result.id}, version ${version}`);
  } else {
    console.log('no --codebase given, so no updates.xml was written');
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  try { main(); }
  catch (error) { console.error(`crx: ${error.message}`); process.exit(1); }
}
