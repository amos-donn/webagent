// The landing page. It lives in the Worker so the API host is something you can look at, and it is
// served before the D1 check: the first request anyone makes should not depend on a binding.
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mezze — an agent in your sidebar</title>
<meta name="description" content="Mezze is a Chrome side-panel agent that plans, clicks, types and reports inside the browser you already use. No account: it runs on your own Cloudflare Worker with your own Gemini key.">
<meta name="theme-color" content="#ffffff">
<meta name="color-scheme" content="light">
<style>
  :root {
    --ink: #0a0a0b;
    --muted: #57575d;
    --faint: #8b8b92;
    --line: rgba(10, 10, 11, .10);
    --accent: #0d9f6e;
    --mono: "Courier New", Courier, "Nimbus Mono PS", "Liberation Mono", monospace;
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    background: #fff;
    color: var(--ink);
    font: 15.5px/1.68 var(--mono);
    letter-spacing: -.005em;
    -webkit-font-smoothing: antialiased;
  }
  body::before {
    content: "";
    position: fixed;
    inset: 0 0 auto;
    height: 380px;
    background:
      radial-gradient(620px 240px at 26% -8%, rgba(13, 159, 110, .10), transparent 72%),
      radial-gradient(420px 200px at 88% 4%, rgba(10, 10, 11, .05), transparent 70%);
    pointer-events: none;
    z-index: 0;
  }
  a { color: inherit; text-decoration: none; }
  a.text { border-bottom: 1px solid var(--line); }
  a.text:hover { border-bottom-color: var(--accent); }
  ::selection { background: rgba(13, 159, 110, .16); }

  .bar {
    position: fixed;
    top: 14px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 30px;
    max-width: calc(100% - 28px);
    padding: 9px 18px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: rgba(255, 255, 255, .58);
    -webkit-backdrop-filter: blur(16px) saturate(170%);
    backdrop-filter: blur(16px) saturate(170%);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, .9), 0 14px 40px -28px rgba(9, 9, 11, .55);
  }
  .brand { display: flex; align-items: center; gap: 8px; font-size: 14px; white-space: nowrap; }
  .brand i { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px rgba(13, 159, 110, .14); }
  .nav { display: flex; gap: 20px; font-size: 13px; color: var(--faint); }
  .nav a { white-space: nowrap; transition: color .18s ease; }
  .nav a:hover, .nav a.on { color: var(--ink); }

  main { position: relative; z-index: 1; }
  .wrap { width: min(100% - 48px, 940px); margin: 0 auto; }
  section { scroll-margin-top: 104px; }

  .hero { padding: 168px 0 96px; }
  .kicker { margin: 0 0 26px; font-size: 11.5px; letter-spacing: .16em; text-transform: uppercase; color: var(--faint); }
  h1 { margin: 0; font-size: clamp(2.1rem, 6.2vw, 3.7rem); line-height: 1.1; letter-spacing: -.035em; font-weight: 400; }
  h1 span { display: block; }
  .lede { max-width: 58ch; margin: 30px 0 0; font-size: 17px; color: var(--muted); }
  .meta { margin: 26px 0 0; font-size: 13px; color: var(--faint); }

  .label { display: flex; align-items: center; gap: 12px; margin: 0 0 26px; font-size: 11.5px; letter-spacing: .16em; text-transform: uppercase; color: var(--faint); }
  .label::after { content: ""; flex: 1; height: 1px; background: var(--line); }
  .band { padding: 74px 0; border-top: 1px solid var(--line); }
  h2 { margin: 0 0 18px; font-size: clamp(1.25rem, 2.6vw, 1.6rem); font-weight: 400; letter-spacing: -.02em; line-height: 1.3; }
  p { margin: 0 0 16px; }
  .muted { color: var(--muted); }

  .carousel { margin-top: 30px; padding: 30px 0 0; border-top: 1px solid var(--line); }
  .slides { display: grid; }
  .slide {
    grid-area: 1 / 1;
    opacity: 0;
    transform: translateY(7px);
    transition: opacity .7s ease, transform .7s ease;
    pointer-events: none;
    padding-bottom: 4px;
  }
  .slide.on { opacity: 1; transform: none; pointer-events: auto; }
  .slide .n { display: block; font-size: 11.5px; letter-spacing: .16em; color: var(--accent); margin-bottom: 10px; }
  .slide h3 { margin: 0 0 8px; font-size: 20px; font-weight: 400; letter-spacing: -.02em; }
  .slide p { max-width: 60ch; color: var(--muted); margin: 0; }
  .carousel.still .slides { gap: 22px; }
  .carousel.still .slide { grid-area: auto; opacity: 1; transform: none; pointer-events: auto; }
  .ticks { display: flex; gap: 7px; padding: 30px 0 0; }
  .ticks i { width: 26px; height: 2px; background: rgba(10, 10, 11, .12); transition: background .4s ease; }
  .ticks i.on { background: var(--accent); }

  dl { display: grid; grid-template-columns: 1fr 1fr; gap: 0 44px; margin: 52px 0 0; }
  .row { display: grid; grid-template-columns: 96px 1fr; gap: 14px; padding: 13px 0; border-top: 1px solid var(--line); }
  dt { font-size: 13px; }
  dd { margin: 0; font-size: 13.5px; color: var(--muted); }

  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 0 44px; margin-top: 8px; }
  .cols h3 { margin: 0 0 10px; font-size: 13px; font-weight: 400; letter-spacing: .12em; text-transform: uppercase; color: var(--faint); }
  ul { margin: 0; padding: 0; list-style: none; }
  li { padding: 11px 0; border-top: 1px solid var(--line); font-size: 13.5px; color: var(--muted); display: flex; gap: 10px; }
  li::before { content: "·"; color: var(--faint); }
  .no li::before { content: "×"; color: #b4b4ba; }

  ol { margin: 6px 0 0; padding: 0; list-style: none; counter-reset: step; }
  ol li { counter-increment: step; padding: 14px 0; border-top: 1px solid var(--line); align-items: baseline; }
  ol li::before { content: counter(step, decimal-leading-zero); color: var(--faint); font-size: 11.5px; letter-spacing: .12em; min-width: 26px; }
  ol li b { font-weight: 400; color: var(--ink); }

  footer { padding: 44px 0 64px; border-top: 1px solid var(--line); font-size: 12.5px; color: var(--faint); display: flex; flex-wrap: wrap; gap: 8px 22px; justify-content: space-between; }

  @media (max-width: 720px) {
    .bar { gap: 18px; padding: 8px 14px; }
    .nav { gap: 12px; font-size: 12px; }
    .hero { padding: 132px 0 66px; }
    dl, .cols { grid-template-columns: 1fr; gap: 0; }
    .band { padding: 58px 0; }
    footer { flex-direction: column; }
  }
  @media (prefers-reduced-motion: reduce) {
    html { scroll-behavior: auto; }
    .slide { transition: none; }
    .nav a, .ticks i { transition: none; }
  }
</style>
</head>
<body>

<header class="bar">
  <a class="brand" href="#top"><i></i>Mezze</a>
  <nav class="nav" aria-label="Sections">
    <a href="#features">Features</a>
    <a href="#about">About</a>
    <a href="#compatibility">Compatibility</a>
    <a href="#install">Install</a>
  </nav>
</header>

<main id="top">

  <section class="hero">
    <div class="wrap">
      <p class="kicker">Chrome side panel · Manifest V3 · 1.8.0</p>
      <h1>
        <span>An agent that works</span>
        <span>in the browser you</span>
        <span>are already in.</span>
      </h1>
      <p class="lede">Mezze sits in the side panel, reads the page, writes a plan, and then clicks, types and scrolls its way through the work — in the tab you starred, on the sites you are already signed into.</p>
      <p class="meta">No account. No subscription. Your own Cloudflare Worker and your own Gemini key.</p>
    </div>
  </section>

  <section class="band" id="features">
    <div class="wrap">
      <p class="label">Features</p>
      <h2>What it does once the page is open.</h2>

      <div class="carousel" id="carousel" role="group" aria-label="Feature highlights">
        <div class="slides">
          <article class="slide">
            <span class="n">01</span>
            <h3>A plan before the first click</h3>
            <p>It drafts a three to six step checklist and shows it in the panel. An item is ticked only when a verified action backs it up, and a tick you disagree with can be clicked to undo it.</p>
          </article>
          <article class="slide">
            <span class="n">02</span>
            <h3>Approval is a setting, not a prompt</h3>
            <p>Run without asking, stop only before the irreversible, or stop before every round. The choice survives a reload, and <code>/approval</code> changes it from the message box.</p>
          </article>
          <article class="slide">
            <span class="n">03</span>
            <h3>It knows which tab it is in</h3>
            <p>Every open tab gets an id. It opens a new one, switches back, reads up to five at once with a single gather, and only ever closes a tab it opened itself.</p>
          </article>
          <article class="slide">
            <span class="n">04</span>
            <h3>Text it writes, not text it types</h3>
            <p>A short brief goes out and the prose streams back into the field in small chunks behind a purple outline, with the page's own undo history still intact.</p>
          </article>
          <article class="slide">
            <span class="n">05</span>
            <h3>It runs while the panel is shut</h3>
            <p><code>/every 60 check my inbox</code> books a recurring run. A green tab group gathers what it touched, the tab closes after its one task, and a notification carries the first line of the result.</p>
          </article>
          <article class="slide">
            <span class="n">06</span>
            <h3>The run is checked, not claimed</h3>
            <p>A second model reads the page the run left behind and answers passed, partial or failed — then the agent tells you how it went, in its own voice, and names only what is still open.</p>
          </article>
        </div>
        <div class="ticks" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></div>
      </div>

      <dl>
        <div class="row"><dt>Macros</dt><dd>Record a job by hand once, then replay it without the model. Passwords and card numbers are never stored.</dd></div>
        <div class="row"><dt>Vault</dt><dd>A small filesystem inside the extension: memory, plans, reports, drafts and uploads, kept on this machine.</dd></div>
        <div class="row"><dt>Transcript</dt><dd><code>/transcribe</code> captures a player's own audio in ten-second slices and lays a synced transcript over the page.</dd></div>
        <div class="row"><dt>Timings</dt><dd>Every round records read, model, act and payload, so a slow run is a number instead of a feeling.</dd></div>
        <div class="row"><dt>Skills</dt><dd>A completed run distilled into a named, parameterised method you can replay somewhere else.</dd></div>
        <div class="row"><dt>Bridge</dt><dd>Drive the same tab from any MCP client. Loopback only, no account, no key.</dd></div>
        <div class="row"><dt>Cursor</dt><dd>A green dot with a soft halo where it clicks, drawn in a shadow root so it can never intercept a click.</dd></div>
        <div class="row"><dt>Languages</dt><dd>Menus, name and description in English and 简体中文. The panel itself is English.</dd></div>
      </dl>
    </div>
  </section>

  <section class="band" id="about">
    <div class="wrap">
      <p class="label">About</p>
      <h2>One extension, one Worker, no server of ours in the middle.</h2>
      <p class="muted">The panel reads the page through Chrome's accessibility tree and the debugger, sends a compact observation to a Worker you deploy, and the Worker asks Gemini for the next one to four actions. Your plan and step log stay in Chrome's extension storage; the Worker keeps only rate-limit counters. The API key is a secret on the Worker, never in the extension.</p>
      <p class="muted">It is an unpacked developer build, not a store listing. You install it by hand, and it carries the rough edges that come with that: a Worker to deploy, a key to paste, and Chrome's own <em>started debugging this browser</em> notice while a task runs — that bar is the platform telling the truth, and it goes away when the run stops.</p>
      <p class="muted">What it is not: a way around logins, payments or CAPTCHAs, and not a cloud browser. Every action happens in a tab you can watch, and it stops and says so when something needs you — a password field, a card, a permission, a wall.</p>
    </div>
  </section>

  <section class="band" id="compatibility">
    <div class="wrap">
      <p class="label">Compatibility</p>
      <h2>Where it runs, and where it refuses.</h2>
      <div class="cols">
        <div>
          <h3>Works</h3>
          <ul>
            <li>Desktop Chrome on macOS, Windows and Linux. Other Chromium browsers should work; only Chrome is tested.</li>
            <li>HTTPS sites, plus <code>http://localhost</code> while you develop.</li>
            <li>Pages with a real DOM: forms, docs, dashboards, mail, sheets, search results.</li>
            <li>Video and audio that play in a media element, for transcription.</li>
            <li>A free Cloudflare account for the Worker and a Google AI Studio key for Gemini.</li>
          </ul>
        </div>
        <div>
          <h3>Does not</h3>
          <ul class="no">
            <li>Mobile browsers, Firefox, Safari.</li>
            <li><code>chrome://</code> pages, the Web Store, Chrome's PDF viewer.</li>
            <li>DRM video: transcription refuses rather than guessing at the audio.</li>
            <li>CAPTCHAs, password fields, card details. It stops and tells you.</li>
            <li>Anything in the background while the panel is closed, except a scheduled run driving its own tab.</li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  <section class="band" id="install">
    <div class="wrap">
      <p class="label">Install</p>
      <h2>Five steps, no sign-up.</h2>
      <ol>
        <li><b>Download the extension.</b> <a class="text" href="https://github.com/amos-donn/webagent/raw/main/dist/mezze-extension.zip">mezze-extension.zip</a>, a little over 300 KB.</li>
        <li><b>Load it unpacked.</b> Unzip, open <code>chrome://extensions</code>, turn on Developer mode, choose Load unpacked.</li>
        <li><b>Deploy the Worker.</b> Wrangler deploy with a D1 database bound as <code>DB</code>, and <code>GEMINI_API_KEY</code> as a secret. Steps are in the <a class="text" href="https://github.com/amos-donn/webagent#readme">README</a>.</li>
        <li><b>Paste the Worker URL</b> in Settings and press Test connection. It names the model that will answer.</li>
        <li><b>Star a tab, type a goal.</b> The plan appears, then the work; Alt+Shift+M opens the panel from anywhere.</li>
      </ol>
    </div>
  </section>

  <footer class="wrap">
    <span>Mezze · 1.8.0 · <a class="text" href="https://github.com/amos-donn/webagent">source</a></span>
    <span>this Worker also answers /agent · /plan · /review · /write · /skill · /transcribe · /health</span>
  </footer>
</main>

<script>
(function () {
  var carousel = document.getElementById('carousel');
  var slides = [].slice.call(document.querySelectorAll('.slide'));
  var ticks = [].slice.call(document.querySelectorAll('.ticks i'));
  if (!carousel || slides.length < 2) return;

  // Reduced motion means no content that changes by itself.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    carousel.classList.add('still');
    slides.forEach(function (slide) { slide.classList.add('on'); });
    return;
  }

  var index = 0;
  var timer = null;

  function show(next) {
    index = (next + slides.length) % slides.length;
    slides.forEach(function (slide, at) {
      slide.classList.toggle('on', at === index);
      slide.setAttribute('aria-hidden', at === index ? 'false' : 'true');
    });
    ticks.forEach(function (tick, at) { tick.classList.toggle('on', at === index); });
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function start() {
    stop();
    timer = setInterval(function () { show(index + 1); }, 6000);
  }

  show(0);
  start();

  // Nothing should rotate under a pointer that is reading it, or a keyboard that is in it.
  carousel.addEventListener('mouseenter', stop);
  carousel.addEventListener('mouseleave', start);
  carousel.addEventListener('focusin', stop);
  carousel.addEventListener('focusout', start);
  document.addEventListener('visibilitychange', function () { document.hidden ? stop() : start(); });

  var links = {};
  [].slice.call(document.querySelectorAll('.nav a')).forEach(function (link) {
    links[link.getAttribute('href').slice(1)] = link;
  });
  if (!('IntersectionObserver' in window)) return;
  var spy = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting || !links[entry.target.id]) return;
      Object.keys(links).forEach(function (id) {
        links[id].classList.toggle('on', id === entry.target.id);
      });
    });
  }, { rootMargin: '-45% 0px -50% 0px' });
  [].slice.call(document.querySelectorAll('main section[id]')).forEach(function (section) {
    spy.observe(section);
  });
}());
</script>
</body>
</html>
`;
export default html;
