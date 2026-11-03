import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Macros = require('../extension/macros.js');

const save = (extra = {}) => ({ k: 'role', value: 'button', name: 'Save', nth: 0, count: 1, ...extra });

test('replay tries an accessible name before a generated id and a css path last', () => {
  const ranked = Macros.rank([
    { k: 'css', value: 'div > div:nth-of-type(2) > button', count: 1 },
    { k: 'id', value: 'btn-9f3a21', count: 1 },
    save(),
    { k: 'text', value: 'Save', count: 1 }
  ]);
  assert.deepEqual(ranked.map(candidate => candidate.k), ['role', 'id', 'text', 'css']);
  assert.equal(ranked[0].name, 'Save');
});

test('ranking drops duplicates and candidates it cannot replay', () => {
  const ranked = Macros.rank([save(), save(), { k: 'xpath', value: '//button' }, { k: 'text', value: '   ' }]);
  assert.equal(ranked.length, 1, 'the same locator is stored once and an unknown strategy is ignored');
  assert.deepEqual(Macros.rank('nope'), [], 'a missing target is not an error');
});

test('missing counts are normalised rather than trusted', () => {
  const [candidate] = Macros.rank([{ k: 'id', value: 'save' }]);
  assert.equal(candidate.nth, 0);
  assert.equal(candidate.count, 1);
});

test('typing into one field collapses into a single step holding the final value', () => {
  let steps = [];
  for (const text of ['h', 'he', 'hey']) steps = Macros.append(steps, { type: 'fill', target: [save()], text });
  assert.equal(steps.length, 1);
  assert.equal(steps[0].text, 'hey');
});

test('typing into a second field keeps both steps, in order', () => {
  const name = { k: 'label', value: 'Name', count: 1 };
  let steps = Macros.append([], { type: 'fill', target: [name], text: 'Ada' });
  steps = Macros.append(steps, { type: 'click', target: [save()], label: 'Save' });
  steps = Macros.append(steps, { type: 'fill', target: [name], text: 'Grace' });
  assert.equal(steps.length, 3);
  assert.equal(steps[2].text, 'Grace');
});

test('a secret step never stores what was typed', () => {
  const [step] = Macros.prune([{ type: 'secret', target: [{ k: 'role', value: 'textbox', name: 'Password' }], label: 'Password', text: 'hunter2' }]);
  assert.equal(step.type, 'secret');
  assert.equal(step.text, undefined, 'the password is not part of the macro');
  assert.equal(step.target[0].name, 'Password', 'but the field it belongs to is');
});

test('pruning drops steps replay could not perform and keeps the rest', () => {
  const steps = Macros.prune([
    { type: 'click', target: [] },
    { type: 'scroll' },
    { type: 'navigate', url: 'https://example.com/inbox' },
    { type: 'key', key: 'Enter' },
    { type: 'click', target: [{ k: 'id', value: 'send' }], label: 'Send' }
  ]);
  assert.deepEqual(steps.map(step => step.type), ['navigate', 'key', 'click']);
});

test('a macro says what it will do in words a person can read', () => {
  const steps = Macros.prune([
    { type: 'navigate', url: 'https://www.example.com/login' },
    { type: 'fill', target: [{ k: 'label', value: 'Email' }], label: 'Email', text: 'ada@example.com' },
    { type: 'secret', target: [{ k: 'label', value: 'Password' }], label: 'Password' },
    { type: 'click', target: [save()], label: 'Save' }
  ]);
  assert.deepEqual(steps.map(Macros.label), [
    'Open example.com',
    'Type “ada@example.com” into Email',
    'Type your own value into Password',
    'Click Save'
  ]);
});

test('a macro summarizes its size and the site it starts on', () => {
  const macro = { name: 'Weekly report', startUrl: 'https://www.example.com/reports', steps: [{ type: 'key', key: 'Enter' }] };
  assert.equal(Macros.summary(macro), '1 step · example.com');
  assert.equal(Macros.summary({ steps: [] }), '0 steps');
  assert.equal(Macros.nameFor('', 'https://example.com/x'), 'example.com');
  assert.equal(Macros.nameFor('Inbox cleanup', 'https://example.com'), 'Inbox cleanup');
});

test('a failed step hands the rest of the macro to the agent in a message it can act on', () => {
  const macro = {
    name: 'Weekly report', steps: Macros.prune([
      { type: 'click', target: [{ k: 'id', value: 'reports' }], label: 'Reports' },
      { type: 'click', target: [{ k: 'id', value: 'export' }], label: 'Export' },
      { type: 'click', target: [{ k: 'id', value: 'csv' }], label: 'CSV' }
    ])
  };
  const prompt = Macros.recovery(macro, 1, 'That element is not on the page any more.');
  assert.match(prompt, /Continue the macro “Weekly report” from step 2\./);
  assert.match(prompt, /That element is not on the page any more\./);
  assert.match(prompt, /2\. Click Export/);
  assert.match(prompt, /3\. Click CSV/);
  assert.doesNotMatch(prompt, /1\. Click Reports/, 'steps already done are not repeated');
});

test('a task that moves to another tab becomes a step the replay can follow', () => {
  let steps = Macros.append([], { type: 'switch', url: 'https://example.com/inbox' });
  steps = Macros.append(steps, { type: 'click', target: [save()], label: 'Open' });
  steps = Macros.append(steps, { type: 'switch', url: 'https://mail.example.com/thread/1' });
  assert.deepEqual(steps.map(step => step.type), ['switch', 'click', 'switch']);
  assert.deepEqual(steps.map(Macros.label), ['Switch to example.com', 'Click Open', 'Switch to mail.example.com']);
});

test('a switch back to the page it is already on is not stored twice', () => {
  const once = Macros.append([], { type: 'switch', url: 'https://example.com/a' });
  const twice = Macros.append(once, { type: 'switch', url: 'https://example.com/a' });
  assert.equal(twice.length, 1);
  assert.equal(twice[0].url, 'https://example.com/a');
  const other = Macros.append(twice, { type: 'switch', url: 'https://example.com/b' });
  assert.equal(other.length, 2, 'a different page is a real move');
});

test('a switch step survives pruning only when it names a web page', () => {
  const steps = Macros.prune([
    { type: 'switch', url: 'https://example.com/a' },
    { type: 'switch', url: 'https://example.com/a' },
    { type: 'switch', url: 'chrome://settings' },
    { type: 'click', target: [save()], label: 'Save' }
  ]);
  assert.deepEqual(steps.map(step => step.type), ['switch', 'click']);
  assert.equal(steps[0].url, 'https://example.com/a');
});

test('a shortcut is stored the way it will be pressed, and only when it means something', () => {
  assert.equal(Macros.keySpec('ctrl+c'), 'Control+C');
  assert.equal(Macros.keySpec('cmd+shift+z'), 'Meta+Shift+Z');
  assert.equal(Macros.keySpec('Shift+Control+Y'), 'Control+Shift+Y', 'modifier order is normalised');
  assert.equal(Macros.keySpec('Enter'), 'Enter');
  assert.equal(Macros.keySpec('Escape'), 'Escape');
  assert.equal(Macros.keySpec('Tab'), '', 'moving focus is not something a replay can repeat');
  assert.equal(Macros.keySpec('Control+Q'), '', 'only commands a page can see again are kept');
  assert.equal(Macros.keySpec('Shift+C'), '', 'a capital letter with no command modifier is typing');
  assert.equal(Macros.keySpec('Control+Control+C'), '', 'a repeated modifier is malformed');
  assert.equal(Macros.keySpec(''), '');
});

test('a key step keeps Escape and copy, and drops keys a replay cannot repeat', () => {
  const steps = Macros.prune([
    { type: 'key', key: 'Tab' },
    { type: 'key', key: 'ctrl+c' },
    { type: 'key', key: 'Escape' },
    { type: 'click', target: [save()], label: 'Save' }
  ]);
  assert.deepEqual(steps.map(step => step.key ?? step.type), ['Control+C', 'Escape', 'click']);
  assert.deepEqual(steps.slice(0, 2).map(Macros.label), ['Press Ctrl+C', 'Press Escape']);
  assert.equal(Macros.label({ type: 'key', key: 'Meta+Z' }), 'Press Cmd+Z', 'the label uses this platform\'s name');
});

test('a page is recognised by address, ignoring the fragment and a trailing slash', () => {
  assert.equal(Macros.pageKey('https://Example.com/inbox/?q=1#top'), Macros.pageKey('https://example.com/inbox?q=1'));
  assert.equal(Macros.pageLoose('https://example.com/inbox?q=1'), Macros.pageLoose('https://example.com/inbox/?q=2'));
  assert.notEqual(Macros.pageLoose('https://example.com/a'), Macros.pageLoose('https://example.com/b'));
  assert.notEqual(Macros.pageKey('https://example.com/a'), Macros.pageKey('https://other.example/a'));
  assert.equal(Macros.pageKey('not a url'), '');
});


// The page rail is small enough to pin with a test: pinned and runnable only, one letter each, capped.
import { createRequire as railCreateRequire } from 'node:module';
const railApi = railCreateRequire(import.meta.url)('../extension/macros.js');

test('the page rail lists only pinned, runnable macros', () => {
  const list = railApi.rail([
    { id: 'a', name: 'Invoice run', pinned: true, steps: [{ type: 'click' }] },
    { id: 'b', name: 'Not pinned', steps: [{ type: 'click' }] },
    { id: 'c', name: 'Nothing recorded', pinned: true, steps: [] },
    { id: 'd', name: '  weekly report ', pinned: true, steps: [{ type: 'key' }] },
    { id: '', name: 'No id', pinned: true, steps: [{ type: 'key' }] },
    null
  ]);
  assert.deepEqual(list.map(entry => entry.id), ['a', 'd']);
  assert.deepEqual(list.map(entry => entry.letter), ['I', 'W']);
  assert.equal(list[1].name, 'weekly report');
});

test('the page rail stops at eight icons', () => {
  const many = Array.from({ length: 12 }, (_, index) => ({ id: 'm' + index, name: 'Macro ' + index, pinned: true, steps: [{ type: 'key' }] }));
  assert.equal(railApi.rail(many).length, 8);
  assert.deepEqual(railApi.rail('not a list'), []);
});
