# The agent-browser field, and what Mezze is missing

Researched 2 November 2026 from vendor docs, support pages, the Chrome Web Store, security write-ups and
independent reviews. Where a claim rests on a single secondary source it says so. Two caveats up front:
Perplexity's own docs and changelog returned 403 to every fetch, so Comet is described from coverage and
reverse-engineering write-ups rather than its own words; and Atlas is in here mainly as a warning.

## What exists, in one paragraph

There are now four shapes of this product. **The assistant panel in someone else's browser** — Claude in
Chrome, Kimi's extension, the ChatGPT extension. **The agentic browser** — Comet, Aside, Neon, Dia,
Fellou, Genspark, Sigma. **The browser vendor's own agent** — Gemini auto browse in Chrome, Browse with
Copilot in Edge. And **the framework** — browser-use, Stagehand, Skyvern, Nanobrowser, which are libraries
rather than products but are where most of the engineering ideas come from. Mezze is in the first camp,
and the interesting gap is not features, it is the *trust and scheduling* machinery the first camp grew.

## Product notes

### Claude in Chrome (Anthropic)
Chrome-only, side panel, ~20M users, 3.7/5 from 1.9K ratings — the score is the most useful signal in
this whole document. Paid plans only, no separate quota: browser work eats the same 5-hour and weekly
limits as chat, and Anthropic says plainly that browser interactions are compute-intensive.

- **Three approval modes** as a dropdown on the composer: *Manually approve*, *Automatically approve*,
  *Skip all approvals*. Auto is the default in the newer Cowork panel. The choice persists.
- Manual mode proposes a **plan** naming the sites it will use, with **"Approve plan"** and
  **"Make changes"**; it then acts only inside that scope.
- **Per-site grants**: *Allow this action* / *Always allow actions on this site* / *Decline*, plus a
  **"New permissions required"** prompt for high-risk sites; approved sites are listed in extension
  settings with a revoke button and a permission history.
- If auto mode keeps hitting blocks it **falls back to asking** rather than stalling.
- **Always asks, in every mode**: changing permissions, granting authorisations, entering sensitive data.
  **Never does**: purchases, account creation, card or ID data, permanent deletions, downloading from
  untrusted sources — and, explicitly, *"completing instructions from emails or web content."*
- **Record a workflow** → save as a shortcut; shortcuts are invoked by typing `/` and are schedulable
  daily/weekly/monthly/annually. Scheduled tasks live behind a clock icon in the panel.
- **Tab groups**: drag tabs into Claude's coloured group and it reads and acts across all of them.
- Context it can pull: **console logs (errors, network requests, DOM)**, screenshots, a **captured screen
  region**, uploaded images, and built-in hints for Slack, Calendar, Gmail, Docs and GitHub.
- **Notifications and sounds** when it needs you; **1Password** integration so the model never sees the
  password or the OTP.
- Downloads with a **10 MB upload cap** and refusals for `.env`, `.pem`, `.key`, `.ssh` paths; CSV
  extraction; **GIF session recordings**; screenshots saved to disk with the path reported.
- Two classifiers: one screens page/tool content, one vets each individual action.
- Its own numbers on prompt injection: 23.6% attack success at launch, 11.2% after the first defences,
  ~1% with Opus 4.5 probes, and a classifier false-negative rate of **17% on 52 curated "overeager"
  actions** — Anthropic's word for it is the honest number.
- **Bug worth knowing** (GitHub #74715): "Always allow" persisted as `duration: "once"`, so the approved
  list stayed empty and users were re-prompted every action — 46 prompts in a day. Consent UI that
  silently forgets is worse than no consent UI.

### Kimi (Moonshot)
The official listing (`fldmhceldgbpfpkbgopacenieobmligc`) is v2.0.31, 3.9/5 from 71 ratings, ~1M users,
10.32 MiB. There is **no first-party Kimi browser**; "Kimi Explorer" was a third-party summariser, and
the K2.5/Kimi Copilot listings are fan projects that say so in their own descriptions.

- Two modes: a **signed-in sidebar** and a **local agent bridge** (ex-WebBridge) that requires no Kimi
  account — the remote-control path stays free.
- The bridge is the interesting part: a local daemon speaking CDP over WebSocket on
  `ws://127.0.0.1:10086/ws`, so **Kimi Work, Claude Code, Codex, Cursor and Kimi Code can drive your
  browser**. Config at `~/.kimi-webbridge/config.json`, one install per machine, install via a curl pipe.
- **The skills trio**, verbatim from the listing: *Record actions as a skill*, *Save this session as a
  skill*, *Turn a site into a skill* — the last one decomposes a site into reusable actions.
- Multi-tab: relevant pages are gathered into **a tab group**, then **`@`** picks pages from it or you
  select text to add context.
- Sidebar history is local only, **last 10 answers per account**, export as Markdown.
- Known failures, documented by Moonshot itself: `extension_not_connected`, daemon not starting, port
  10086 occupied — and the note that "the sidebar opening does not mean the local agent is connected".
  Third-party testing adds: React/shadow-DOM/lazy-load pages are unstable, and other page-manipulating
  extensions break `snapshot`, `evaluate` and `screenshot`.

### Comet (Perplexity)
Chromium, three bundled private extensions, agent RPC over a WebSocket, page understanding as a **YAML
accessibility tree**, actions by ref id or pixel coordinates.

- **Hard boundaries**: `chrome://`, `comet://`, `file://`, `view-source:file://`, admin-blocked URLs and a
  user domain blacklist — enforced in the agent, not just advised.
- **Background assistants** and a **scheduled-task dashboard** where each task can be paused or cancelled;
  in September 2026 these became **Automations** with time *or event* triggers (Slack, Gmail, Outlook,
  Linear, GitHub) and memory of previous runs. Watching a trigger costs no credits.
- Connectors via MCP (Slack, GitHub, Asana, Linear, Notion, Atlassian, Gmail, Calendar, Shopify, later
  Microsoft 365, Stripe, Datadog, Vercel, Supabase). Each connector tool can be **"Always ask"**, and a
  thread-level grant is inherited by the recurring runs that come from it.
- **`@tabname`** to point at a tab; group tabs on request; tab groups gained pinning and custom icons.
- Per-task prompt: *Allow this time only / Always allow / Don't allow*. Settings has a Privacy Snapshot
  widget and a ≤30-day retention statement for page content sent to the model.
- Reliability, honestly: ~90% on well-described tasks, closer to one-in-three failures on delegated
  multi-step jobs with logins and JS-heavy forms. Reviews complain it **replaces the current tab**
  instead of opening a new one, loops on shopping searches, and needs a demo walkthrough at onboarding —
  a user found the agent controlling a page by accident.
- Security: the Brave disclosure (hidden Reddit comment → email + OTP exfiltration), **CometJacking**
  (crafted URL → memory and Gmail exfiltration, base64 to dodge filters), and Zenity's **PleaseFix**
  zero-click via a calendar invite. The root cause named in every write-up is the same: no instruction
  provenance, plus OAuth scopes inherited too broadly.

### Aside
YC F25, launched June 2026, macOS-first. The most interesting design in the field for our purposes,
because its memory is *files*.

- Reasoning dial: Low / Medium / High / **Ultrabrowse** for long-horizon work that "keeps working until
  it's done".
- **Routines** — recurring runs, e.g. a 9am daily briefing — plus an **Agent tabs** group and a **task
  feed** showing elapsed time and the current step ("Capturing a screenshot" → "Saving in artifacts
  folder").
- **Memory as editable Markdown**: `MEMORY.md`, `USER.md`, and episodic / companies / projects / sites
  files, with a background "**Dreaming**" subagent that extracts facts after each session, a memory
  history showing token counts and diffs, and site-specific "path that worked" notes.
- **Approval cards** for payments, posts and messages, with approve or edit; a live task timeline.
- **Aside Vault**: a password manager built for the agent, credentials autofilled into the page and never
  shown to the model, scoped per task, with an audit log.
- Developer surface: CLI, REPL, MCP. Cloud handoff is announced, not shipped.
- Its benchmark claims (99.0% Online-Mind2Web) are self-graded in its own repo; reviewers say so.

### Opera Neon
**Chat / Do / Make** agents plus **ODRA** deep research. *Make* runs in cloud compute that **continues
after you close the browser** — the only product here that genuinely does that. New tab is a chat box, not
a URL bar. **Tasks** are self-contained multi-tab workspaces; **Cards** are installable prompt shortcuts.
Browser is free since August 2026, with agents able to drive it over MCP or a CLI; $19.90/mo buys Neon's
own agents. No Chrome Web Store extensions at all.

### The rest, briefly
**Fellou** shows a step-by-step plan you approve or edit *before* execution, a "shadow workspace" for
parallel background tasks, and a cost estimate before the run. **Dia** (now Atlassian) has Morning Brief,
**Skills** (reusable and shareable workflows), Decks and Splits, and per-profile logins. **Genspark** runs
169+ open models on-device and ships an MCP store. **Sigma** has on-device inference and a
mnemonic/blockchain identity. **BrowserFly** appears only as a consumer listing with a bring-your-own API
key — no repo, no docs, treat as unverified.

### The vendors' own agents
**Gemini auto browse** (Chrome, Gemini 3): you describe a task, it **shows a plan**, you press **Start
Task**, and while it works there are **Take over / Resume / Give back task / Stop** controls. It pauses
for confirmation before purchases and posting. Gated to 18+, US, English UI, Google AI Pro/Ultra, personal
account, Safe Browsing on; **20 multi-step requests a day on Pro, 200 on Ultra**; explicitly experimental.
Can drive your local Chrome or fall back to a **cloud browser**. Chrome 149 has a **WebMCP** origin trial
so sites can expose structured tools to agents.
**Edge Browse with Copilot**: selects, scrolls and types, shows a cursor icon on the acting tab, runs
locally, asks before buying, booking, sending mail or deleting events, **cannot read autofill, saved
passwords or the wallet**, keeps screenshots 30 days.
**Atlas is dead**: switched off 9 August 2026 after 292 days, its features redistributed into the ChatGPT
extension, the desktop app and Codex. Browser memories died with it.

## The pattern everyone converges on

| capability | Claude | Kimi | Comet | Aside | Neon | Gemini | Edge |
|---|---|---|---|---|---|---|---|
| persistent approval posture | yes | — | yes | yes | — | per task | per site |
| per-site allowlist + revoke | yes | — | yes | vault scopes | — | per device | yes |
| plan shown before acting | yes | — | — | Fellou-style | — | yes | — |
| scheduled / recurring runs | yes | — | yes | yes | cloud | — | — |
| runs while the browser is closed | no | no | no | announced | cloud Make | cloud fallback | no |
| tab group per task | yes | yes | yes | yes | Tasks | — | — |
| @-mention a tab | — | yes | yes | — | — | — | — |
| take over / give back | yes | — | — | yes | — | yes | yes |
| memory as editable files | no | no | no | **yes** | — | — | — |
| console/network as context | yes | — | — | — | — | — | — |
| screen-region capture | yes | — | — | — | — | — | — |
| run recordings (GIF/trace) | yes | — | — | — | — | — | — |
| password vault for the agent | 1Password | — | — | yes | — | Password Mgr | — |
| prompt-injection classifier | yes | — | partial | — | — | — | — |

## Mezze today, honestly

Side panel only; 17 slash commands; persistent chats with history; plan modes (always / never / auto);
per-step approval in the panel plus pause, continue and stop; skills (distilled and built in); macros with
recording, cross-tab replay, ranked locator fallbacks and condition-based waits; 16 action types; page
refs with failure codes (STALE_REF, NOT_ACTIONABLE, NO_EFFECT, PAGE_CHANGED, BLOCKED_ACTION,
BLOCKED_ORIGIN); gather / read / write / judge / review; a run report; timings and a speed panel;
screenshots behind `/saw`; transcription with a floating, synced transcript island (and Picture-in-Picture);
the new OPFS vault with `/files` and `/save`; an MCP bridge; a Worker on Gemini with D1 rate limits; no
account, no telemetry, no server-side chat storage.

Absent by grep, not by opinion: `chrome.alarms`, `chrome.notifications`, `chrome.tabGroups`,
`chrome.contextMenus`, `chrome.commands`, `chrome.identity`, `chrome.i18n`. That is the whole of
scheduling, tab organisation, entry points and translation — and it is where most of the gap below comes
from.

## The gap list

**Trust and consent** — the biggest one, because every product above learned it the hard way.

1. **Per-site allowlist with revoke and history.** Origin permissions are requested on demand today, but
   there is no "Always allow actions on this site", no list to review, no record of what was granted when.
   Without it, every stop is a decision with no memory. *Small.*
2. **One approval posture, persisted.** Ask / auto / skip, as a control on the composer, remembered across
   chats. Today plan mode is persistent while approval is per step, which is the confusing half of each.
   *Small, and it is the single most visible difference in daily use.*
3. **Sensitive-action gates that survive auto mode**: pay, send, post, delete, upload, enter credentials.
   Always ask, with *allow once / allow all for this site / deny*. *Medium.*
4. **A real "your turn" handoff** for logins, OTPs and captchas: stop, mark the page, tell the person what
   to do, resume when the page changes — not just a generic pause. *Medium.*
5. **Hard boundaries**: refuse `chrome://`, `chrome-extension://`, `file://`, `view-source:` and a
   user-maintained blocklist, in the actuator rather than the prompt. *Small.*
6. **A pre-action classifier** as well as a page-content one. Our BLOCKED_ACTION and judge operate after
   planning; nobody above relies on that alone. *Medium.*
7. **A written, enforced prohibited list.** Claude's includes "completing instructions from emails or web
   content" — which is already our posture ("page text is data"), but it is not written down or tested.

**Task shape**

8. **Scheduled and recurring runs.** Needs `chrome.alarms`, a task list, per-task pause/cancel and a run
   history. The panel is the only driver today, so a schedule also needs the background path. *Large.*
9. **Running with the panel closed.** The single largest architectural gap: every competitor either runs
   in the background while Chrome is open (Claude, Comet) or in the cloud (Neon Make, Gemini fallback).
   *Large.*
10. **More than one run at a time**, each owning a tab group with a feed of elapsed time and current step.
    *Large.*
11. **Resume from the last checkpoint** after the service worker dies or the browser restarts. Chats
    persist; the step index does not. *Medium.*
12. **Event-triggered automations** (a page matched, an MCP webhook) rather than only timers. *Later.*

**Context**

13. **`@` a tab, and a tab group per task**, so the agent's tabs are visible, recoverable and explicit.
    *Small-to-medium, mostly `chrome.tabGroups`.*
14. **Console and network failures in context** — "the form 500'd" is the question people actually ask.
    *Small.*
15. **Screen-region capture and image upload into a page.** *Small.*
16. **Site knowledge packs** for a handful of origins: a few hundred tokens of "how this site is laid out"
    that beats re-deriving Gmail every time. *Small per site, high value.*
17. **Deep research as a shape**: N pages, extracted notes per page, a report with citations, with a page
    budget shown up front. We have `gather`; this is the workflow around it. *Medium.*

**Memory and files** — the half we just built the storage for

18. **`memory.md` in the prompt** and topic files the agent opens on demand (planned, phase 2). *Medium.*
19. **Memory history and diffs**, plus a distillation pass after each run ("Dreaming" is the good name).
    *Medium.*
20. **Artifacts per run**: screenshots, extracted CSVs, drafts, and one export that bundles them. *Medium.*

**Reliability**

21. **Element identity that does not rot**: a per-load id bound to the element, so an old ref fails loudly
    instead of pointing at its neighbour. Our ranked locators do this for replays; refs still go stale.
    *Small.*
22. **A learned step cache** keyed on URL + DOM hash with a safety threshold — a proven path replays
    without a model call. Macros are the manual version of this. *Medium.*
23. **Uniform pre-action checks** (visible, enabled, stationary, unoccluded) and a post-action assertion
    instead of blind retries. Partly there; make it a rule. *Small.*
24. **CDP `Input.*` for clicks and typing** via the debugger we already hold, instead of content-script
    events. Trusted input, fewer NO_EFFECT results, at the cost of the debugger banner. *Medium.*
25. **A per-run cost meter**: tokens in and out, model calls, wall clock, and a daily budget. We have
    timings; the money number is the one people watch. *Small.*
26. **An end-to-end eval set** with a verifier — and the caution from Browserbase's work that LLM judges
    false-positive at 22–45%, so the judge is itself a component to test. *Medium.*

**Entry points and platform**

27. **A keyboard shortcut and context-menu actions** ("ask about this selection", "summarise this page"),
    plus a selection quick-bar. Cheapest visible win in the list. *Small.*
28. **Notifications and a sound** when a run finishes or needs a person. `offscreen` is already used for
    audio capture, so the plumbing exists. *Small.*
29. **The on-device Prompt API** for page compression and cheap summarisation: Gemini Nano summarises a
    page to 300 tokens locally, no key, no cost — on machines with 22 GB free disk and 4 GB VRAM or
    16 GB RAM. It would cut our token bill more than any prompt tuning. *Medium, gated on hardware.*
30. **WebMCP awareness**: when a site exposes tools (Chrome 149 origin trial), call them instead of
    guessing at buttons. *Later, but watch it.*
31. **UI translation.** Nobody needs it today; every competitor ships it. *Later.*

## Small things worth stealing outright

- *"Allow this time only"* / *"Allow all for this website"* / *"Deny"* — the three-button phrasing, and the
  rule that a grant is stored where a person can see and revoke it.
- The live feed naming the step it is on right now ("Capturing a screenshot", "Saving in artifacts
  folder"), with elapsed time — not a spinner.
- **Take over / Give back task** as first-class buttons, not a pause.
- A cursor or badge on the tab that is being acted on.
- Refusals with a reason and a next step: `.env`, `.pem`, `.ssh`, over-size uploads, untrusted origins.
- "New permissions required" as its own prompt, distinct from "approve this action".
- `@tab` references and a tab group the person can see.
- A settings page listing approved sites **with a revoke button and a history** — and a bug like #74715 is
  what you get without one.
- An explicit "switch back to classic" escape hatch when the new UI is worse.
- Local history capped and exportable ("last 10 answers, export as Markdown") — small, honest, cheap.
- A cost estimate *before* a long run, and the credits spent after.
- Memory as editable Markdown files with token counts and diffs.
- Recorded workflows surfaced as `/` shortcuts, schedulable.
- "Blocked by your organisation's policy" style, enforceable at the actuator.
- Failure messages that name the fix (`extension_not_connected` → "open the sidebar once, then retry").

## What we should not copy

Owning a browser, a cloud VM fallback, email/calendar connectors, publisher revenue shares, an ad blocker,
a VPN, slide decks, a model picker, accounts and cross-device sync. Every one of those is a business
decision that would cost us the two things that make Mezze worth using: your own Worker and key, and
nothing stored on someone else's server.

## References worth reading

- Engineering: browser-use (DOM index + prompts, `save_history` / replay), Stagehand (selector cache keyed
  on method + URL + DOM hash, 48-hour TTL, re-validation before use, "a wrong cached click is worse than a
  slow click"), Nanobrowser (per-load element ids, three-level action policy, debugger-only input),
  Skyvern (vision + Playwright, live viewport, traces), PageAgent (text-only DOM agent), Browserbase
  (session recordings, evals runner, Universal Verifier).
- Numbers, all self-reported unless noted: WebVoyager browser-use 89.1%, Operator 87%, Skyvern 85.85%;
  WebArena best ~74% against a 78.2% human baseline; Online-Mind2Web best 61.3%, most agents ~30%.
  Treat them as marketing with a methodology attached.
- Security: Anthropic's prompt-injection research (23.6% → 11.2% → ~1%), the UW study finding 4 of 7
  agentic browsers broke the same-origin policy, Brave's Comet disclosure, Zenity's CometJacking and
  PleaseFix, and the ClaudeBleed `externally_connectable` issue.
- Platform rules that shape what we may build: MV3 remote-code policy (only `chrome.debugger` and
  `chrome.userScripts` may execute remote logic; models are not remote code), and the July 2026 Web Store
  update banning extensions that circumvent AI guardrails, tightening Limited Use and requiring prominent
  data-collection disclosure, enforced from 1 August 2026. Showing page content to Gemini is data
  collection; our privacy section should say so in those words.

## If we did only five things

1. Persistent approval posture + per-site allowlist with revoke (gaps 1–2).
2. Sensitive-action gates and hard URL boundaries (3, 5).
3. Keyboard shortcut and context-menu entry points (27).
4. `memory.md` injection with topic files (18) — the vault is already there.
5. A per-run cost meter (25), because the bill is the thing that makes people stop using an agent.

Scheduling (8–9) is the honest big one, and it is a background-execution project, not a feature.

## What landed after this review

Version 1.7.0 closes gaps 8, 13, 27, 28 and 31 from the list above, and does the cursor properly.

- **Scheduling** (gap 8) is now real rather than announced: `/every` and `/schedules` on top of
  `chrome.alarms`, with the next slot booked before a run starts, a per-task run count, and a background
  tab as the driver so a task works with the side panel closed. It is still not the full answer to gap 9 —
  the tab is visible runtime, not a headless agent — but it is the honest small version.
- **Tab groups** (13): tabs the agent navigates are gathered into one green *Mezze* group.
- **Entry points** (27): `Alt+Shift+M` / `S` / `P` and three context-menu items, with the request left in
  the composer rather than auto-sent.
- **Notifications** (28): a finished run that you are not watching says so on the desktop.
- **UI translation** (31): manifest strings and menu labels via `_locales`, English and Chinese. The panel
  body is still English; doing that properly is a pass of its own.
- **The cursor** is a rounded dot with a halo, no arrow and no tail.

Deliberately not done: `chrome.identity`. There is no OAuth client, no account in this design, and
`getProfileUserInfo` would add an install-time permission warning to show an email address nobody asked
for. It is a two-line change the day sync exists, and wrong before then.

## Trust, step one (1.8.0)

The approval posture is now a stored setting with three positions rather than a hardcoded `autopilot`
with dead `auto` and `manual` branches behind it. That matters more than it sounds: until 1.8.0 the panel
could not actually stop before a round, whatever the interface implied, because the mode the round loop
checks was never anything but `autopilot`. Plan mode was remembered across reloads and approval was not,
which is the half of the pair that made both feel unreliable.

Still open from the trust list: a per-site allowlist with revoke and a record of what was granted (we ask
for origins on demand and never show the total), sensitive-action gates that are a setting rather than a
regex, hard URL boundaries, and the per-run cost meter.
