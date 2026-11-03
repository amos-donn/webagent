import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import landing from '../worker/landing.mjs';

// The page is the Worker's front door, so the checks here are the ones that would be embarrassing to
// ship: a document that does not close, a section the navbar links to that does not exist, or a button
// in a design that has none.
test('the landing page is a complete document', () => {
  assert.ok(landing.startsWith('<!doctype html>'));
  assert.ok(landing.trimEnd().endsWith('</html>'));
  assert.match(landing, /<title>Mezze/);
  assert.match(landing, /name="viewport"/);
  assert.match(landing, /name="description"/);
});

test('every navbar link has a section to land on', () => {
  const nav = landing.slice(landing.indexOf('<nav'), landing.indexOf('</nav>'));
  const targets = [...nav.matchAll(/href="#([\w-]+)"/g)].map(match => match[1]);
  assert.equal(targets.length, 4);
  for (const id of targets) {
    assert.match(landing, new RegExp(`id="${id}"`), `no section with id ${id}`);
  }
});

test('no buttons, and the only controls are links', () => {
  assert.doesNotMatch(landing, /<button/i);
  assert.doesNotMatch(landing, /type="submit"/i);
  assert.doesNotMatch(landing, /role="button"/i);
});

test('the topbar is glass, the page is white, and the type is Courier', () => {
  assert.match(landing, /backdrop-filter: blur\(/);
  assert.match(landing, /background: #fff/);
  assert.match(landing, /font: 15\.5px\/1\.68 var\(--mono\)/);
  assert.match(landing, /--mono: "Courier New"/);
});

test('the carousel has one slide and one tick each', () => {
  const slides = (landing.match(/<article class="slide">/g) || []).length;
  const ticks = (landing.match(/<div class="ticks"[\s\S]*?<\/div>/)[0].match(/<i><\/i>/g) || []).length;
  assert.ok(slides >= 4, `only ${slides} slides`);
  assert.equal(slides, ticks);
  assert.match(landing, /setInterval\(function \(\) \{ show\(index \+ 1\); \}, 6000\)/);
});

test('GET / serves the page before the database check', async () => {
  const [index, page] = await Promise.all([
    readFile(new URL('../worker/index.js', import.meta.url), 'utf8'),
    readFile(new URL('../worker/landing.mjs', import.meta.url), 'utf8')
  ]);
  // The worker is loaded from a data: URL so the test never needs a bundler, and its relative import
  // of the landing module is pointed at a data: URL of its own.
  const pageUrl = `data:text/javascript;base64,${Buffer.from(page).toString('base64')}`;
  const worker = (await import(`data:text/javascript;base64,${Buffer.from(index.replace("'./landing.mjs'", `'${pageUrl}'`)).toString('base64')}`)).default;
  const response = await worker.fetch(new Request('https://worker.test/'), {});
  assert.equal(response.status, 200, 'an unbound D1 database must not turn / into a 503');
  assert.match(response.headers.get('content-type'), /text\/html; charset=utf-8/);
  assert.equal(await response.text(), landing);
  const api = await worker.fetch(new Request('https://worker.test/agent', { method: 'POST', body: '{}' }), { DB: { prepare() { return { bind() { return { async first() { return { count: 1 }; } }; } }; } } });
  assert.equal(api.status, 400, 'the API still answers for itself');
});

test('the page makes no network requests of its own', () => {
  assert.doesNotMatch(landing, /<link[^>]+href="https?:/i);
  assert.doesNotMatch(landing, /<img/i);
  assert.doesNotMatch(landing, /fetch\(/);
});
