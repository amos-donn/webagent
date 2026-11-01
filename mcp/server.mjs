#!/usr/bin/env node
// Minimal Model Context Protocol server over stdio. Each tool call is forwarded to the running
// bridge, which relays it to the extension. No dependencies: newline-delimited JSON-RPC 2.0.
const BRIDGE = process.env.BRIDGE_URL || 'http://127.0.0.1:8787';

const tools = [
  { name: 'browser_observe', description: 'Read the current tab: page text, accessibility-tree refs, element coordinates. Call this before acting.', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } } } },
  { name: 'browser_click', description: 'Click an element by ref (e.g. e12) or by viewport coordinates.', inputSchema: { type: 'object', properties: { ref: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, url: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' }, goal: { type: 'string' }, allow: { type: 'array', items: { type: 'string' } }, tabId: { type: 'number' } } } },
  { name: 'browser_type', description: 'Focus an element by ref and type text into it. submit presses Enter afterwards.', inputSchema: { type: 'object', required: ['text'], properties: { ref: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, text: { type: 'string' }, submit: { type: 'boolean' }, url: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' }, goal: { type: 'string' }, tabId: { type: 'number' } } } },
  { name: 'browser_fill', description: 'Fill several independent fields in one call. Each field takes a ref and text.', inputSchema: { type: 'object', required: ['fields'], properties: { fields: { type: 'array', items: { type: 'object', properties: { ref: { type: 'string' }, text: { type: 'string' } } } }, url: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' }, goal: { type: 'string' }, tabId: { type: 'number' } } } },
  { name: 'browser_key', description: 'Press one key or a chord the way a person would: Enter, Escape, Tab, arrows, PageUp/Down, Home, End, Backspace, Space, a printable character such as "/", or a chord like Control+K, Shift+Tab, Meta+Enter.', inputSchema: { type: 'object', required: ['key'], properties: { key: { type: 'string' }, tabId: { type: 'number' } } } },
  { name: 'browser_scroll', description: 'Scroll the page up or down.', inputSchema: { type: 'object', required: ['direction'], properties: { direction: { type: 'string', enum: ['up', 'down'] }, tabId: { type: 'number' } } } },
  { name: 'browser_navigate', description: 'Navigate the tab to an https:// (or localhost) URL.', inputSchema: { type: 'object', required: ['url'], properties: { url: { type: 'string' }, tabId: { type: 'number' } } } },
  { name: 'browser_read', description: 'Read the page text without screenshotting.', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } } } },
  { name: 'browser_screenshot', description: 'Capture the visible viewport as a JPEG image.', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } } } }
];

async function call(payload) {
  const response = await fetch(`${BRIDGE}/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const out = await response.json().catch(() => ({ error: 'The bridge returned no JSON.' }));
  if (!response.ok) throw new Error(out.error || `Bridge error ${response.status}.`);
  return out.data;
}

async function observe(args) {
  const data = await call({ type: 'observe', payload: { tabId: args.tabId } });
  return { content: [{ type: 'text', text: JSON.stringify({ url: data.url, title: data.title, refs: data.refs || [], elements: (data.elements || []).slice(0, 80), text: String(data.text || '').slice(0, 12000) }) }] };
}

async function screenshot(args) {
  const data = await call({ type: 'observe', payload: { tabId: args.tabId } });
  return { content: [{ type: 'image', data: data.image, mimeType: 'image/jpeg' }, { type: 'text', text: `${data.title} — ${data.url}` }] };
}

async function run(name, args) {
  if (name === 'browser_observe') return observe(args);
  if (name === 'browser_screenshot') return screenshot(args);
  if (name === 'browser_read') {
    const data = await call({ type: 'act', payload: { tabId: args.tabId, url: args.url, width: args.width, height: args.height, action: { type: 'read' } } });
    return { content: [{ type: 'text', text: String(data.text || '').slice(0, 20000) }] };
  }
  const action = name === 'browser_click' ? { type: 'click', ref: args.ref, x: args.x, y: args.y }
    : name === 'browser_type' ? { type: 'type', ref: args.ref, x: args.x, y: args.y, text: args.text, submit: args.submit === true }
    : name === 'browser_fill' ? { type: 'fill', fields: args.fields }
    : name === 'browser_key' ? { type: 'key', key: args.key }
    : name === 'browser_scroll' ? { type: 'scroll', direction: args.direction }
    : name === 'browser_navigate' ? { type: 'navigate', url: args.url }
    : null;
  if (!action) throw new Error(`Unknown tool ${name}.`);
  const data = await call({ type: 'act', payload: { tabId: args.tabId, url: args.url, width: args.width, height: args.height, allow: args.allow, goal: args.goal, action } });
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, effect: data.effect, fallback: data.fallback }) }] };
}

function respond(id, body) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...body }) + '\n'); }
function error(id, code, message) { respond(id, { error: { code, message } }); }

let buffer = '';
process.stdin.on('data', async chunk => {
  buffer += chunk.toString();
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline === -1) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { error(null, -32700, 'Parse error'); continue; }
    const { id, method, params } = message;
    if (method === 'initialize') { respond(id, { result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'webagent-bridge', version: '1.0.0' } } }); continue; }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') continue;
    if (method === 'ping') { respond(id, { result: {} }); continue; }
    if (method === 'tools/list') { respond(id, { result: { tools } }); continue; }
    if (method === 'tools/call') {
      const name = params?.name, args = params?.arguments || {};
      try { respond(id, { result: await run(name, args) }); }
      catch (e) { error(id, -32000, e.message); }
      continue;
    }
    error(id, -32601, `Method not found: ${method}`);
  }
});
