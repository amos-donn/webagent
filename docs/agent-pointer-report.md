# Showing the agent on screen — a visible pointer for Webagent's actions

Research on drawing a purple cursor that slides to the click target and animates when it clicks, so a person watching the tab can follow what the agent is doing even though no real mouse is moving.

**Verdict: yes, with no change to the control path.** The agent already knows every click point before it clicks (`scalePoint` → `{x, y}` in `extension/background.js`), so the overlay is presentation only: it reads the same coordinates the input dispatch uses, draws a cursor there, and waits out the slide. No new permissions, no manifest change, no model change, no new dependency.

---

## 1. Why nothing is visible today

`clickPoint()` sends `Input.dispatchMouseEvent` (`mouseMoved` → `mousePressed` → `mouseReleased`) over `chrome.debugger`. That is CDP-level input: Chrome's renderer receives the events and the OS pointer never moves. There is no cursor to see because no cursor exists — the same reason Chrome DevTools' own "inspect element" highlight is drawn, not pointed at.

So there is nothing to "show" that is already there. It has to be drawn, in one of three places:

| Where the cursor is drawn | Possible from this extension? | Notes |
|---|---|---|
| In the page, by us (injected element) | **Yes — today, on any Chrome ≥ 116** | Full control of shape, colour, easing, ripple |
| In the page, by Chrome (`Page.setInputVisualization`) | Yes, from Chrome 158 (stable ~16 Nov 2026) | Browser-drawn, page can't observe it — but only a `clicks` toggle |
| On the desktop, the real system pointer | No | Needs a native host and OS permissions; moves the user's actual mouse |

The real-OS-pointer route (computer-use style) is what desktop agents use and it is the one that cannot be done from an extension. It is also undesirable here: it steals the user's mouse.

## 2. The recommended approach: an injected overlay

This repository already ships the exact mechanism and the exact colour. `writeBoxShow()` in `extension/background.js` injects a `position:fixed; pointer-events:none; z-index:2147483647` element with `#a855f7` borders, a `rgba(168,85,247,…)` glow, a `#6d28d9` chip and a `wa-shimmer` keyframe animation — the "Gemini is writing…" box. A cursor is the same technique with a different shape, so there is no new pattern to establish, only new geometry.

### 2.1 Shape of the change

1. **One persistent host per tab.** Inject a `<div>` with an open **shadow root** once, then keep it mounted for the life of the document.
2. **Remember where the cursor was.** The injected function reads its own current transform to learn the previous position, so the slide starts from the last click — and survives a service-worker restart, which matters because `background.js` is an MV3 worker that suspends. (Storing it in `chrome.storage.session` alongside `ax:<tabId>` also works, but reading the DOM needs no round trip.)
3. **Slide, then click.** Before `clickPoint()`, call the overlay with the target point and `await` the travel (`element.animate()` or a CSS transition, 240–320 ms, `cubic-bezier(.22,.61,.36,1)`). Then dispatch input exactly as today.
4. **Click animation.** At the press moment, play an expanding ring at the point (`scale(.2) → scale(1)`, `opacity .55 → 0`, ~420 ms) and a 0.92 scale "press" on the cursor glyph for ~90 ms. The ring continues after the input is dispatched, so the animation costs nothing extra.
5. **Hook the four pointing actions.** `click`, `type` and `fill` go through `clickType()`, and `write` goes through `writeInto()`; all four already compute a point first. `navigate`, `read`, `scroll`, `wait` and `key` have no target point, so they stay silent by default.

Rough sketch, in the same self-contained-function style the file already uses (`chrome.scripting.executeScript` serialises the function body, so it may not reference outer scope):

```js
async function pointerTo(tabId, point) {
  return chrome.scripting.executeScript({ target: { tabId }, func: (x, y) => {
    const id = 'webagent-pointer';
    let host = document.getElementById(id);
    if (!host) {
      host = document.createElement('div');
      host.id = id;
      host.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:2147483647';
      host.attachShadow({ mode: 'closed' }).innerHTML = `
        <style>…purple arrow + ripple ring, no text…</style>
        <svg class="cursor" viewBox="0 0 24 24">…</svg>
        <span class="ripple"></span>`;
      document.documentElement.appendChild(host);
    }
    const root = host.shadowRoot, cursor = root.querySelector('.cursor');
    const from = host.dataset.x ? { x: +host.dataset.x, y: +host.dataset.y } : { x, y };
    host.dataset.x = x; host.dataset.y = y;
    const slide = cursor.animate(
      [{ transform: `translate(${from.x}px,${from.y}px)` }, { transform: `translate(${x}px,${y}px)` }],
      { duration: from.x === x && from.y === y ? 0 : 280, easing: 'cubic-bezier(.22,.61,.36,1)', fill: 'forwards' }
    );
    return slide.finished.then(() => true);
  }, args: [point.x, point.y] }).then(() => {}, () => {});
}
```

Then in `clickType()` and `writeInto()`: `await pointerTo(tab.id, point)` immediately before `clickPoint(target, point)`, and fire the ripple in the same injected call as the press.

Because the click is delayed by the slide, per-action latency rises by ~280 ms. That is noise next to a model round trip of seconds, and the existing `await sleep(120)` after `clickPoint` can absorb part of it.

### 2.2 Gotchas that are specific to this codebase

These are the parts that would bite, and each has a cheap fix:

- **`pageSignature()` counts nodes.** It hashes `${location.href}|${innerText.length}|${hash}|${document.querySelectorAll('*').length}|${scrollY}|${activeTag}`. `querySelectorAll('*')` does **not** descend into shadow roots, so a shadow-DOM overlay keeps the child count stable — but the host element itself adds exactly one node the first time it appears. If the host is created during the click and removed after, the fingerprint changes and `effect.verified` reports a **false success** on that action. Fix: mount the host once and leave it (hidden when idle), or skip ids starting with `webagent-` when counting. Do not create-and-remove per click.
- **The overlay would appear in the model's screenshot.** `shoot()` sends a JPEG to Gemini with every observation, and `Page.captureScreenshot` with `fromSurface: true` includes DOM overlays. Hide the overlay (opacity 0) before capture. This is exactly what Claude in Chrome does — its bundle hides its own overlay before every tool-use capture — so the agent never sees its own UI.
- **The sum of these two is a real bug risk**: a visible cursor in a decision screenshot could be mistaken for page content, and a node-count change could fake a verification. Both are solved by one persistent host plus a hide-before-capture call.
- **Injection can fail.** Some pages block `chrome.scripting.executeScript`. Every call must degrade silently (`.catch(() => {})`), which is already the house style for `writeBoxShow` / `writeBoxHide`.
- **Respect `prefers-reduced-motion`.** `panel.css` already disables animations under that media query; the overlay should do the same (jump straight to the point, keep the ring static or skip it).
- **Don't collide with the write box.** A `write` action currently draws the purple outline and "Gemini is writing…" chip. Park the cursor at the field and let the box take over; two purple overlays stacked on one field look like a bug.
- **Per-tab, not global.** The overlay is drawn in the tab being driven; the run no longer activates that tab before acting, so the cursor is there when you look at it but the agent does not pull you away from what you are doing. Tabs are switched explicitly by the agent (`observe`/`act` with `tabId`), so no cross-tab ghost is needed.
- **Frames.** Clicks already land in the top frame only (coordinates come from the top-frame viewport), so a top-frame overlay is always in the right coordinate space.
- **It is not evidence.** The overlay shows intent, not proof. Keep `effect.verified` from the fingerprint as the record of what actually happened; the chrome-devtools-mcp thread makes this point sharply — a visual cue must not be read as confirmation that a target was hit.

### 2.3 Make it optional

Add a **Show pointer** checkbox to the existing Settings dialog next to **Local bridge**, stored the same way (`chrome.storage.local`). Default on for Autopilot (watching is the point) and in Ask-each-round mode (the approval card already overlays a red crosshair `#marker` on the screenshot at the proposed point, so a live pointer completes that story). Off remains one click away for anyone who finds it distracting.

## 3. The native path: `Page.setInputVisualization`

Chrome added this in October 2026 while the same feature was being debated in `chrome-devtools-mcp` #2401. The maintainers explicitly preferred a browser-drawn overlay over page injection, "so pages can't observe or interfere with it", and it landed as a CDP command rather than an extension-side pattern. Exact schema from `browser_protocol.json`:

```json
{ "name": "setInputVisualization",
  "description": "Configures input visualization on the page.",
  "experimental": true,
  "parameters": [{ "name": "clicks", "description": "Whether to enable click visualization.",
                   "optional": true, "type": "boolean" }] }
```

Assessment:

- **It cannot deliver this feature on its own.** There is one parameter, `clicks: boolean`. No colour, no glyph, no travel animation, no ripple timing — so "purple cursor slides to the target, then clicks" is not expressible. The injected overlay is the only way to get the requested look today.
- **It is not shipping yet.** The command reached the protocol and the Puppeteer wrapper (`browser.visualizeInput()`, PR #15608) is still a draft marked *DO NOT MERGE* because the command "requires Chrome 158 or later". Chrome stable is 157.0.8103 in the week of 2 Nov 2026, with 158 expected around **16 Nov 2026** (Chrome moved to a two-week stable cadence in Sept 2026).
- **It is worth keeping as the fallback.** Where `executeScript` is blocked and the tab is on Chrome ≥ 158, a browser-drawn click indicator is better than nothing. Call it, swallow the error on older Chrome (this extension still supports 116+), and never make it the primary path — otherwise one Chrome update changes the product's look.

## 4. Prior art

- **OpenAI's computer-use demo** draws a virtual cursor because it drives a real desktop; that is a different problem and not available to an extension.
- **`chrome-devtools-mcp` #2401** is the closest match: an opt-in `--visual-cursor` flag that slides a ghost cursor to the target and shows an expanding ripple, injected via `Page.addScriptToEvaluateOnNewDocument`, degrading silently, with zero behaviour change when off. The prototype (PR #2400) was closed pending the native discussion — which is roughly the implementation proposed here, one layer up.
- **`browser-use` #1519** states plainly that it does not do human-like cursor movement: its focus is efficient automation, not visual mimicry. The visible-cursor feature in agent UIs generally exists for *supervision*, not for looking human.
- **`Xetera/ghost-cursor`** generates Bezier mouse paths for Puppeteer to look human. Its motion model (arc + slight overshoot) is a good source for the easing curve if the slide ever needs to look less mechanical — but it fakes the input path rather than drawing one, and it is not needed here: the agent clicks a point, it does not need a plausible journey.
- **Claude in Chrome** hides its overlay before every screenshot — the pattern this design must copy (§2.2).

Anti-bot note: a visible cursor buys nothing for evasion. Pages can see injected DOM (a shadow root hides styling, not existence), and `Input.dispatchMouseEvent` stays synthetic with `isTrusted: true` but no real pointer trail. If avoiding detection ever matters, this is the wrong tool; `ghost-cursor`-style path faking is a separate decision.

## 5. Cost

| Item | Estimate |
|---|---|
| Cursor overlay, slide, ripple, hide-before-capture, `prefers-reduced-motion` | ~70–90 lines in `extension/background.js`, ~**half a day** |
| Settings checkbox + storage + passing the flag through `handle('act')` | ~15 lines in `panel.html` / `panel.js`, ~1 hour |
| `pageSignature()` guard so the overlay never fakes a verification | 1 line, and a test that a click's `verified` is unchanged with the overlay on |
| Native `setInputVisualization` fallback for Chrome ≥ 158 | ~10 lines, optional, after 16 Nov 2026 |

No new permissions, no manifest change, no dependency, no Worker or model change, and no extra network traffic. The existing tests (`tests/worker.test.mjs`, `tests/bridge.test.mjs`) do not touch the overlay path; the useful check is a manual one — run a task with the pointer on, watch it slide and ripple, and confirm the step log's *no visible change* verdicts are identical with the pointer on and off.

## 6. Recommendation

Build the injected overlay: purple arrow, ~280 ms slide from the previous click, ripple at the press, persistent shadow-DOM host, hidden during screenshots, off-switch in Settings. Treat the native `Page.setInputVisualization` as a Chrome-158 fallback for pages that refuse injection, and revisit it if Chrome ever exposes styling for what it draws.

## 7. Sources

- [chrome-devtools-mcp #2401 — Visual cursor overlay for input automation on headed Chrome](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/2401) (proposal, maintainer response, native command note)
- [`devtools-protocol` `browser_protocol.json`](https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/browser_protocol.json) — `Page.setInputVisualization` (`clicks?: boolean`, experimental)
- [puppeteer/puppeteer #15608 — `feat: add browser.visualizeInput()`](https://github.com/puppeteer/puppeteer/pull/15608) (draft; requires Chrome 158)
- [Chrome Releases](https://chromereleases.googleblog.com/) and [browsercalendar.com/browsers/chrome](https://browsercalendar.com/browsers/chrome) — stable 157 (2 Nov 2026), 158 expected 16 Nov 2026
- [browser-use #1519 — how to move the cursor](https://github.com/browser-use/browser-use/issues/1519) (no human-like cursor support by design)
- [Xetera/ghost-cursor](https://github.com/Xetera/ghost-cursor) (Bezier motion model)
- This repository: `extension/background.js` — `clickPoint`, `clickType`, `writeInto`, `writeBoxShow`, `pageSignature`, `shoot`; `extension/panel.js` `#marker`; `extension/panel.css` `prefers-reduced-motion`
