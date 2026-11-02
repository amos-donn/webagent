import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Schedule = require('../extension/schedule.js');

test('an interval is read the way people write it', () => {
  assert.equal(Schedule.parseEvery('60'), 60);
  assert.equal(Schedule.parseEvery('90m'), 90);
  assert.equal(Schedule.parseEvery('2h'), 120);
  assert.equal(Schedule.parseEvery('1 day'), 1440);
  assert.equal(Schedule.parseEvery('30 minutes'), 30);
  assert.equal(Schedule.parseEvery('off'), null);
  assert.equal(Schedule.parseEvery(''), null);
  assert.equal(Schedule.parseEvery('soon'), null, 'words that are not a length are refused');
  assert.equal(Schedule.parseEvery('0'), null, 'a zero interval would fire forever');
  assert.equal(Schedule.parseEvery('100000'), null, 'and a fortnight is the outside edge');
});

test('a task gets the next slot and a run counter', () => {
  const now = 1000000;
  const entry = Schedule.add([], '  check the inbox  ', '30', now);
  assert.equal(entry.prompt, 'check the inbox');
  assert.equal(entry.every, 30);
  assert.equal(entry.nextRun, Schedule.nextAt(now, 30));
  assert.equal(entry.runs, 0);
  assert.match(entry.id, /^[a-z0-9]{6}$/);
});

test('a task without words or without a length is refused', () => {
  assert.throws(() => Schedule.add([], '', '60', 0), /needs something to do/);
  assert.throws(() => Schedule.add([], 'do it', 'sometimes', 0), /Say how often/);
  const full = Array.from({ length: Schedule.LIMIT }, (_, i) => ({ id: String(i), prompt: 'x', every: 60 }));
  assert.throws(() => Schedule.add(full, 'one more', '60', 0), /Remove one first/);
});

test('only tasks whose slot has passed are due', () => {
  const now = 5000000;
  const list = [
    { id: 'a', prompt: 'first', every: 60, nextRun: now - 1 },
    { id: 'b', prompt: 'second', every: 60, nextRun: now + 60000 },
    { id: 'c', every: 60, nextRun: now - 1 },
    { id: 'd', prompt: 'fourth', every: 60 }
  ];
  assert.deepEqual(Schedule.due(list, now).map(entry => entry.id), ['a', 'd'], 'a missing nextRun is due, a missing prompt is not');
  assert.deepEqual(Schedule.due(null, now), []);
});

test('an interval reads as a span a person recognises', () => {
  assert.equal(Schedule.describe({ every: 30, prompt: 'check the inbox' }), '30 min · check the inbox');
  assert.equal(Schedule.describe({ every: 120, prompt: 'x' }), '2 h · x');
  assert.equal(Schedule.describe({ every: 1440, prompt: 'x' }), '1 d · x');
});
