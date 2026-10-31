import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../worker/index.js', import.meta.url), 'utf8');
const worker = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).default;
const db = { prepare(sql) { return { bind() { return { async first() { return sql.includes('rate_limits') ? { count: 1 } : { id: 'user', email: 'a@example.com' }; } }; } }; } };
const observation = { goal:'Find the menu', text:'Menu', image:'YWJj', url:'https://example.com/', width:100, height:100, steps:[] };
function request(body) { return new Request('https://worker.example/agent', { method:'POST', headers: { Authorization:`Bearer ${'a'.repeat(64)}` }, body:JSON.stringify(body) }); }
test('agent uses free OpenRouter vision and JSON request, returning a validated action', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'openrouter/free');
    assert.equal(body.response_format.type, 'json_object');
    assert.equal(body.messages[0].content[1].image_url.url, 'data:image/jpeg;base64,YWJj');
    return Response.json({ choices:[{ message:{ content:JSON.stringify({type:'click', x:10, y:20, description:'Open menu'}) } }] });
  };
  try { const response = await worker.fetch(request(observation), {DB:db, OPENROUTER_API_KEY:'test-key'}); assert.equal(response.status, 200); assert.equal((await response.json()).action.type, 'click'); } finally { globalThis.fetch = original; }
});
test('other tabs are sent as read-only context', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const prompt = JSON.parse(options.body).messages[0].content[0].text;
    assert.match(prompt, /OTHER OPEN TABS/);
    assert.match(prompt, /Docs page/);
    assert.doesNotMatch(prompt, /not-a-url/);
    return Response.json({ choices:[{ message:{ content:JSON.stringify({type:'done', summary:'ok'}) } }] });
  };
  try { const response = await worker.fetch(request({ ...observation, contexts:[{ url:'https://docs.example/', title:'Docs page', text:'Reference material' }, { url:'', title:'bad', text:'not-a-url' }] }), {DB:db, OPENROUTER_API_KEY:'test-key'}); assert.equal(response.status, 200); } finally { globalThis.fetch = original; }
});
test('missing key and invalid coordinates fail safely', async () => {
  const missing = await worker.fetch(request(observation), {DB:db});
  assert.match((await missing.json()).error, /OPENROUTER_API_KEY/);
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({choices:[{message:{content:'{"type":"click","x":101,"y":1}'}}]});
  try { const response = await worker.fetch(request(observation), {DB:db, OPENROUTER_API_KEY:'test-key'}); assert.equal(response.status, 400); assert.match((await response.json()).error, /outside/); } finally { globalThis.fetch = original; }
});
