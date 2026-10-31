#!/usr/bin/env node
// Loopback bridge: exposes POST /call on 127.0.0.1 and relays commands to the extension over a
// minimal WebSocket server. No dependencies, no accounts. Binds loopback only and refuses requests
// carrying a web Origin, so a visited website cannot drive the browser through it.
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

const PORT = Number(process.env.BRIDGE_PORT || 8787);
const HOST = '127.0.0.1';
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const TIMEOUT = 60000;

let client = null;
const pending = new Map();

const accept = key => createHash('sha1').update(key + GUID).digest('base64');

function frame(text) {
  const payload = Buffer.from(text);
  const length = payload.length;
  let header;
  if (length < 126) header = Buffer.from([0x81, length]);
  else if (length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(length), 2); }
  return Buffer.concat([header, payload]);
}

function frameSize(buffer) {
  const masked = (buffer[1] & 0x80) === 0x80;
  let length = buffer[1] & 0x7f, offset = 2;
  if (length === 126) { length = buffer.readUInt16BE(2); offset = 4; }
  else if (length === 127) { length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
  return { total: offset + (masked ? 4 : 0) + length, masked, offset, length };
}

function decode(buffer) {
  if (buffer.length < 2) return null;
  const size = frameSize(buffer);
  if (buffer.length < size.total) return null;
  const payload = Buffer.from(buffer.subarray(size.offset + (size.masked ? 4 : 0), size.total));
  if (size.masked) { const mask = buffer.subarray(size.offset, size.offset + 4); for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]; }
  return { opcode: buffer[0] & 0x0f, text: payload.toString('utf8'), total: size.total };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let data = '';
    request.on('data', chunk => { data += chunk; if (data.length > 200000) { reject(new Error('Request too large.')); request.destroy(); } });
    request.on('end', () => resolve(data));
    request.on('error', reject);
  });
}

function reply(response, status, payload) {
  const text = JSON.stringify(payload);
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
  response.end(text);
}

const server = createServer(async (request, response) => {
  // A page in the browser sends Origin; the extension and the MCP client never do.
  if (request.headers.origin) return reply(response, 403, { error: 'Origin requests are not allowed on the bridge.' });
  if (request.url === '/status') return reply(response, 200, { ok: true, connected: !!client, pending: pending.size });
  if (request.url === '/call' && request.method === 'POST') {
    let payload;
    try { payload = JSON.parse(await readBody(request)); } catch { return reply(response, 400, { error: 'Invalid JSON.' }); }
    if (!payload || typeof payload.type !== 'string') return reply(response, 400, { error: 'Each call needs a type.' });
    if (!client) return reply(response, 503, { error: 'The extension is not connected. Open the Webagent side panel and enable the bridge in Settings.' });
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reply(response, 504, { error: 'The extension did not answer in time.' }); }, TIMEOUT);
    pending.set(id, { response, timer });
    client.send(JSON.stringify({ id, type: payload.type, payload: payload.payload || {} }));
    return;
  }
  reply(response, 404, { error: 'Not found.' });
});

server.on('upgrade', (request, socket) => {
  const origin = request.headers.origin || '';
  if (origin && !origin.startsWith('chrome-extension://')) { socket.destroy(); return; }
  const key = request.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept(key)}\r\n\r\n`);
  socket.setNoDelay(true);
  let buffer = Buffer.alloc(0);
  const connection = { socket, send: text => { if (!socket.destroyed) socket.write(frame(text)); } };
  client = connection;
  console.log('[bridge] extension connected');
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const message = decode(buffer);
      if (!message) break;
      buffer = buffer.subarray(message.total);
      if (message.opcode === 8) { client = null; socket.destroy(); return; }
      if (message.opcode !== 1) continue;
      let parsed;
      try { parsed = JSON.parse(message.text); } catch { continue; }
      if (parsed.type === 'hello') { console.log(`[bridge] hello from extension ${parsed.version || ''}`); continue; }
      const waiting = pending.get(parsed.id);
      if (!waiting) continue;
      clearTimeout(waiting.timer);
      pending.delete(parsed.id);
      if (parsed.error) reply(waiting.response, 400, { error: parsed.error, code: parsed.code || 'ERROR' });
      else reply(waiting.response, 200, { data: parsed.data });
    }
  });
  socket.on('close', () => { if (client === connection) client = null; console.log('[bridge] extension disconnected'); });
  socket.on('error', () => { if (client === connection) client = null; });
});

server.listen(PORT, HOST, () => {
  console.log(`[bridge] listening on http://${HOST}:${PORT} — enable Settings → Local bridge in the panel`);
});
