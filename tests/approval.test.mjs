import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Approval = require('../extension/approval.js');

test('an unknown posture falls back to running rather than to asking forever', () => {
  assert.equal(Approval.read('ask'), 'ask');
  assert.equal(Approval.read(undefined), 'auto');
  assert.equal(Approval.read('paranoid'), 'auto', 'a stored value from a future version must not wedge the panel');
});

test('each posture maps to the mode the round loop already checks', () => {
  assert.equal(Approval.modeFor('auto'), 'autopilot');
  assert.equal(Approval.modeFor('risky'), 'auto');
  assert.equal(Approval.modeFor('ask'), 'manual');
});

test('labels are readable sentences and cycling covers all three', () => {
  for (const value of Approval.ORDER) {
    assert.ok(Approval.labelFor(value).length > 10);
    assert.ok(Approval.whyFor(value).length > 10);
  }
  let value = 'auto';
  const seen = new Set();
  for (let step = 0; step < 3; step += 1) { seen.add(value); value = Approval.next(value); }
  assert.deepEqual([...seen].sort(), [...Approval.ORDER].sort());
  assert.equal(value, 'auto', 'the cycle closes');
});
