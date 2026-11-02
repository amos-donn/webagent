// Audio helpers for /transcribe. The page captures float PCM from the media element it is playing;
// Gemini wants a container every decoder accepts, so each slice becomes a 16 kHz mono 16-bit WAV.
// Nothing here touches the DOM, so the numbers can be checked in Node. This file is also injected
// into the tab before the capture runs, which is why it registers a global rather than a module.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MezzeAudio = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Speech recognition needs nothing above 8 kHz, and mono at 16 kHz is 32 KB a second: a ten-second
  // slice is 320 KB of PCM, about 430 KB once base64'd, which stays well inside the Worker's body
  // limit and Gemini's inline-data limit.
  const RATE = 16000;
  const SLICE = 10;

  function toInt16(samples) {
    const out = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const value = Math.max(-1, Math.min(1, Number(samples[i]) || 0));
      out[i] = value < 0 ? Math.round(value * 0x8000) : Math.round(value * 0x7fff);
    }
    return out;
  }

  function wavBytes(input, rate = RATE) {
    const pcm = input instanceof Int16Array ? input : toInt16(input);
    const bytes = new Uint8Array(44 + pcm.length * 2);
    const view = new DataView(bytes.buffer);
    const ascii = (at, text) => { for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)); };
    ascii(0, 'RIFF');
    view.setUint32(4, 36 + pcm.length * 2, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    ascii(36, 'data');
    view.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i], true);
    return bytes;
  }

  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function base64(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
      out += B64[a >> 2] + B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
      out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
      out += c === undefined ? '=' : B64[c & 63];
    }
    return out;
  }

  // Each slice is transcribed on its own, so the seam between two of them is the only place a word
  // can be cut in half. Joining on a blank line keeps the transcript readable instead of one wall.
  function joinParts(texts) {
    return (Array.isArray(texts) ? texts : [])
      .map(text => String(text ?? '').trim())
      .filter(Boolean)
      .join('\n\n')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
  }

  // A live stream reports an infinite duration, and "Infinity:NaN" is a worse label than "0:00".
  // The line being spoken at a given video time. A gap between lines — a pause, a seek, a slice the
  // model returned nothing for — keeps the previous line lit rather than blanking the panel, and a time
  // before the first line lights nothing.
  function activeIndex(lines, time) {
    if (!Array.isArray(lines) || !lines.length) return -1;
    const at = Number(time) || 0;
    let found = -1;
    for (let i = 0; i < lines.length; i++) {
      const from = Number(lines[i]?.from) || 0;
      const to = Number(lines[i]?.to);
      if (Number.isFinite(to) && at >= from && at < to) return i;
      if (at >= from) found = i;
    }
    return found;
  }

  // 1x is not the only speed a person reads at, so the island offers the usual set.
  const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

  const stamp = seconds => {
    const value = Number(seconds);
    const total = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  };

  return { RATE, SLICE, RATES, toInt16, wavBytes, base64, joinParts, stamp, activeIndex };
});
