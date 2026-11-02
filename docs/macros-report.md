# Macros: recording a task once and replaying it without the model

Research and design notes for the macro recorder in the Mezze side panel (extension 1.3.0). The
question was narrow: a user should be able to do a repetitive job by hand once, and have the panel
repeat it later — deterministically, cheaply, and honestly when it cannot.

## 1. What other recorders actually do

| Tool | Capture | Locator model | Timing | Credentials |
|---|---|---|---|---|
| Chrome DevTools Recorder | `RecordingClient` script injected into a dedicated isolated world via `Page.addScriptToEvaluateOnNewDocument` + `Page.createIsolatedWorld`; capture-phase listeners for `click`, `beforeinput`, `input`, `keydown`, `keyup`, `beforeunload` | ARIA selector → `data-testid`/`data-test`/`data-qa`/`data-cy` → `id` → CSS → XPath → pierce → shortest unique text | `waitForElement` (`operator` + `count`, `attributes`, `properties`, `visible`) and `waitForExpression`; per-step timeout, default 5000 ms | `change` stores the final value verbatim; no documented masking |
| Playwright codegen | injected per-frame instrumentation | role → label → placeholder → text → alt → title → test id → CSS/XPath, with `.filter()` when several match | auto-wait plus retrying web-first assertions; almost no recorded sleeps | typed into the generated code |
| Selenium IDE (`.side`) | content-script recorder | `command/target/value`, where every command carries a `targets` array of `[locator, strategy]` pairs (`id`, `css:finder`, `xpath:attributes`, `xpath:position`, `xpath:text`) | `pause`, `set speed`, `wait for …`, and the manual `clickAndWait` fix-up | plain `type` command |
| Automa | content-script `recordWorkflow` | one CSS/XPath per block, repaired by hand | per-block delay/wait blocks | none |
| iMacros | native integration | `TAG POS=n TYPE=… ATTR=…` — nth element in document order | `WAIT SECONDS=n` only | `SET !ENCRYPTION` |
| CUA agents (Operator, computer use) | screenshot loop, no script | re-derived from pixels every step | wait for the observation to change | must be excluded or injected |

Three things fall out of the table and decided this design:

1. **An ordered locator list beats one clever selector.** Selenium IDE's `targets` array is the
   reference: the same control is stored several ways and replay walks the list. Chrome's single
   "best" selector plus a documented recommendation to add `data-testid` is the failure everyone
   writes issues about.
2. **Waits are conditions, not sleeps.** `waitForElement` with a count and a timeout is the shape;
   fixed `WAIT SECONDS=n` is why recorded iMacros suites rot.
3. **Capture belongs in the page, not in CDP.** CDP's `Input` domain is a command surface — it
   synthesises input, it does not stream the user's real keystrokes — so a recorder built on
   `chrome.debugger` would still have to inject instrumentation. Capture-phase listeners in the
   isolated world see real, trusted events and cannot be blinded by a page that patches
   `window.addEventListener`.

MV3 constraints that shaped the rest ([scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting),
[service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle),
[content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)):

- `executeScript` dies with the document, so a recording that spans a navigation needs re-injection
  on every document. The session therefore lives in `chrome.storage.session`, not in a global: a
  30-second idle timeout or a restart must not end a recording.
- `pushState` navigation creates no new document, and a content script cannot see the page's own
  `pushState` (it has a different `history` object in the isolated world). The recorder polls
  `location.href` while it is installed, which is cheap and cannot be defeated by a page.
- A cross-origin iframe is a separate document with its own copy of the script, and events inside it
  never bubble to the top window. Recorded frames would have to be addressed by index path
  (Chrome's `frame: [1,0]`). Out of scope for 1.3.0, and stated as a limit rather than papered over.
- `about:blank`, `blob:` and sandboxed frames, `chrome://` pages, the Web Store and the PDF viewer
  cannot be scripted at all. The recorder says so instead of silently recording nothing.

For credentials the reference is rrweb's default (`input[type=password]` masked) plus the
`autocomplete` signals that survive a reveal-password toggle: `current-password`, `new-password`,
`one-time-code`, and the `cc-*` family. Field name, id, `aria-label` and placeholder are the last
resort heuristics. A masked field's keystrokes are not recorded at all — a masked-but-present
keycode stream still leaks length and composition.

## 2. What was built

**Recording.** `chrome.scripting.executeScript` injects `installRecorder` (a self-contained page
function in `extension/background.js`) into the acting tab. It attaches capture-phase listeners for
`click`, `input`, `change`, `focusin`, `keydown`, `pagehide` on `window`, plus a 500 ms `location`
poll for client-side routing, and reports one event per action to the panel. `chrome.tabs.onUpdated`
re-injects it on every new document, so a recording survives navigation.

**Steps.** One step per *action*, not per event:

| Step | Recorded when | Stored as |
|---|---|---|
| `click` | a real click on anything that is not a text field, select or option | target list + label |
| `fill` | typing stops for 500 ms, or the field loses focus | target list + final value (one step per field) |
| `select` | `change` on a `<select>` | target list + chosen value |
| `key` | Enter in a form field | `Enter` |
| `navigate` | the URL changed more than 4 s after the last step (a typed address, the back button, a redirect the page started) | URL |
| `secret` | the field looks like a credential | target list only — never a value |

A click that navigates produces a `click` step and no `navigate` step; the next step's locate
handles the arrival. That keeps the step list readable and avoids re-navigating a page that a click
already opened.

**Targets.** Each step stores 3–6 candidates, ranked at replay as
`testid → role+name → label → name → id → text → css`. Candidates are computed in the page and
counted at record time (`count`, `nth`), so replay can tell "the only Save button" from "the third
one". The CSS candidate is a short structural path with generated class names and hash-like ids
filtered out, and it is last.

**Replay.** The panel walks the steps and sends the existing `act` message with `target` instead of
`ref` or coordinates. `background.js` resolves the target in the page (`locateTarget`), scrolling it
into view and returning a point, then reuses the normal click/type path: real CDP input, the purple
pointer, the settle window, the effect check and the scripted-click fallback. So a replay is not a
second automation engine — it is the agent's own hands with a recorded intention. `select` is a new
action (`selectOption`: assign the value, fire `input` and `change`) because a native dropdown opens
an OS menu that synthetic input cannot walk.

Replay waits for its target (up to 6 s) instead of sleeping, and a `secret` step clicks the field,
then pauses and waits for the person — reusing the pause control added in 1.2.8, never a stored
password.

**When it breaks.** A locator list still fails eventually. On failure the replay stops, names the
step, and puts a ready-to-send repair prompt in the message box: the macro name, the failed step,
the error, and the remaining steps. Pressing send hands exactly that to the agent, which is already
capable of finishing a task from the page in front of it. This is the one thing a recorded macro
cannot do alone, and the panel is the reason it does not have to.

**Storage.** Macros live in `chrome.storage.local` under `macros`, capped at 30, with an id, name,
start URL, host, steps, last-run time and run count. Nothing leaves the browser. A recording's
in-flight steps are mirrored to `chrome.storage.session` so closing and reopening the side panel
does not lose them.

## 3. Deliberate limits

- **Top frame only.** No cross-origin iframe recording; a step inside a Stripe/Elements frame is not
  captured. Stated in the UI hint and the README.
- **No assertions.** A macro verifies that each action changed the page (`NO_EFFECT` is an error),
  but it does not record "check that the total is £42". That belongs to a different feature.
- **No editing beyond deleting steps** while recording, and no export. Chrome's JSON format was not
  adopted: it is a Puppeteer replay schema with its own vocabulary, and nothing in this project
  consumes it.
- **No hover steps.** Chrome's recorder deliberately does not record hover; menu-open-on-hover sites
  need a click first.
- **Recording stops if the panel closes** — the recorder keeps running in the page, but the events
  have nowhere to go. Reopening the panel resumes from session storage; the tab is re-armed on its
  next navigation.

## 4. Risks and what would prove them wrong

| Risk | Mitigation in 1.3.0 | What would show it failing |
|---|---|---|
| Generated ids and class hashes in the `id`/`css` candidates | `id` is only stored when unique and not hash-like; CSS is last | a replay that matched the wrong row after a deploy |
| The same label appears twice on screen | `nth` recorded with `count`; a step targets the occurrence it was recorded on | a macro clicking the wrong "Save" on a page with two forms |
| A click navigates before the panel records it | click is recorded synchronously in the page; navigation arrives later as a `page` event | steps arriving out of order in the recording list |
| A recording inside a cross-origin iframe | not captured; documented | a login widget step missing from the list |
| An SPA re-renders the control between locate and click | locate returns a point, then the normal action path runs; a `PAGE_CHANGED`/`STALE_REF` stops the replay with the repair prompt | intermittent failure on a virtualised list |

## 5. Sources

- DevTools Recorder reference and extension API: <https://developer.chrome.com/docs/devtools/recorder/reference>,
  <https://developer.chrome.com/docs/extensions/reference/api/devtools/recorder>; capture internals
  described at <https://flatt.tech/research/posts/non-intrusive-web-recon-techniques-from-chrome-devtools-recorder/>
- Playwright codegen and locator ladder: <https://playwright.dev/docs/codegen>, <https://playwright.dev/docs/locators>
- Selenium IDE `.side` structure and commands: <https://www.selenium.dev/selenium-ide/docs/en/api/commands>,
  <https://www.selenium.dev/documentation/legacy/selenium_ide/>
- Automa recorder block graph: <https://github.com/AutomaApp/automa/tree/main/src/content/services/recordWorkflow>
- iMacros command reference (mirror): <https://gist.github.com/x011/f0b2af25631aeffadf040830897521f9>
- MV3: <https://developer.chrome.com/docs/extensions/reference/api/scripting>,
  <https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle>,
  <https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts>,
  <https://developer.chrome.com/docs/extensions/reference/api/debugger>
- rrweb privacy model and masking defaults: <https://github.com/rrweb-io/rrweb/blob/main/guide.md>
- Isolated-world `pushState` problem: <https://github.com/wxt-dev/wxt/issues/1567>
