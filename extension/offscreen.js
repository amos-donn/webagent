// Tab-audio capture for /transcribe. The page path reads the audio track of the media element itself,
// which is the cleanest source but not one every player offers: audio inside an iframe, a player built
// on Web Audio, and plenty of streaming <video> elements expose no track to captureStream at all.
// Chrome can share a whole tab's audio, so that is the second attempt. It runs here because a service
// worker has no AudioContext, and it slices the PCM exactly the way the page does, so the panel cannot
// tell the two apart.
let run = null;

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== 'offscreen') return;
  if (message.type === 'tab-capture-start') {
    start(message).then(respond, error => respond({ ok: false, error: error?.message || 'Tab audio capture failed.' }));
    return true;
  }
  if (message.type === 'tab-capture-stop') { stop(); respond({ ok: true }); return true; }
});

// A tab that has finished playing looks exactly like a paused one, and neither can be told from an ad
// break by the audio alone. A full minute of digital silence ends the capture instead of holding the
// panel open forever; shorter gaps are left alone, because a pause in a talk is not the end of it.
const SILENT_LIMIT = 60;
const SILENT_PEAK = 0.002;

function stop() {
  const current = run;
  run = null;
  if (current) current.finish('stopped');
}

async function start(message) {
  const audio = globalThis.MezzeAudio;
  if (!audio) return { ok: false, error: 'The audio helpers did not load.' };
  stop();
  const session = String(message.session || '');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: String(message.streamId || '') } },
      video: false
    });
  } catch (error) {
    return { ok: false, error: 'Chrome would not share this tab\'s audio: ' + (error?.message || 'no reason given') + '.' };
  }
  if (!stream.getAudioTracks?.().length) {
    stream.getTracks().forEach(track => track.stop());
    return { ok: false, error: 'That tab has no audio to capture.' };
  }
  const context = new AudioContext({ sampleRate: audio.RATE });
  if (context.state === 'suspended') await context.resume().catch(() => {});
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const mute = context.createGain();
  mute.gain.value = 0;
  const chunk = new Float32Array(audio.RATE * (audio.SLICE + 3));
  const send = payload => { try { chrome.runtime.sendMessage({ type: 'transcribe-event', session, ...payload }); } catch { /* panel closed */ } };
  const offset = Math.max(0, Number(message.startTime) || 0);
  let filled = 0, part = 0, samples = 0, peak = 0, silentFor = 0, stopped = false, lineStart = offset;

  const flush = cut => {
    if (stopped || !filled) return;
    const index = Math.max(1, Math.min(Math.round(cut), filled));
    const seconds = index / audio.RATE;
    const from = lineStart;
    const to = from + seconds;
    // Silence is not sent: a paused video, a muted tab and an ad break would otherwise spend a request
    // each and come back empty, and the panel would show blank lines for them.
    if (peak >= SILENT_PEAK) {
      part += 1;
      send({
        event: 'chunk', part, audio: audio.base64(audio.wavBytes(chunk.subarray(0, index), audio.RATE)),
        mimeType: 'audio/wav', seconds: Math.round(from), from: Math.round(from * 100) / 100, to: Math.round(to * 100) / 100
      });
      silentFor = 0;
    } else {
      silentFor += seconds;
    }
    // Samples past the cut start the next slice, so a cut can sit on a pause rather than at a boundary.
    chunk.copyWithin(0, index, filled);
    filled -= index;
    lineStart = to;
    peak = 0;
    if (silentFor >= SILENT_LIMIT) queueMicrotask(() => finish('silence'));
  };

  const finish = reason => {
    if (stopped) return;
    flush(filled);
    stopped = true;
    try { processor.disconnect(); source.disconnect(); mute.disconnect(); } catch { /* already torn down */ }
    stream.getTracks().forEach(track => track.stop());
    context.close().catch(() => {});
    send({ event: 'done', reason, seconds: Math.round(samples / audio.RATE), parts: part });
    if (run?.session === session) run = null;
  };

  processor.onaudioprocess = event => {
    if (stopped) return;
    const input = event.inputBuffer.getChannelData(0);
    for (let i = 0; i < input.length; i++) {
      const value = input[i] || 0;
      chunk[filled++] = value;
      const abs = value < 0 ? -value : value;
      if (abs > peak) peak = abs;
    }
    samples += input.length;
    if (filled >= audio.RATE * audio.SLICE) {
      const cut = audio.quietCut ? audio.quietCut(chunk.subarray(0, filled), audio.RATE, 0.7, 1) : -1;
      flush(cut > 0 ? cut : Math.min(filled, audio.RATE * (audio.SLICE + 2)));
      if (stopped) return;
    }
    if (filled >= chunk.length) flush(chunk.length);
  };

  source.connect(processor);
  processor.connect(mute);
  mute.connect(context.destination);
  run = { session, finish };
  send({ event: 'progress', seconds: 0 });
  return { ok: true, via: 'tab' };
}
