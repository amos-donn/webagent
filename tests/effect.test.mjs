import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Effect = require('../extension/effect.js');

test('a fingerprint that changed verifies the action and carries no error code', () => {
  const effect = Effect.of('a|1|2', 'a|1|3');
  assert.deepEqual(effect, { verified: true });
  assert.equal(Effect.code(effect), undefined);
});

test('a fingerprint that did not change is the one case that earns NO_EFFECT', () => {
  const effect = Effect.of('a|1|2', 'a|1|2');
  assert.deepEqual(effect, { verified: false });
  assert.equal(Effect.code(effect), 'NO_EFFECT');
});

test('a page that could not be read is unknown, not a failure', () => {
  // Navigation, a blocked injection or a closed tab all read as an empty fingerprint. Calling that
  // "no effect" is how a click that worked gets re-clicked into a double submit.
  assert.deepEqual(Effect.of('', 'a|1|2'), { verified: null });
  assert.deepEqual(Effect.of('a|1|2', ''), { verified: null });
  assert.deepEqual(Effect.of('', ''), { verified: null });
  assert.equal(Effect.code(Effect.of('', '')), undefined, 'unknown never reports NO_EFFECT');
});

test('an action whose own result is its evidence can say so', () => {
  // Choosing a value in a list is verified by the choice, not by the page hash changing, because a
  // select can redraw without altering the text the fingerprint counts.
  assert.deepEqual(Effect.of('', '', true), { verified: true });
  assert.deepEqual(Effect.of('a', 'b', true), { verified: true }, 'a real change still wins');
});

test('a missing effect object is not an error code', () => {
  assert.equal(Effect.code(undefined), undefined);
  assert.equal(Effect.code({ verified: null }), undefined);
});
