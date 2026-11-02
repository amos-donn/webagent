import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Audio = require('../extension/audio.js');

test('a slice is a real 16 kHz mono 16-bit WAV file', () => {
  const bytes = Audio.wavBytes(new Float32Array(16000).fill(0.25), 16000);
  const view = new DataView(bytes.buffer);
  const ascii = (at, length) => String.fromCharCode(...bytes.slice(at, at + length));
  assert.equal(ascii(0, 4), 'RIFF');
  assert.equal(ascii(8, 4), 'WAVE');
  assert.equal(ascii(12, 4), 'fmt ');
  assert.equal(ascii(36, 4), 'data');
  assert.equal(bytes.length, 44 + 16000 * 2, 'a 44-byte header plus two bytes a sample');
  assert.equal(view.getUint32(4, true), bytes.length - 8, 'the RIFF size counts everything after it');
  assert.equal(view.getUint16(22, true), 1, 'one channel');
  assert.equal(view.getUint32(24, true), 16000, 'the sample rate Gemini is told to expect');
  assert.equal(view.getUint16(34, true), 16, '16-bit samples');
  assert.equal(view.getUint32(40, true), 16000 * 2, 'the data chunk length');
  assert.equal(view.getInt16(44, true), 8192, '0.25 of full scale is a quarter of 32767');
});

test('float samples are clamped instead of wrapping into noise', () => {
  const pcm = Audio.toInt16(new Float32Array([0, 1.4, -1.4, 0.5]));
  assert.equal(pcm[0], 0);
  assert.equal(pcm[1], 32767);
  assert.equal(pcm[2], -32768);
  assert.equal(pcm[3], 16384);
  assert.equal(Audio.toInt16(new Float32Array([NaN]))[0], 0, 'a broken sample is silence, not a crash');
});

test('audio is encoded the way the Worker and Gemini expect', () => {
  const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 255]);
  assert.equal(Audio.base64(bytes), Buffer.from(bytes).toString('base64'));
  assert.equal(Audio.base64(Uint8Array.from([104, 105])), Buffer.from('hi').toString('base64'), 'padding is included');
  assert.equal(Audio.base64(new Uint8Array(0)), '');
});

test('slices are joined into readable prose without empty paragraphs', () => {
  assert.equal(Audio.joinParts([' one two ', '', 'three']), 'one two\n\nthree');
  assert.equal(Audio.joinParts(['a', 'b']), 'a\n\nb');
  assert.equal(Audio.joinParts(null), '');
  assert.equal(Audio.joinParts(['  ', '\n']), '', 'a silent slice leaves no gap behind');
});

test('the line for a video time is the one covering it, or the last one before it', () => {
  const lines = [{ from: 0, to: 10 }, { from: 10, to: 20 }, { from: 32, to: 42 }];
  assert.equal(Audio.activeIndex(lines, 0), 0);
  assert.equal(Audio.activeIndex(lines, 9.9), 0);
  assert.equal(Audio.activeIndex(lines, 10), 1);
  assert.equal(Audio.activeIndex(lines, 25), 1, 'a gap keeps the previous line lit');
  assert.equal(Audio.activeIndex(lines, 40), 2);
  assert.equal(Audio.activeIndex(lines, 90), 2, 'past the end is the last line, not nothing');
  assert.equal(Audio.activeIndex(lines, -5), -1, 'before the first line nothing is lit');
  assert.equal(Audio.activeIndex([], 5), -1);
  assert.equal(Audio.activeIndex(null, 5), -1);
  assert.deepEqual(Audio.RATES, [0.5, 0.75, 1, 1.25, 1.5, 2]);
});

test('a timestamp is minutes and seconds, not a float', () => {
  assert.equal(Audio.stamp(0), '0:00');
  assert.equal(Audio.stamp(65), '1:05');
  assert.equal(Audio.stamp(3600), '60:00');
  assert.equal(Audio.stamp(null), '0:00');
  assert.equal(Audio.stamp(Infinity), '0:00', 'a live stream has no duration to count up to');
});
