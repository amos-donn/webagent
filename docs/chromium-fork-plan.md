# A browser of our own: what forking Chromium would and would not buy Mezze

*Research note, November 2026. The question: could we build Mezze on a Chromium of our own, so the settings and
the OS behave however we want, and the agent stops hitting Chrome's ceilings? Answer up front: the ceilings are
real, roughly three quarters of them are purchasable with an Electron shell in months rather than a fork in
years — and the part a fork cannot buy back is the thing that makes Mezze useful today, which is that it runs
inside the browser the person is already logged into.*

Everything below separates published figures (with links) from planning estimates, because the two get confused
in every "we'll just fork Chromium" conversation.

---

## 1. The ceilings, named

These are the six walls we actually hit, with their 2026 state. "Wall" means: no amount of skill inside the
extension removes it.

| Wall | What the platform does | Can an extension escape it? |
|---|---|---|
| **Service worker lifetime** | Terminated after 30 s idle, or when a single event runs past 5 minutes, or when a `fetch` response takes over 30 s. Global state is lost. An active `chrome.debugger` session keeps it alive (Chrome 118+), as do long-lived ports, WebSockets and `alarms` ≥ 30 s (Chrome 120) — but as of May 2026 the W3C WebExtensions thread on service workers records local inference being **killed mid-generation with no error and no partial result**, and offscreen documents are documented as "not immune". Chrome's own position, in the older thread: terminating an unused worker "is a feature, not a bug". | No. Only workarounds, and they fail when the browser is backgrounded. |
| **Debugger disclosure** | `chrome.debugger` shows "‹extension› started debugging this browser" with a **Cancel** button, is limited to a CDP domain subset, and the user can detach at will (`canceled_by_user`). `--silent-debugger-extension-api` is a launch flag, so it cannot reach a browser already running. Anthropic asked for a supported suppression in June 2026; it was closed as not planned in July. A measured test in August 2026 found raw CDP over `--remote-debugging-port` on branded Chrome 151 showed **no** banner, while `chrome.debugger` did. | No. Disclosure is deliberate, and it is Chrome's decision, not ours. |
| **Driving the real session** | `--load-extension` was removed from branded Chrome 137 (May 2025); silent side-loading now needs Chrome for Testing or enterprise policy. | No — we ship an extension and ask people to load it. |
| **Side panel** | `sidePanel.open()` (Chrome 116+) requires a user gesture and a `tabId` or `windowId`; a call that lands after an `await` loses the gesture. | No. An agent cannot surface its own UI unprompted. |
| **Hidden DOM** | `chrome.offscreen`: one document per profile, `runtime` API only, static bundled URL, non-focusable, lifetime fixed by a reason enum. | No. |
| **Native/OS access** | Native messaging needs a separately installed host, registered in the registry or a fixed per-browser directory, bound to specific extension IDs, with a 1 MB inbound cap, and it is unavailable in content scripts. | Not without asking the user to install a second thing. |
| **Network and code** | `declarativeNetRequest` declares rules ahead of time; MV3 forbids remotely hosted code. | No. |

Everything else people blame on "Chrome's limits" — the approval posture, per-site grants, a cost meter, the
vault, scheduling — is **our own product surface**, sitting on top of the same APIs a fork would give us. A fork
does not make those better; it makes them ours to maintain.

---

## 2. The four ways to stop being only an extension

| | **Electron shell** | **CEF** | **Full Chromium fork** | **Local driver over CDP** |
|---|---|---|---|---|
| What it is | Chromium + Node, own windows; page in `WebContentsView`, agent drives it via `webContents.debugger` | C++ embedding, Chrome-runtime or Alloy | Rebase Chromium, ship your own binary | A normal app (or CLI) driving Chrome/Chromium over `--remote-debugging-port` |
| Current base | Electron 45 = Chromium 156, Node 24.22 (stable Oct 2026, EOL Apr 2027), four majors a year | CEF 145 docs; typically closer to upstream than Electron | Whatever you rebase to — forever | Whatever Chrome the user has |
| Background lifetime | **Solved.** A process that lives as long as the app | Solved | Solved | Solved if the driver is the long-lived thing |
| Debugger banner / Cancel | **Gone.** In-process CDP, no disclosure UI | Gone | Compile it out if you like | **Gone** in the measured 151 test |
| Full CDP surface | Yes, any method, plus per-target sessions | Yes via the debugging port | Yes, and you can add your own domains | Yes |
| Chrome Web Store extensions | **No.** Electron calls store extensions a non-goal; unpacked only, no persistence across restarts | Only with the Chrome runtime, via UI/policy; programmatic management has been an open request since Feb 2023 | Yes — if you solve the business/ToS side, which is not code | The user's Chrome keeps its own extensions |
| Widevine / DRM | Not in stock; castLabs' Electron for Content Security ships the CDM and VMP signing (production VMP via their EVS) | Official builds ship no proprietary codecs; you build your own with `proprietary_codecs=true` and license the codecs | You build the codecs and re-implement the CDM installer | The user's Chrome already has it |
| Auto-update | Solved: `autoUpdater` / `electron-updater`, signed and notarised builds | **None.** You build Omaha/Sparkle or a bespoke updater | You own it: Omaha is open source but branded for Google; published integration from €12,000 per OS plus €399/month hosting | None needed — Chrome updates itself |
| Security patching | Electron patches on its own schedule (4 majors/year, ~6 months support) | You rebuild ~200 MB per CEF bump, and CEF has **no security announcement list** and lags Chromium | **You are the security team.** Chrome is on a two-week stable cadence from Chrome 153 (Sept 2026) | Google's problem |
| Footprint | 100–300 MB installed | ~150–250 MB (estimate from the documented file layout) | Chrome-sized, plus build machines | Nothing new |
| Effort to something credible | **2–4 engineers, 3–6 months** (estimate) | 5–10 engineers, 9–18 months, plus 1–2 permanently on CEF branches (estimate) | A company (below) | Weeks to months |

The pattern is not subtle. Each step right buys more control and costs more maintenance, and the last column
buys nearly all of the *capability* for almost none of the *distribution*.

---

## 3. What a fork uniquely gives

Worth being precise, because "more powerful" is doing a lot of work in the question:

1. **No disclosure at all.** No infobar, no Cancel, no CDP subset. Silent full-CDP control of a browser we ship.
2. **Our own profile and flags.** No enterprise policy can block `attach()`; no Chrome-for-Testing workaround.
3. **A UI we own end to end.** The panel is a real docked surface, not a side panel with a gesture gate; we can
   put agent state in the toolbar, the tab strip, the omnibox; windows can appear when the agent needs attention.
4. **Native in-process.** Files, tray, global hotkeys, autostart, notifications, local sockets — no installer
   ritual, no 1 MB cap, no separate host process.
5. **Full reach.** `chrome://` pages, other extensions' surfaces, the network stack (response bodies, not just
   declared rules), our own extension store with our own review policy.
6. **Custom CDP domains.** A first-class `Mezze.*` domain, so the agent's primitives are the browser's primitives.

That list is real, and it is why every serious AI-browser effort in 2025–26 started from Chromium.

---

## 4. What a fork costs

### The rebuild that never ends

Chrome moved to a four-week milestone in 2021, added weekly security releases in 2023, and moved to a
**two-week stable cycle with Chrome 153 on 8 September 2026**; Extended Stable stays at eight weeks and is
explicitly described as being for "enterprise administrators and Chromium embedders who need additional time".
Read that sentence again from the perspective of a fork: the *slow* channel exists because people who embed
Chromium cannot keep up.

Brave, which is the best-documented fork, runs a **one-day SLA** for Chromium zero-days, force-updates through
the "critical" update feature, and ships through Omaha test channels before production, with CDN cache purges
and verified delta upgrades. Their releases track Chrome by one to two days (156.0.8078.74 one day after
Chrome's 27 October 2026 release; 156.0.8078.80 one day after the 29 October one). Two weeks per milestone, one
to two days per security patch, forever.

The architectural lesson from the people who do this commercially is blunter than the marketing: **do not
maintain a git fork with merges.** Keep a small patch stack, cherry-pick, and add new files — they say outright
that fork-and-merge "is what sometimes makes us see Chromium forks fail".

### The build

Officially: x86-64, 8 GB RAM minimum with ">16 GB highly recommended", **at least 100 GB free disk**, clang only,
GN plus Siso, a 30-minute-or-many-hours source fetch, and a full build that is hours on a workstation and most of
a day on a laptop (planning estimate — the only official benchmark in the docs is from an old 12 GB workstation).
Distributed compilation is available (REAPI through Siso, EngFlow commercially) and **none of the pricing is
public**.

### The team

| Project | Shape | Team | Time to first release |
|---|---|---|---|
| Vivaldi | Chromium fork, HTML/JS UI | ~60 staff total (Apr 2025), employee-owned | Technical preview ~1 year; 1.0 ~2 years |
| Brave | Chromium fork + patch layer | "From 2 to over 100" by 1.0 | Announced Jan 2016, 1.0 Nov 2019 |
| Arc | Chromium + Swift UI | ~50–60 reported (unverified) | Founded 2019, macOS Jul 2022 — **being shut down 22 Dec 2026** |
| ChatGPT Atlas | Chromium + "OWL" layer | Not disclosed, OpenAI-scale | macOS-only 21 Oct 2025; folded into the desktop app Mar 2026; **shut down 9 Aug 2026** |
| Perplexity Comet | Chromium-based | Not disclosed | Windows + macOS 9 Jul 2025 |

Two of the five are dead within a year of shipping. That is not an argument that the engineering is impossible —
it is evidence that shipping a browser is the cheap part, and that a browser with no distribution is worth
nothing.

### The money

Published by Omaha Consulting (who serve Brave): **€12,000 per target OS** for automatic-update integration,
**€399/month** hosting, €8,000 for an Omaha client fork, €15,000 for a self-hosted server licence. Windows
code signing has required an **EV certificate** since June 2023 (hardware token or cloud HSM); macOS needs a
Developer ID, hardened runtime and notarisation. Distributed builds, CI storage for 100 GB checkouts, crash
reporting, and a support function are all extra.

### The legal walls

- **Widevine cannot be redistributed.** It is off by default in Chromium and licences do not permit shipping the
  CDM, so DRM playback needs component-updater fetching from Google (what Vivaldi and Brave do) plus **VMP
  signing** for production playback.
- **Proprietary codecs** (H.264/AAC) are not in official CEF builds "due to licensing reasons"; you build with
  `proprietary_codecs=true` and take on the licensing analysis yourself.
- **The Chrome Web Store is Google's.** A fork can install CWS extensions because it speaks the same APIs, but it
  inherits Google's review policy, its MV3 timeline and its decisions — which is precisely what Brave avoided by
  building its ad-blocker into the browser instead of shipping an MV2 extension. Running *our own* store is a
  policy and trust function, not a checkbox.

### What we would lose

The current pitch is unusually clean: it is an extension you can read, it asks for the sites it needs, and it
runs in the browser you already use. A fork would be a 200 MB download, from an unknown developer, with an
installer, an updater, a signing certificate and a privacy policy — and it would start with **an empty profile**.

---

## 5. The part that decides it

Mezze's value today is not that it controls a browser. It is that it controls *your* browser: your logins, your
SSO session, your extensions, your bookmarks, the tab you already have open. That is the product.

A fork starts at zero. No passwords, no cookies, no corporate SSO, no 1Password. Users would have to log into
everything again, in a browser with no history, no sync, and — by the research above — no store extensions
(Electron), or store extensions only as a business relationship (fork). The agent gets *more powerful* and the
product gets *less useful*, on day one, for everyone.

That asymmetry is why the honest answer is not "fork or don't". It is: **fork only if we intend to become a
browser vendor**, because that is what the price buys.

---

## 6. What to do instead, in order of cost

**Stage 0 — the extension (now).** Keep shipping. It is the only form factor that runs inside the session the
person is already in, and the review of the field found the gaps were trust machinery and scheduling, not
raw capability.

**Stage 1 — a runner, not a browser (weeks).** We already opened this door: scheduled tasks drive a background
tab because the panel cannot be the only driver. Promote that into a real **runner page** — owns the loop, the
debugger attachment and a persisted job queue, survives a reload, resumes after a crash, and does not care
whether the side panel is open. Then add an **optional local companion** (a small Node process over native
messaging or plain CDP on loopback) for the people who want no banner, no 5-minute ceiling, arbitrary CDP and a
real filesystem. That is the shape Google itself ships: `chrome-devtools-mcp` is a local process driving Chrome
through Puppeteer, with full CDP, and it sidesteps every wall in §1 — because it is not an extension.

This is also the cheap answer to "settings and OS however we want": a companion process can do tray icons,
global hotkeys, autostart, native file dialogs, and its own updater. None of that requires owning Blink.

**Stage 2 — an Electron shell (months).** If distribution starts to matter more than "runs in your browser",
wrap the same runner in Electron 45: `WebContentsView`, `webContents.debugger`, own profile, trays and hotkeys,
`electron-updater`. 2–4 engineers, 3–6 months to something credible. Accept no store extensions and no DRM
unless we take castLabs' build. Keep the extension shipping in parallel — they are the same agent core with two
surfaces.

**Stage 3 — a fork (a company).** Only when we need to *be* the browser: our own store, DRM, default-browser
position, enterprise policy, silent actuation as a product promise. At that point the question is funding and a
standing security team, not engineering difficulty.

---

## 7. Decision triggers

Move to Stage 2 when any of these is measured, not guessed:

- a meaningful share of runs end because the person hit **Cancel** on the debugger infobar, or because the
  service worker died mid-task while the browser was backgrounded;
- people ask for tray, global hotkey or autostart more often than they ask for new agent skills;
- a single tool call needs more than five minutes;
- the vault's OPFS ceiling (2 MB text, 25 MB uploads) blocks real work.

Move to Stage 3 when the product *is* the browser — a store, DRM, or default-browser placement — and there is
funding for a permanent Chromium patch team on a two-week cadence.

Until then, the cheapest large win is not an engine. It is **the runner plus a companion process**, which is the
same architecture the platform's own agent tooling converged on.

---

## 8. What this research could not establish

- Wall-clock cold-build time for Chromium on 2026 hardware. The only official timings are from an old 12 GB
  workstation; vendor figures ("2–4 hours on 32-core/64 GB") come from a consultancy blog.
- Distributed-build pricing. EngFlow is named as the commercial option; no public price.
- Google's formal position on Chrome Web Store access for non-Chrome browsers. The characterisation above is a
  risk statement, not a quoted policy.
- Current castLabs EVS pricing, and whether `--silent-debugger-extension-api` still behaves on current branded
  Chrome — sources conflict.
- Headcount and funding for The Browser Company, Perplexity's browser team, and Opera Neon's general
  availability date; several widely repeated figures are inconsistent between trackers.

Sources: [Chromium Linux build instructions](https://github.com/chromium/chromium/blob/main/docs/linux/build_instructions.md),
[Chrome's two-week release cycle](https://developer.chrome.com/blog/chrome-two-week-release),
[Chrome Releases, October 2026](https://chromereleases.googleblog.com/2026/10/),
[Brave's release checklist](https://github.com/brave/brave-browser/issues/48025),
[Omaha Consulting: how to fork Chromium](https://omaha-consulting.com/how-to-fork-chromium) and [pricing](https://omaha-consulting.com/pricing),
[Electron 45 schedule](https://releases.electronjs.org/schedule),
[Electron debugger API](https://www.electronjs.org/docs/latest/api/debugger),
[Electron extensions (non-goal)](https://www.electronjs.org/docs/latest/api/extensions),
[Electron code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing),
[castLabs Electron for Content Security](https://github.com/castlabs/electron-releases),
[CEF](https://github.com/chromiumembedded/cef) and [general usage](https://chromiumembedded.github.io/cef/general_usage),
[service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle),
[w3c/webextensions#1014](https://github.com/w3c/webextensions/issues/1014),
[w3c/webextensions#72](https://github.com/w3c/webextensions/issues/72),
[chrome.debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger),
[Claude in Chrome banner request #69287](https://github.com/anthropics/claude-code/issues/69287),
[measured banner comparison](https://wiki.adom.inc/adom/pup-bridge/files/docs/WHY-CFT.md),
[sidePanel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel),
[offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen),
[native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging),
[WebMCP](https://developer.chrome.com/docs/ai/webmcp),
[WebMCP state, July 2026](https://www.spronta.com/blog/state-of-webmcp-july-2026/),
[Chrome at I/O 2026](https://developer.chrome.com/blog/chrome-at-io26),
[chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp),
[WebDriver BiDi](https://www.w3.org/TR/webdriver-bidi/).
