// Script mode: a floating transcript island inside the page. It reads the media element /transcribe is
// capturing, lights the line being spoken at the current video time, and carries the playback controls
// a person needs while reading. Nothing here talks to the Worker; the panel pushes lines in as they
// are transcribed, which is what makes the sync live rather than a file that appears at the end.
//
// It is injected as a file rather than written into background.js because it is UI, it keeps its own
// state between calls, and it lives inside a shadow root so no page stylesheet can reach it.
(function () {
  if (window.MezzeScript) return;
  const CSS = `
  :host { all: initial; }
  #island { position: fixed; top: 24px; right: 24px; width: 360px; height: 320px; min-width: 260px; min-height: 170px;
    display: flex; flex-direction: column; overflow: hidden; resize: both; z-index: 2147483646;
    border: 1px solid rgba(120,120,130,.35); border-radius: 14px; background: #fafafa; color: #18181b;
    box-shadow: 0 18px 50px rgba(0,0,0,.28); font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  @media (prefers-color-scheme: dark) {
    #island { background: #18181b; color: #f4f4f5; border-color: rgba(160,160,170,.3); box-shadow: 0 18px 50px rgba(0,0,0,.6); }
  }
  header { display: flex; align-items: center; gap: 6px; padding: 8px 10px; cursor: grab; flex: none;
    border-bottom: 1px solid rgba(120,120,130,.25); background: rgba(120,120,130,.08); user-select: none; }
  header:active { cursor: grabbing; }
  .grip { width: 10px; height: 14px; border-left: 2px dotted currentColor; border-right: 2px dotted currentColor; opacity: .4; flex: none; }
  .title { flex: 1; font-weight: 600; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .time { font-variant-numeric: tabular-nums; opacity: .6; font-size: 11px; flex: none; }
  button { all: unset; display: inline-flex; align-items: center; justify-content: center; min-width: 24px; height: 24px;
    padding: 0 4px; border-radius: 7px; cursor: pointer; color: inherit; font-size: 11px; box-sizing: border-box; }
  button:hover { background: rgba(120,120,130,.18); }
  button:focus-visible { outline: 2px solid #10b981; outline-offset: 1px; }
  .lines { flex: 1; overflow-y: auto; padding: 8px 6px 16px; }
  .line { display: block; width: 100%; box-sizing: border-box; text-align: left; padding: 5px 8px; border-radius: 8px;
    color: inherit; opacity: .55; font-size: 12.5px; line-height: 1.45; }
  .line:hover { opacity: .95; background: rgba(120,120,130,.12); }
  .line.on { opacity: 1; background: rgba(16,185,129,.16); }
  .line.on .at { color: #10b981; }
  .at { font-size: 10px; opacity: .7; margin-right: 6px; font-variant-numeric: tabular-nums; }
  footer { display: flex; align-items: center; gap: 6px; padding: 6px 8px; flex: none; border-top: 1px solid rgba(120,120,130,.25); }
  select { all: unset; font: 11px system-ui, sans-serif; color: inherit; padding: 2px 6px; border-radius: 6px;
    border: 1px solid rgba(120,120,130,.35); cursor: pointer; }
  .hint { flex: 1; text-align: right; font-size: 10px; opacity: .45; }
  .empty { padding: 16px 12px; opacity: .6; font-size: 12px; }
  #island:fullscreen { inset: 0; width: auto; height: auto; min-width: 0; min-height: 0; border-radius: 0; resize: none; }
  #island:fullscreen .line { font-size: 15px; padding: 8px 12px; }
  #island[pip] { position: static; inset: auto; width: 100%; height: 100%; min-width: 0; min-height: 0; border: 0; border-radius: 0; box-shadow: none; resize: none; }
  #island[pip] .grip { display: none; }
  #island[pip] header { cursor: default; }
  `;

  const audio = () => window.MezzeAudio || null;
  const stamp = seconds => (audio()?.stamp ? audio().stamp(seconds) : `${Math.floor((Number(seconds) || 0) / 60)}:${String(Math.round((Number(seconds) || 0) % 60)).padStart(2, '0')}`);
  const state = { host: null, root: null, island: null, body: null, media: null, lines: [], title: '', idx: -1, raf: 0, scrolled: 0, rate: 1, pip: null };

  // The same rule the capture uses: the page's largest media element with a real source.
  function mediaElement() {
    const all = [...document.querySelectorAll('video,audio')].filter(el => el.currentSrc || el.duration > 0.5);
    all.sort((a, b) => (b.duration || 0) - (a.duration || 0));
    return all[0] || null;
  }

  // Where the person put it, for as long as this page is open: a transcript you have to re-drag on every
  // transcription is worse than one that stays put.
  const PLACE_KEY = 'mezze:island';
  function savePlace() {
    if (!state.island) return;
    try {
      const rect = state.island.getBoundingClientRect();
      sessionStorage.setItem(PLACE_KEY, JSON.stringify({ left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }));
    } catch { /* storage full or blocked */ }
  }
  function restorePlace() {
    if (!state.island) return;
    try {
      const saved = JSON.parse(sessionStorage.getItem(PLACE_KEY) || 'null');
      if (!saved) return;
      if (saved.width > 200) state.island.style.width = saved.width + 'px';
      if (saved.height > 140) state.island.style.height = saved.height + 'px';
      if (Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
        state.island.style.right = 'auto';
        state.island.style.left = Math.max(0, Math.min(saved.left, window.innerWidth - 90)) + 'px';
        state.island.style.top = Math.max(0, Math.min(saved.top, window.innerHeight - 60)) + 'px';
      }
    } catch { /* ignore a broken record */ }
  }

  function build() {
    if (state.island?.isConnected) return;
    const host = document.createElement('div');
    host.setAttribute('data-mezze-script', '');
    const root = host.attachShadow({ mode: 'open' });
    // A constructed stylesheet is not an inline <style>, so a strict page CSP cannot refuse it.
    try { const sheet = new CSSStyleSheet(); sheet.replaceSync(CSS); root.adoptedStyleSheets = [sheet]; }
    catch { const style = document.createElement('style'); style.textContent = CSS; root.append(style); }

    const island = document.createElement('section');
    island.id = 'island';
    island.tabIndex = 0;
    island.setAttribute('role', 'region');
    island.setAttribute('aria-label', 'Transcript');
    island.innerHTML = `<header>
      <span class="grip" aria-hidden="true"></span>
      <span class="title">Transcript</span>
      <span class="time">0:00</span>
      <button class="play" type="button" aria-label="Play or pause">❚❚</button>
      <button class="full" type="button" aria-label="Fullscreen" title="Fullscreen">⛶</button>
      <button class="pip" type="button" aria-label="Picture-in-picture" title="Picture-in-picture">⧉</button>
      <button class="close" type="button" aria-label="Close the transcript" title="Close">✕</button>
    </header>
    <div class="lines" role="list"></div>
    <footer>
      <button class="back" type="button" aria-label="Back five seconds">−5s</button>
      <button class="fwd" type="button" aria-label="Forward five seconds">+5s</button>
      <select class="rate" aria-label="Playback speed"></select>
      <span class="hint">click a line to jump</span>
    </footer>`;
    root.append(island);
    document.documentElement.append(host);
    restorePlace();
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => savePlace()).observe(island);

    state.host = host;
    state.root = root;
    state.island = island;
    state.body = island.querySelector('.lines');
    state.body.addEventListener('scroll', () => { state.scrolled = Date.now(); }, { passive: true });

    const select = island.querySelector('.rate');
    for (const rate of audio()?.RATES || [0.5, 0.75, 1, 1.25, 1.5, 2]) {
      const option = document.createElement('option');
      option.value = String(rate);
      option.textContent = `${rate}×`;
      select.append(option);
    }
    select.value = String(state.rate);
    select.addEventListener('change', () => { state.rate = Number(select.value) || 1; if (bind()) state.media.playbackRate = state.rate; });

    island.querySelector('.play').addEventListener('click', () => {
      if (!bind()) return;
      if (state.media.paused) state.media.play().catch(() => {});
      else state.media.pause();
      tick();
    });
    island.querySelector('.full').addEventListener('click', () => {
      if (island === document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      else island.requestFullscreen?.().catch(() => {});
    });
    island.querySelector('.close').addEventListener('click', () => {
      destroy();
      try { chrome.runtime.sendMessage({ type: 'player-closed' }); } catch { /* panel closed */ }
    });
    const pipButton = island.querySelector('.pip');
    if (!('documentPictureInPicture' in window)) pipButton.hidden = true;
    else pipButton.addEventListener('click', () => { togglePip().catch(() => {}); });
    island.querySelector('.back').addEventListener('click', () => seekBy(-5));
    island.querySelector('.fwd').addEventListener('click', () => seekBy(5));
    state.body.addEventListener('click', event => {
      const button = event.target.closest?.('.line');
      if (!button) return;
      const line = state.lines[Number(button.dataset.i)];
      if (!line || !bind()) return;
      state.media.currentTime = Math.max(0, line.from || 0);
      tick();
    });

    // Dragging: the island follows the pointer until it is let go, and stays where it was dropped.
    island.querySelector('header').addEventListener('pointerdown', event => {
      if (event.target.closest('button')) return;
      const rect = island.getBoundingClientRect();
      const offset = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      island.style.right = 'auto';
      island.style.left = `${rect.left}px`;
      island.style.top = `${rect.top}px`;
      const move = moved => {
        const left = Math.min(Math.max(0, moved.clientX - offset.x), window.innerWidth - 80);
        const top = Math.min(Math.max(0, moved.clientY - offset.y), window.innerHeight - 48);
        island.style.left = `${left}px`;
        island.style.top = `${top}px`;
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        savePlace();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      event.preventDefault();
    });

    island.addEventListener('keydown', event => {
      if (event.key === 'Escape' && island !== document.fullscreenElement && !state.pip) { destroy(); return; }
      if (event.target?.tagName === 'SELECT') return;
      if (event.key === ' ') { event.preventDefault(); if (bind()) { if (state.media.paused) state.media.play().catch(() => {}); else state.media.pause(); tick(); } }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); seekBy(-5); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); seekBy(5); }
    });
  }

  function bind() {
    const media = mediaElement();
    if (!media) return null;
    if (state.media !== media) {
      unbind();
      state.media = media;
      media.addEventListener('timeupdate', tick);
      media.addEventListener('play', kick);
      media.addEventListener('pause', tick);
      media.addEventListener('ratechange', tick);
      media.playbackRate = state.rate;
    }
    return media;
  }
  function unbind() {
    const media = state.media;
    if (!media) return;
    media.removeEventListener('timeupdate', tick);
    media.removeEventListener('play', kick);
    media.removeEventListener('pause', tick);
    media.removeEventListener('ratechange', tick);
    state.media = null;
  }
  function seekBy(seconds) {
    if (!bind()) return;
    const duration = Number(state.media.duration);
    const target = state.media.currentTime + seconds;
    state.media.currentTime = Number.isFinite(duration) ? Math.min(Math.max(0, target), duration) : Math.max(0, target);
    tick();
  }

  function lineNode(line, index) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'line';
    node.dataset.i = String(index);
    node.setAttribute('role', 'listitem');
    node.title = `Jump to ${stamp(line.from)}`;
    const at = document.createElement('span');
    at.className = 'at';
    at.textContent = stamp(line.from);
    node.append(at, document.createTextNode(line.text));
    return node;
  }

  function render() {
    if (!state.body) return;
    state.body.textContent = '';
    state.idx = -1;
    if (!state.lines.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Waiting for the transcript. Start /transcribe and the lines appear here as they are transcribed, in sync with the video.';
      state.body.append(empty);
      return;
    }
    state.lines.forEach((line, index) => state.body.append(lineNode(line, index)));
    status();
  }

  function status() {
    const hint = state.island?.querySelector('.hint');
    if (!hint) return;
    hint.textContent = state.lines.length ? `${state.lines.length} line${state.lines.length === 1 ? '' : 's'}` : 'click a line to jump';
  }

  function highlight(index) {
    if (index === state.idx) return;
    state.idx = index;
    const nodes = state.body?.querySelectorAll('.line') || [];
    nodes.forEach((node, at) => node.classList.toggle('on', at === index));
    const active = nodes[index];
    if (!active) return;
    // Follow along only when the person has not scrolled the list themselves in the last few seconds.
    if (Date.now() - state.scrolled < 2500) return;
    state.body.scrollTop = Math.max(0, active.offsetTop - state.body.clientHeight / 2 + active.offsetHeight / 2);
  }

  function tick() {
    state.raf = 0;
    if (!state.island || !state.media) return;
    const media = state.media;
    const time = Number(media.currentTime) || 0;
    const label = state.island.querySelector('.time');
    label.textContent = `${stamp(time)}${Number.isFinite(media.duration) && media.duration ? ` / ${stamp(media.duration)}` : ''}`;
    state.island.querySelector('.play').textContent = media.paused ? '▶' : '❚❚';
    state.island.querySelector('.rate').value = String(media.playbackRate || state.rate);
    const index = audio()?.activeIndex ? audio().activeIndex(state.lines, time) : -1;
    highlight(index);
    if (!media.paused) kick();
  }
  function kick() { if (!state.raf) state.raf = requestAnimationFrame(tick); }

  // A real Picture-in-Picture window floats above other applications, not just over this page. Chrome
  // hands a document one such window and only from a user gesture, which is why this is a button in the
  // island rather than something the panel can trigger.
  async function togglePip() {
    if (!('documentPictureInPicture' in window) || !state.island) return false;
    if (state.pip) { state.pip.close(); return true; }
    const pip = await window.documentPictureInPicture.requestWindow({ width: 420, height: 380 });
    state.pip = pip;
    try { const sheet = new CSSStyleSheet(); sheet.replaceSync(CSS); pip.document.adoptedStyleSheets = [sheet]; }
    catch { const style = pip.document.createElement('style'); style.textContent = CSS; pip.document.head.append(style); }
    const base = pip.document.createElement('style');
    base.textContent = 'html,body{margin:0;height:100%;background:transparent}';
    pip.document.head.append(base);
    pip.document.title = state.title || 'Transcript';
    pip.addEventListener('pagehide', restoreFromPip);
    state.island.setAttribute('pip', '');
    state.host.style.height = '100%';
    pip.document.body.append(state.host);
    return true;
  }

  // The window is closed by the person, by the browser or by destroy(), and in every case the same DOM
  // goes back to the page: the island keeps its lines, its highlight and its media bindings.
  function restoreFromPip() {
    const pip = state.pip;
    state.pip = null;
    state.island?.removeAttribute('pip');
    if (state.host) { state.host.style.height = ''; document.documentElement.append(state.host); }
    try { pip?.close(); } catch { /* already gone */ }
  }

  function open(input = {}) {
    const incoming = Array.isArray(input.lines) ? input.lines : [];
    state.lines = incoming
      .filter(item => item && typeof item.text === 'string' && item.text.trim())
      .map(item => ({ from: Number(item.from) || 0, to: Number(item.to), text: item.text.trim() }));
    state.title = String(input.title || state.title || 'Transcript');
    build();
    state.island.querySelector('.title').textContent = state.title;
    state.island.querySelector('.title').title = state.title;
    render();
    bind();
    tick();
    return true;
  }

  // A line arrives while the video plays: the island exists already, so only the new node is added and
  // the highlight moves as soon as the media reaches it.
  function line(input = {}) {
    if (!input || typeof input.text !== 'string' || !input.text.trim()) return false;
    state.lines.push({ from: Number(input.from) || 0, to: Number(input.to), text: input.text.trim() });
    if (!state.island?.isConnected) open({ title: state.title, lines: state.lines });
    else {
      if (state.body.querySelector('.empty')) state.body.textContent = '';
      state.body.append(lineNode(state.lines[state.lines.length - 1], state.lines.length - 1));
      status();
      tick();
    }
    return true;
  }

  function destroy() {
    if (state.pip) { try { state.pip.removeEventListener?.('pagehide', restoreFromPip); state.pip.close(); } catch { /* already gone */ } state.pip = null; }
    unbind();
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
    state.host?.remove();
    state.host = null;
    state.root = null;
    state.island = null;
    state.body = null;
    state.idx = -1;
  }

  window.MezzeScript = { open, line, close: destroy, pip: togglePip, lines: () => state.lines.slice(), state };
})();
