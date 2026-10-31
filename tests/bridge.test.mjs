import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const PORT = 8931;
const BASE = `http://127.0.0.1:${PORT}`;

async function ready() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try { const response = await fetch(`${BASE}/status`); if (response.ok) return; } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('The bridge did not start.');
}

test('bridge relays calls to the extension socket and refuses web origins', async () => {
  const bridge = spawn(process.execPath, ['bridge/server.mjs'], { env: { ...process.env, BRIDGE_PORT: String(PORT) }, stdio: 'ignore' });
  try {
    await ready();
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/`);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject); });
    socket.send(JSON.stringify({ type: 'hello', version: 'test' }));
    socket.addEventListener('message', event => {
      const request = JSON.parse(event.data);
      const data = request.type === 'observe'
        ? { url: 'https://example.com/', title: 'Example', refs: [{ ref: 'e1', role: 'button', name: 'Go' }], elements: [], text: 'hello', image: 'YWJj' }
        : { echoed: request.type, payload: request.payload };
      socket.send(JSON.stringify({ id: request.id, data }));
    });

    const response = await fetch(`${BASE}/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'tabs', payload: { a: 1 } }) });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, { echoed: 'tabs', payload: { a: 1 } });

    const blocked = await fetch(`${BASE}/call`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{"type":"tabs"}' });
    assert.equal(blocked.status, 403);

    const child = spawn(process.execPath, ['mcp/server.mjs'], { env: { ...process.env, BRIDGE_URL: BASE }, stdio: ['pipe', 'pipe', 'ignore'] });
    const responses = [];
    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      for (let index = buffer.indexOf('\n'); index !== -1; index = buffer.indexOf('\n')) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) responses.push(JSON.parse(line));
      }
    });
    const waitFor = async id => { for (let attempt = 0; attempt < 80; attempt++) { const found = responses.find(item => item.id === id); if (found) return found; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error(`no MCP response for ${id}`); };
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
    const init = await waitFor(1);
    assert.equal(init.result.serverInfo.name, 'webagent-bridge');
    const list = await waitFor(2);
    assert.ok(list.result.tools.some(tool => tool.name === 'browser_observe'));
    assert.ok(list.result.tools.some(tool => tool.name === 'browser_fill'));

    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_observe', arguments: {} } }) + '\n');
    const observed = await waitFor(3);
    assert.match(observed.result.content[0].text, /"ref":"e1"/);
    child.kill();
    socket.close();
  } finally {
    bridge.kill();
  }
});

test('bridge reports a clear error when no extension is connected', async () => {
  const bridge = spawn(process.execPath, ['bridge/server.mjs'], { env: { ...process.env, BRIDGE_PORT: '8932' }, stdio: 'ignore' });
  try {
    for (let attempt = 0; attempt < 80; attempt++) { try { const response = await fetch('http://127.0.0.1:8932/status'); if (response.ok) break; } catch { /* not up */ } await new Promise(resolve => setTimeout(resolve, 100)); }
    const response = await fetch('http://127.0.0.1:8932/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"type":"tabs"}' });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /not connected/i);
  } finally {
    bridge.kill();
  }
});
