import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Pointer = require('../extension/pointer.js');

const geo = Pointer.geometry();
const close = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 0.01, `${message}: expected ${expected}, got ${actual}`);

test('the arrow has no stem, so nothing sits behind the tip', () => {
  const points = Pointer.vertices();
  assert.equal(points.length, 5, 'a five-vertex arrowhead: tip, two long edges, the inward curve, the wing');
  const tip = Pointer.SHAPE.tip;
  assert.equal(Math.min(...points.map(point => point[0])), tip[0], 'no vertex is left of the tip');
  const behind = points.filter(point => point[1] > 19.6);
  assert.deepEqual(behind, [], 'and none hangs below the lower edge the old tail was attached to');
});

test('the painted tip lands on the click point, not the raw path vertex', () => {
  // Recomputed here rather than read back from the module: the outline is drawn with a 6-unit stroke,
  // so a round join pushes the tip out along the bisector of its two edges by half of it.
  const { viewBox, box, tip, next, wing, strokes } = Pointer.SHAPE;
  const scale = box / viewBox;
  const unit = (from, to) => {
    const dx = to[0] - from[0], dy = to[1] - from[1];
    const length = Math.hypot(dx, dy);
    return [dx / length, dy / length];
  };
  const a = unit(tip, next), b = unit(tip, wing);
  const sum = [a[0] + b[0], a[1] + b[1]];
  const bisector = unit([0, 0], sum);
  const reach = (Math.max(...strokes.map(([, width]) => width)) / 2) * scale;
  close(geo.origin.x, tip[0] * scale - bisector[0] * reach, 'the box is offset so the tip sits on the point');
  close(geo.origin.y, tip[1] * scale - bisector[1] * reach, 'vertically too');
  assert.match(geo.arrow, new RegExp(`left:${-geo.origin.x}px`), 'the CSS uses that offset');
  assert.match(geo.arrow, new RegExp(`transform-origin:${geo.origin.x}px ${geo.origin.y}px`), 'and squashes around it');
});

test('the press animation pivots on the painted tip', () => {
  assert.deepEqual(geo.origin, geo.inset, 'one point, so a click scales in place instead of sliding');
});

test('both passes stroke the same path, widest first', () => {
  assert.deepEqual(geo.strokes.map(([paint]) => paint), ['#fff', '#157a52']);
  const [edge, fill] = geo.strokes.map(([, width]) => width);
  assert.ok(edge > fill, 'the white edge is wider, which is what rounds the fill corners');
  assert.equal(geo.path, Pointer.SHAPE.path);
  assert.doesNotMatch(geo.arrow, /stroke-linejoin/, 'round joins are applied in the renderer, not the CSS');
});

test('the geometry covers what the injected renderer needs', () => {
  for (const key of ['wrap', 'arrow', 'ringCss', 'path', 'strokes', 'size', 'viewBox']) {
    assert.ok(geo[key] !== undefined && geo[key] !== '', `${key} is part of the contract`);
  }
  assert.equal(geo.size, 20);
  assert.equal(geo.viewBox, 24);
  assert.match(geo.ringCss, new RegExp(`width:${Pointer.SHAPE.ring}px`));
});

test('a wider stroke pushes the pointer further out, keeping the tip on the point', () => {
  const thicker = Pointer.geometry({ ...Pointer.SHAPE, strokes: [['#fff', 10], ['#157a52', 3.6]] });
  assert.ok(thicker.origin.x < geo.origin.x && thicker.origin.y < geo.origin.y,
    'a fatter outline pushes the box further out on both axes, which the old hand-tuned numbers could not express');
});
