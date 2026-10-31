import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../worker/index.js', import.meta.url), 'utf8');
const worker = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).default;
const db = { prepare() { return { bind() { return { async first() { return { count: 1 }; } }; } }; } };
const observation = { goal:'Find the menu', text:'Menu', image:'YWJj', url:'https://example.com/', width:100, height:100, steps:[] };
function request(body, path = '/agent') { return new Request(`https://worker.example${path}`, { method:'POST', headers: { 'Content-Type':'application/json' }, body:JSON.stringify(body) }); }
function mock(fn) { const original = globalThis.fetch; globalThis.fetch = fn; return () => { globalThis.fetch = original; }; }
const reply = value => Response.json({ choices:[{ message:{ content:JSON.stringify(value) } }] });

test('plan endpoint returns a numbered checklist without sending an image', async () => {
  const restore = mock(async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'google/gemini-3.5-flash-lite');
    assert.equal(body.provider.sort, 'throughput');
    assert.equal(body.response_format.type, 'json_object');
    assert.equal(typeof body.messages[0].content, 'string', 'planner must not send a screenshot');
    assert.match(body.messages[0].content, /Find the menu/);
    return reply({ steps:['Open the menu', 'Check the hours', ''] });
  });
  try {
    const response = await worker.fetch(request({ goal:'Find the menu', url:'https://example.com/', title:'Example' }, '/plan'), { DB:db, OPENROUTER_API_KEY:'test-key' });
    assert.equal(response.status, 200);
    const out = await response.json();
    assert.deepEqual(out.todos, [{ id:'1', title:'Open the menu' }, { id:'2', title:'Check the hours' }]);
    assert.equal(typeof out.ms, 'number');
  } finally { restore(); }
});

test('the model is configurable with OPENROUTER_MODEL', async () => {
  let sent;
  const restore = mock(async (url, options) => { sent = JSON.parse(options.body).model; return reply({ steps:['One step'] }); });
  try {
    await worker.fetch(request({ goal:'Check prices', url:'https://example.com/' }, '/plan'), { DB:db, OPENROUTER_API_KEY:'test-key', OPENROUTER_MODEL:'openrouter/free' });
    assert.equal(sent, 'openrouter/free');
  } finally { restore(); }
});

test('agent prompt carries the plan and only known todo ids are reported complete', async () => {
  const restore = mock(async (url, options) => {
    const prompt = JSON.parse(options.body).messages[0].content[0].text;
    assert.match(prompt, /PLAN/);
    assert.match(prompt, /1\. \[x\] Open the menu/);
    assert.match(prompt, /2\. \[ \] Check the hours/);
    return reply({ type:'click', x:10, y:20, description:'Open menu', completed:['2', '99'] });
  });
  try {
    const response = await worker.fetch(request({ ...observation, todos:[{ id:'1', title:'Open the menu', done:true }, { id:'2', title:'Check the hours', done:false }] }), { DB:db, OPENROUTER_API_KEY:'test-key' });
    assert.equal(response.status, 200);
    const out = await response.json();
    assert.deepEqual(out.completed, ['2']);
    assert.equal(out.action.type, 'click');
    assert.equal(out.action.completed, undefined);
  } finally { restore(); }
});

test('old verbose steps are trimmed and long step text is clipped', async () => {
  let prompt;
  const restore = mock(async (url, options) => { prompt = JSON.parse(options.body).messages[0].content[0].text; return reply({ type:'done', summary:'ok' }); });
  try {
    const steps = Array.from({ length: 20 }, (_, i) => `click: step ${i} ${'x'.repeat(400)}`);
    await worker.fetch(request({ ...observation, steps }), { DB:db, OPENROUTER_API_KEY:'test-key' });
    assert.doesNotMatch(prompt, /step 7 /);
    assert.match(prompt, /step 8 /);
    assert.match(prompt, /step 19 /);
    assert.doesNotMatch(prompt, /x{300}/);
  } finally { restore(); }
});

test('wrapped action JSON is unwrapped and coordinates are checked', async () => {
  const restore = mock(async () => reply({ action:{ type:'click', x:150, y:1, description:'Too far right' } }));
  try {
    const response = await worker.fetch(request(observation), { DB:db, OPENROUTER_API_KEY:'test-key' });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /outside/);
  } finally { restore(); }
});

test('invalid planning input, missing key and rate limits fail safely', async () => {
  const noGoal = await worker.fetch(request({ goal:'  ', url:'https://example.com/' }, '/plan'), { DB:db, OPENROUTER_API_KEY:'test-key' });
  assert.equal(noGoal.status, 400);
  const badUrl = await worker.fetch(request({ goal:'Do a thing', url:'chrome://settings' }, '/plan'), { DB:db, OPENROUTER_API_KEY:'test-key' });
  assert.equal(badUrl.status, 400);
  const missing = await worker.fetch(request(observation), { DB:db });
  assert.match((await missing.json()).error, /OPENROUTER_API_KEY/);
  const limitedDb = { prepare() { return { bind() { return { async first() { return { count: 9999 }; } }; } }; } };
  const throttled = await worker.fetch(request(observation), { DB:limitedDb, OPENROUTER_API_KEY:'test-key' });
  assert.equal(throttled.status, 429);
});
