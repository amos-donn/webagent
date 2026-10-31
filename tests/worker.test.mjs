import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../worker/index.js', import.meta.url), 'utf8');
const worker = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).default;
const db = { prepare() { return { bind() { return { async first() { return { count: 1 }; } }; } }; } };
const observation = { goal:'Find the menu', text:'Menu', image:'YWJj', url:'https://example.com/', width:100, height:100, steps:[] };
function request(body, path = '/agent') { return new Request(`https://worker.example${path}`, { method:'POST', headers: { 'Content-Type':'application/json' }, body:JSON.stringify(body) });
}
// Serves one scripted reply per call and records the request bodies the worker built.
function scripted(replies) { const calls = []; const original = globalThis.fetch; let index = 0; globalThis.fetch = async (url, options) => { calls.push(JSON.parse(options.body)); const value = replies[Math.min(index++, replies.length - 1)]; return Response.json({ choices:[{ message:{ content: typeof value === 'string' ? value : JSON.stringify(value) } }] }); }; return { calls, restore: () => { globalThis.fetch = original; } }; }
const click = (extra = {}) => ({ type:'click', x:10, y:20, description:'Open menu', ...extra });

test('plan endpoint returns a numbered checklist without sending an image', async () => {
  const mock = scripted([{ steps:['Open the menu', 'Check the hours', ''] }]);
  try {
    const response = await worker.fetch(request({ goal:'Find the menu', url:'https://example.com/', title:'Example' }, '/plan'), { DB:db, OPENROUTER_API_KEY:'test-key' });
    assert.equal(response.status, 200);
    const out = await response.json();
    assert.deepEqual(out.todos, [{ id:'1', title:'Open the menu' }, { id:'2', title:'Check the hours' }]);
    assert.equal(typeof mock.calls[0].messages[0].content, 'string', 'planner must not send a screenshot');
    assert.equal(mock.calls[0].provider.sort, 'throughput');
  } finally { mock.restore(); }
});

test('the model is configurable with OPENROUTER_MODEL', async () => {
  const mock = scripted([{ steps:['One step'] }]);
  try {
    await worker.fetch(request({ goal:'Check prices', url:'https://example.com/' }, '/plan'), { DB:db, OPENROUTER_API_KEY:'test-key', OPENROUTER_MODEL:'openrouter/free' });
    assert.equal(mock.calls[0].model, 'openrouter/free');
  } finally { mock.restore(); }
});

test('prompt carries the plan, condensed older steps, element hints and todo filtering', async () => {
  const mock = scripted([{ type:'click', x:5, y:5, description:'Open menu', completed:['2','99'] }]);
  const steps = [
    ...Array.from({ length: 10 }, (_, i) => ({ type:'click', description:`old step ${i}`, ok:true })),
    { type:'type', description:'typed a query', ok:false, note:'not a text field', page:'https://example.com/' }
  ];
  try {
    const response = await worker.fetch(request({ ...observation, steps, todos:[{ id:'1', title:'Open the menu', done:true }, { id:'2', title:'Check the hours', done:false }], elements:[{ role:'button', name:'Menu', x:12, y:34 }, { role:'link', name:'', x:1, y:1 }] }), { DB:db, OPENROUTER_API_KEY:'test-key' });
    assert.equal(response.status, 200);
    const out = await response.json();
    assert.deepEqual(out.completed, ['2']);
    const prompt = mock.calls[0].messages[0].content[0].text;
    assert.match(prompt, /PLAN \(check items off/);
    assert.match(prompt, /1\. \[x\] Open the menu/);
    assert.match(prompt, /EARLIER \(3 steps, condensed\)/);
    assert.match(prompt, /type FAILED: typed a query/);
    assert.match(prompt, /result: not a text field/);
    assert.match(prompt, /INTERACTIVE ELEMENTS/);
    assert.match(prompt, /button "Menu" @ 12,34/);
    assert.doesNotMatch(prompt, /link ""/);
  } finally { mock.restore(); }
});

test('a repeated click is corrected once and the second choice is returned', async () => {
  const mock = scripted([click(), { type:'scroll', direction:'down', description:'Reveal more menu items' }]);
  const steps = [{ type:'click', x:11, y:19, description:'Open menu', ok:true }, { type:'click', x:10, y:21, description:'Open menu again', ok:true }];
  try {
    const response = await worker.fetch(request({ ...observation, steps }), { DB:db, OPENROUTER_API_KEY:'test-key' });
    const out = await response.json();
    assert.equal(out.action.type, 'scroll');
    assert.equal(out.retried, true);
    assert.equal(mock.calls.length, 2);
    assert.match(mock.calls[1].messages[0].content[0].text, /CORRECTION: click .* already tried 2 times/);
  } finally { mock.restore(); }
});

test('premature done is corrected, then reported with the unchecked plan ids', async () => {
  const mock = scripted([{ type:'done', summary:'All finished.' }, { type:'done', summary:'Could not sign in.', unfinished:['2'] }]);
  const todos = [{ id:'1', title:'Open the menu', done:true }, { id:'2', title:'Check the hours', done:false }];
  try {
    const response = await worker.fetch(request({ ...observation, todos }), { DB:db, OPENROUTER_API_KEY:'test-key' });
    const out = await response.json();
    assert.equal(mock.calls.length, 2);
    assert.match(mock.calls[1].messages[0].content[0].text, /CORRECTION: plan items 2 \(Check the hours\) are unchecked/);
    assert.equal(out.action.type, 'done');
    assert.deepEqual(out.incomplete, ['2']);
  } finally { mock.restore(); }
});

test('key actions validate and invalid ones are retried then rejected', async () => {
  const ok = scripted([{ type:'key', key:'Enter', description:'Submit search' }]);
  try {
    const response = await worker.fetch(request({ ...observation, steps:[{ type:'type', description:'typed search', ok:true }] }), { DB:db, OPENROUTER_API_KEY:'test-key' });
    assert.equal((await response.json()).action.key, 'Enter');
  } finally { ok.restore(); }
  const bad = scripted([{ type:'key', key:'F5', description:'Refresh' }]);
  try {
    const response = await worker.fetch(request(observation), { DB:db, OPENROUTER_API_KEY:'test-key' });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Unsupported key/);
    assert.equal(bad.calls.length, 2);
  } finally { bad.restore(); }
});

test('wrapped action JSON is unwrapped and out-of-frame clicks rejected', async () => {
  const mock = scripted([{ action:{ type:'click', x:150, y:1, description:'Too far right' } }]);
  try {
    const response = await worker.fetch(request(observation), { DB:db, OPENROUTER_API_KEY:'test-key' });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /outside the screenshot/);
  } finally { mock.restore(); }
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
