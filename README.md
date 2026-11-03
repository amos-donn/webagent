# Mezze

A Chrome Manifest V3 side-panel agent for multi-step workflows on HTTPS websites. It acts in the tab you star (★), can read text from up to five other open tabs (+) as context, and switches into one of those tabs when the task needs it, asking the Gemini API for the next move. A single reply can carry one to four actions that run back to back, so filling a form or a document does not cost a round trip per field. It drafts a 3–6 step plan before it starts, shows that plan as a checklist in the side panel, keeps it across steps and panel reloads, and only ticks an item off once a verified action backs it up — a tick you disagree with can be clicked to undo it. It can think through a plan, click, type into ordinary text fields and canvas editors such as Google Docs, read the full page text, scroll, wait for loads, navigate, press keys, and summarize. Every step lands in a timeline in the chat, with the current action pinned at the bottom while it runs. Each step sends the full action history — the last sixteen steps with the control each one touched, its result and the page URL after it, older steps condensed — plus a **PROVEN DONE** list of what already worked, so the agent does not forget what it tried and does not click a button that has already done its job. It also receives an interactive-element map of the viewport (role, label, and centre coordinates) alongside the screenshot, which makes clicks far more accurate than vision alone. Every action is checked against a page fingerprint: a click or key press that changes nothing is marked *no visible change*, an unresponsive click gets one scripted fallback, and the panel re-reads the page and retries when it shifted underneath. The Worker rejects a step that repeats an action the page did not respond to and asks the model to choose differently, refuses a plan tick with no successful step behind it, and refuses a premature `done` while plan items are unchecked. **Autopilot** is on by default: each reply's actions run immediately and back to back, and the agent keeps working on its own, including clicks that may submit forms or make irreversible changes. Turn Autopilot off to review each round's actions, text and screenshot marker before they run. There is no Continue button: it carries on by itself and only stops when the goal is done, you press Stop, or something outside the browser blocks it. It stops after 60 actions. The Stop button prevents subsequent actions, but an action already in progress may still finish. It cannot access Chrome internal pages, and it blocks typing into password fields and forms containing password inputs. Use only on sites and tasks you are authorized to automate.

The extension is **Mezze**. The Worker, its D1 database and the bound hostname keep their original `webagent` names on purpose: renaming a Worker creates a new one on a new hostname, so the deployed URL, the database and the build pipeline would all have to be migrated for a cosmetic change. Nothing user-facing says `webagent` any more.

## Install the extension

Download [dist/mezze-extension.zip](dist/mezze-extension.zip), unzip it, open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked** with the extracted folder. Pin the extension and click its icon to open the side panel. This is an unpacked developer build, not a Chrome Web Store publication. For a new ZIP after editing, run `cd extension && zip -r ../dist/mezze-extension.zip .`.

The default Worker is `https://webagent.amos-donn.workers.dev`. Select a page, enter an objective, and start; Mezze writes a plan first and checks items off as it works. No accounts or sign-in. The extension requests Chrome site access as needed. Autopilot may pause when it meets an origin that has not been granted yet; select Continue to grant access. In review mode, check the proposed text, destination and screenshot marker before approving. With Autopilot on, actions run immediately and may be wrong; use it only when you accept that risk. A page can change after observation, and visual coordinates can be wrong; never approve an action without checking. If a click opens a new tab, select that tab before continuing. The agent does not automatically handle CAPTCHAs, authentication, payment details, downloads, or restricted pages.

## Interface

`panel.css` is a design system, not a pile of one-off rules. Colour, radius, shadow, focus and control-size tokens are declared once at the top and every component reads from them, in light and dark, following `prefers-color-scheme`. The scale is deliberately narrow — a 22 px brand mark, 28 px icon buttons, 32 px primary actions, 8–14 px radii, hairline borders, and a single emerald accent kept for state and focus — so the panel reads as a product surface instead of a form. The empty state offers three starting points, the composer is one lifted surface with its send button inside it, and nothing is fetched at runtime: system fonts and the vendored Phosphor geometry only.

## Configure your existing Worker and D1

1. `wrangler.jsonc` identifies your existing **webagent** D1 database and binds it as `DB`. Wrangler config is the deployment source of truth; verify the ID in Cloudflare Dashboard → D1 → webagent if your database changes.
2. Apply [migrations/0001_initial.sql](migrations/0001_initial.sql) to that database once using the D1 dashboard SQL console, or from an authenticated Wrangler installation run `npx wrangler d1 migrations apply webagent --remote`. This creates the `rate_limits` table. Do not apply this to a database you did not intend to modify.
3. In Worker → Settings → Variables and Secrets, add these **encrypted secrets**:
   - `GEMINI_API_KEY` — your Google AI Studio (Gemini API) key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey). Store it as a Worker secret, not in the extension.


   The Worker calls the Gemini API directly — `POST https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent` with `x-goog-api-key` — using a model chosen by the **Speed** setting in the panel: `gemini-3.5-flash-lite` for **Fast** (the default, about a second per decision), `gemini-3.6-flash` for **Balanced** and `gemini-3.8-flash` for **Careful**. Requests set `responseMimeType: "application/json"`, `temperature: 0`, and send the viewport screenshot as an `inlineData` image part. To change the model, add an ordinary (non-secret) variable `GEMINI_MODEL`: `gemini-4-argon` is the flagship reasoning model, `gemini-3.6-flash` the previous generation, `gemini-3.5-flash-lite` the cheapest. A leading `models/` prefix is accepted either way. The model must accept image input and JSON output; free-tier quotas are counted per project and per model.
4. In Workers Builds, use the repository root and deploy command `npx wrangler deploy`. The config sets `keep_vars` to preserve dashboard variables and secrets. Make sure the build has a supported Wrangler version and that `DB` is still bound to the intended database after deployment. Apply the migration before deploying this version. Your existing push-to-main build can deploy it once these changes are committed and pushed; this project does not push or deploy automatically on its own.
5. The Worker root — `https://webagent.amos-donn.workers.dev/` — serves a landing page (features, compatibility, install steps, no buttons). It is served before the D1 check, so a Worker with a missing binding still has a front door. Then open `https://webagent.amos-donn.workers.dev/health` to check that the Worker responds, then test a simple workflow in Chrome.

## Privacy and limitations

When you start or continue a workflow, visible page text (up to 40,000 characters, trimmed to 12,000 for the model), the viewport screenshot, labels and coordinates of visible interactive elements, the current URL, the objective, the plan, and previous actions are sent to your Worker and on to Google's Gemini API. Screenshots can contain sensitive information even when text is hidden. Do not use sensitive pages or enter secrets in objectives. Model output and website content are untrusted: prompt injection and incorrect actions are possible, confirmation is not a guarantee of safety, and with Autopilot on there is no per-action confirmation at all. Provider keys remain on the Worker. The D1 database stores only rate-limit counters; it does not store workflows. Your plan and its checkmarks live in Chrome extension local storage, are sent to the model with each step, and are cleared with **Clear** or replaced by the next task. There is no login, so anyone with your Worker URL can spend your Gemini quota: keep the URL private. Rate limits are basic and should not be treated as complete abuse protection. Deploy with appropriate access, monitoring, and quota controls before sharing publicly.

Whether Mezze should stay an extension is a separate question from what the agent can do: a Chromium of our own, an Electron shell, CEF and a local CDP driver are compared, with costs and the reasons a fork starts with an empty profile, in [docs/chromium-fork-plan.md](docs/chromium-fork-plan.md).

Provider references: [Gemini generateContent](https://ai.google.dev/api/generate-content), [Gemini models and IDs](https://ai.google.dev/gemini-api/docs/models), [Gemini rate limits](https://ai.google.dev/gemini-api/docs/rate-limits), [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/), [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).

## Chats, commands and approval modes

Every task is a chat. Chats are stored in Chrome extension storage (up to 20, newest first), survive closing the panel and reloading the browser, and can be reopened from the chats button. `Export .md` writes the current chat, its plan and its step log to Markdown, and `Delete all` clears them.

The message box understands two shortcuts: `/` opens commands (`/new`, `/chats`, `/export`, `/plan`, `/noplan`, `/auto-plan`, `/saw`, `/stop`) and `@` adds another open tab as context — it matches the tab's title, address or site name, searches every window, and the agent can then switch into that tab to work in it.

A checklist is optional: the planner returns no steps for short tasks, so a one-click job runs without one. Use `/plan` to force a checklist for every task or `/noplan` to skip it.

The message box is one tall field with the send button inside it, and nothing else stacked underneath. While a task runs, the send button is replaced by a large stop control in the same corner. There is no Continue button: the agent carries on to the next step by itself, and only a dead end stops the run and drops the task back into the box to resend. All panel icons are [Phosphor](https://phosphoricons.com) geometry vendored in `extension/icons.js`, so nothing is fetched from the network.

## Many tabs, one task

The agent drives one tab at a time, and it can move between them. Every open tab is listed to the model with a short id (`t1`, `t2`) and a marker for whether it is the acting tab, a read-only context tab, or a tab this run opened. Four actions use that list:

- **open** — `{"type":"open","url":"https://…"}` or `{"query":"standing desk prices"}` opens a new tab, activates it and acts there from the next round. It is how the agent researches a second site, reads a source, or visits a page the task needs next without navigating away from the page it is working in.
- **switch** — switches the acting tab to one to one from the list, so research in a new tab, then acting back in the original document, is one run rather than two chats.
- **gather** — reads one to five tabs in a single call and returns their text as the step result; the model then compares, cites or fills from all of them without switching per tab.
- **close** — closes a tab, and only one the run itself opened. The user's own tabs are never closed, and three new tabs is the ceiling for one task.

Tab ids stay stable for the whole run, so `t3` in round eight still means the tab it meant in round one. The tab strip above the message box shows the acting tab and the context tabs as pills; clicking the acting pill opens the full tab list, `@` in the message box attaches another tab, and the `×` on a context pill drops it. The tab list marks tabs the run opened with an `agent` badge.

## Reading the page before looking at it

A round is built from the DOM. Chrome's accessibility tree and the filtered element map are the ground truth: they name every control, they survive scrolling, they cost a few hundred tokens, and a click by `ref` lands on the node itself instead of on a pixel that a different zoom level would have moved. No screenshot is captured for a normal round: that removes a paint, an encode and a few hundred image tokens from the critical path, and a step no longer waits on the debugger twice for the same page.

Vision is the fallback, in two cases. The panel takes a screenshot when the tree is too thin to act on (fewer than six refs: a canvas app, a map, an image-only page), and when the model returns `{"needScreenshot":true}` after trying the tree first. Either way the round says why in the timeline, and the model is told the tree remains the source of truth — the image is for what the tree cannot describe, never a second opinion on every control.

The timeline follows the work in both tenses. While a step runs there is a muted line with a turning icon — `Clicking: the Tickets link`, `Waiting for the new tab to load` — and when the action comes back it becomes a past-tense entry with its duration and the page it touched: `Clicked`, `Opened a new page`, `Found 51 accessible elements`. A step that opened a tab carries a chip with that tab's title, so the page the agent made is one click away. When the run ends the report lands, the box empties and the placeholder goes back to `What do you want to do?`.

## Action standards

The prompt now spells out how to act, not just what to do. Every action follows a ladder — click by accessibility ref, then by coordinates, then keyboard focus plus Enter/Space, then the site's own shortcut or the URL — and the model is told to move down a rung rather than repeat a call. Each typed error has a prescribed next move (`STALE_REF` → re-read the page, `NOT_ACTIONABLE` → scroll or reveal it or use the keyboard, `NO_EFFECT` → dismiss the overlay or use the label's parent, `PAGE_CHANGED` → observe again, `BLOCKED_ACTION` → report and work elsewhere), and two failures on one control force a change of route. Scrolling covers nested and keyboard-driven containers and when to stop; typing covers one value vs several fields vs a rich editor, when to set `submit`, and what to do when a field ignores an insert. The rules duplicate the element map, the error codes and the goal instructions on purpose — they are what the model reads at the decision point.

## Seeing where it clicks

The real pointer never moves — clicks go out as CDP input events — so the agent draws its own. With **Show pointer** on in Settings (the default), the cursor glides in from the nearer edge of the window the first time it appears, then slides from the previous click to every `click`, `type`, `fill` and `write` target, and ripples where the click lands; the purple write box then takes over the field as before. The cursor is a shadow-DOM overlay with `pointer-events: none`, holds no text and animates with the Web Animations API, so it can neither intercept a click nor leak into the page text. It stays on screen while the agent takes its screenshots — hiding it for every capture made it blink — and its host node is excluded from the page fingerprint, so an overlay can never make an action look *verified* that was not. `prefers-reduced-motion` keeps the travel but shortens it to roughly 100 ms, and a page that blocks script injection says so in the panel instead of failing silently. Turn it off in Settings to run without it.

## Generated writing

When a field or document needs prose the model can write itself — *improve this doc*, *write a summary*, *fill the description* — it does not type it key by key. It sends a `write` action with a short brief, and the panel asks the Worker's `/write` endpoint, which streams Gemini's reply back as server-sent events and inserts it into the field in small chunks as it arrives. While that happens a **purple outline with a skeleton loader and a “Gemini is writing…” chip** is drawn over the target, so it is obvious which field is being filled; the chip turns into a character count once text starts landing. `replace: true` selects the existing content first, so "improve this doc" rewrites rather than appends, and the page's own undo history still works because the text goes in as real edits. The page text and the field's current content are sent as context, spotlighted as untrusted.

## The final check and the report

When the model says the task is done, the run does not end there. The panel re-reads the tab and posts the whole run to `/review`: the goal, the closing claim, the plan, every step, and a fresh screenshot plus page text. A separate model call then judges the **page**, not the claim — did the text it was supposed to read actually appear, is the field really filled, does the Google Doc it edited show the new content — and answers with `passed`, `partial` or `failed`.

If the check finds missing work that a browser action could still fix, that verdict is fed back as a correction and the agent goes back to the page, up to two extra rounds. When it finishes either way, the run ends with the agent saying how it went, in its own voice: two to four sentences on whether it worked and what you should know ("I filled the form in and it went through; the confirmation page shows order #1234"), then only what is still open, each line written the same way. There is no "here is what the agent did" list — the timeline above already records every step, so a second list of them would just be redundant. A check that cannot run (rate limit, offline) is reported as unverified rather than pretending to pass, and unchecked plan items are listed under *Could not do*. The report is part of the chat, so it survives reloads and is included in `Export .md`.

**Approval is a setting, and it survives a reload.** *Run without asking* (the default) lets every round act and tells you what it did; a step that looks irreversible — paying, deleting, sending, submitting, sharing, uploading, or typing password/card-like text — is matched against the goal and announced in the timeline rather than going ahead silently. *Ask only before risky steps* stops before exactly those, and *Ask before every round* stops before everything. Change it in Settings, or with `/approval auto`, `/approval risky` and `/approval ask`; `/approval` on its own tells you where it is set. It is stored with your other settings, because plan mode was remembered and this was not, and two adjacent settings that disagree read as unreliability rather than as a choice.

When the panel does stop, the card says which posture stopped it, and *Do not ask again in this task* runs the rest of **this** task without asking without changing what the next one starts from. The eye button shows the exact screenshot the last decision was made from. No tab group is created for the acting tab: the star marks it, and tabs the agent navigates gather in the green group described below.

## Speed

Three settings decide how long a round takes, and all three are in **Settings**:

- **Speed.** *Fast* (the default) asks `gemini-3.5-flash-lite`, uses short pauses between actions, and sends a smaller observation — 50 refs, 14,000 characters of page text, 4,000 per attached tab. *Balanced* uses `gemini-3.6-flash` with a medium observation. *Careful* is the old behaviour: `gemini-3.8-flash` with the full 220 refs and the whole page, which thinks for several seconds per decision.
- **Wait for slow pages before deciding.** Off by default, so a click gets 0.8 s to change the page and the run moves on. On, an action waits until the page stops mutating, up to four seconds — worth it on sites whose menus open late, at the cost of time on a page that does nothing.
- **Stay on my tab.** On by default. The agent keeps driving its tab without making it the visible one, so you can read another tab while a run continues. Turn it off to watch every action, at the cost of being switched back on each round.
- **Show pointer** and **Local bridge**, unchanged.

The setting applies from the next action; a run already in flight keeps the speed it started with until the next round. A model that errors falls back to the next one down the chain rather than ending the run, and `GEMINI_MODEL`, when set, overrides the speed setting entirely.

## The topbar, Settings, and continuing a chat

The topbar badge is the current chat's title, not a fixed product label — click it to open the chat list — and a small accent dot appears while a run is live. **Escape** stops a running workflow and **Cmd/Ctrl+K** jumps to the task box; dialogs keep Escape for themselves.

Settings covers the worker URL with a **Test connection** button that asks `GET /health` and names the model actually answering, the speed preset, whether to wait for slow pages, whether to stay on your tab, a **Checklist** control for the plan mode that used to be reachable only through `/plan`, `/noplan` and `/auto-plan`, and the list of saved skills with a delete button (they used to be write-only).

A second message in the same chat is a continuation, not a fresh start: the panel sends the last ten turns plus a digest of everything already completed in the chat (up to forty steps, accumulated across runs, not just the last one) to both `/plan` and `/agent`, and the Worker clips them into an `EARLIER IN THIS CHAT` block above the current goal. So "do the same for the second one" has a referent, and the model does not repeat what it already finished. The current goal still outranks the history; the history is context, never a new instruction.

A run can be paused between rounds rather than only stopped. The pause button in the composer freezes the run with its checklist and evidence intact, so a login wall or a 2FA code can be handled by hand, and Continue resumes the same run instead of starting a new one.

Chats are capped at twenty and the oldest is dropped only with a visible warning — each row in the chat list also has its own delete button — and a storage write that fails now says so instead of leaving the chat silently unsaved. The chat list's delete button refuses while a run is working in that chat.

The **Test connection** button reports three things separately: whether the Worker answers at all, which model will answer, and whether its D1 binding is present. A Worker with a right URL and key but no `DB` binding would otherwise only fail on the first real task, with a 503.

## Macros: record once, replay without the model

The stopwatch button's neighbour in the topbar is the macro recorder (`/record`, `/macros`). Press **Record in this tab**, do the job by hand once, then press **Save macro**. What is recorded is the *meaning* of each action — a click, the final value of each field, a chosen option, Enter, a navigation — not pixels and not keystrokes: typing into one field is one step, and the step list reads like the task (`1. Open example.com`, `2. Type “ada@example.com” into Email`, `3. Click Sign in`). Steps can be dropped while recording, and the name is editable before saving.

Each step stores several ways to find its control — a test id, a role and accessible name, a label, a field name, a stable id, its text, and only then a short CSS path — and replay walks that list in that order. The candidates are counted at record time, so a macro that clicked the second "Save" still clicks the second "Save". That is Selenium IDE's fallback-list idea rather than Chrome's single best selector, and it is the difference between a macro that survives a redesign and one that does not.

Replay does not call Gemini. The panel sends each recorded target through the agent's own action path (`target` instead of `ref` or coordinates), so it gets real CDP input, the green dot, the settle window, the effect check and the scripted-click fallback — a macro is the agent's hands with a recorded intention, not a second automation engine. A step waits for its control (up to six seconds) rather than sleeping, and `<select>` is set through `input`/`change` so native dropdowns work without an OS-level menu.

When a step cannot find its target, the macro stops, says which step failed, and puts a repair prompt in the message box — the macro name, the failure and the remaining steps. Send it, and the agent finishes the job from the page it is on. **Passwords and card numbers are never stored**: a credential-looking field (password type, `autocomplete=current-password`/`new-password`/`one-time-code`/`cc-*`, or a name that says so) is recorded as a step with no value, and replay clicks it, pauses, and waits for you to type it. Recording covers the top frame only — a login widget inside a cross-origin iframe is not captured — and stops on `chrome://` pages, the Web Store and the PDF viewer, which Chrome does not allow extensions to script.

Recording follows you across tabs. If the task continues in another tab — a link that opens one, or a tab you switch to yourself — recording keeps going and stores a **switch** step naming that page, because the replay has to go there too. A tab you look at but never touch records nothing. On replay the switch step looks for an open tab on that address (the fragment is ignored, the query string is not) and opens one only if the tab has been closed, so a macro can span a mailbox, a spreadsheet and a dashboard, and still run after a browser restart. When two tabs show the same page, the one in the window you are working in wins. Replay moves the agent's own working tab, so the pointer and the step log follow it.

**Keystrokes are steps only when repeating them does the same thing.** Enter in a field is recorded, because it submits the form; Escape is recorded, because it closes a dialog; and so are Ctrl/Cmd + A, C, V, X, Z and Y when the page rather than a field has focus. Pressing Ctrl+V *inside* a field is deliberately not a step — the pasted text is already that field's recorded value, and replaying the paste would insert whatever happens to be on the clipboard at that moment. The same reasoning covers Ctrl+A-then-type, Ctrl+X and Ctrl+Z in a field: the value after them is what gets stored. Tab, the arrow keys, Home/End and PageUp/PageDown are not recorded at all, since the next step names its own element and a recorded target is scrolled into view before it is used. A macro recorded on a Mac stores and shows Cmd; on Windows and Linux, Ctrl.

## The vault: memory, reports, and files you upload

Every install has a small filesystem of its own — no folder picker, no permission prompt, nothing to
configure. The agent keeps notes in `memory/` (one file per topic, with `memory.md` as the index), writes
`plans/`, `reports/` and `drafts/` as it works, drops what it collected in `data/`, and leaves the step
log of a run in `runs/`. Files you upload land in `uploads/` untouched, and transcripts you keep go in
`transcripts/`.

Open it with `/files`: browse the folders, preview or download anything, upload with the button or by
dropping files onto the dialog, and see how much space the vault is using. `/save` puts the last
transcript in `transcripts/`.

It is the Origin Private File System, which Chrome already gives extensions, and `unlimitedStorage` (in
the manifest from the first version) exempts it from the storage quota and from eviction. Nothing in it
leaves the machine unless a step explicitly sends it to the Worker, and clearing browsing data does not
clear it — uninstalling does. Text files cap at 25 MB per upload and 2 MB per written note.

## Transcribing a video's audio

`/transcribe` reads the audio of the `<video>` or `<audio>` element on the page you are on, sends it to Gemini in ten-second slices, and puts the transcript in the chat and in a `.txt` download. Nothing is fetched from the site and no media file is stored: the element's own track is captured with `captureStream` while it plays, which is the only path that works for a player that streams through MediaSource and never exposes a file. The agent can do this itself, so "what did they say in this talk" works as a normal goal: it gets a `transcribe` action that returns the transcript as the step result, and it is told to use it rather than answer from a video's title or description. Ask it, or press `/transcribe` yourself — both run the same capture.

That is also its cost, and it is worth being plain about. Transcription takes **as long as the video runs**, because the audio only exists while it is being played; the panel has to stay open and the tab has to keep playing, since pausing the video pauses the audio (a paused player is not sent as silence). Each ten-second slice is 16 kHz mono WAV — about 320 KB — encoded to roughly 430 KB of base64 and sent to the Worker as one request, so a long video is a series of small calls rather than one large upload. Slices are transcribed in order and joined, which is why a word split across a slice boundary can come back as two.

The command refuses, with a reason rather than a silent empty transcript, on a protected (DRM) video, a page with no media, a player that exposes no audio track, and a `chrome://` page. Speech is transcribed verbatim in whatever language it is spoken, `[unclear]` marks a word the model could not resolve, and a slice with no speech is not sent at all.

## Script mode: the transcript, in sync, floating over the page

`/script` opens a transcript island on the page — draggable, resizable, in the page rather than in the panel. Transcription opens it by itself, and lines appear as each ten-second slice comes back, so the text is readable while the video is still playing.

Every line carries the media time its slice covered, read from the element's `currentTime` at both ends of the slice rather than counted from the capture. That is what keeps the highlight honest when the video is paused, seeked, or played at another speed: the lit line is the one covering the current time, a gap between lines keeps the previous one lit, and clicking a line seeks to it. The island carries play/pause, ±5 seconds, 0.5×–2× speed, and a fullscreen button, because a transcript you cannot rewind is not much use. It lives in a shadow root, so no page stylesheet can restyle or hide it, and the last transcript per tab is kept for the session, which is what `/script` shows when nothing is being transcribed. Its ⧉ button hands the same panel to a real Picture-in-Picture window (Chrome 116+), so it floats above other applications rather than over the page; closing that window, or pressing ⧉ again, puts it back in the tab with its lines and highlight intact. The button is hidden where the browser has no document Picture-in-Picture.

## Schedules, menus, shortcuts, and notifications

**Recurring runs.** `/every 60 check my inbox` schedules a task; `/schedules` lists them with their next
run and how many times each has run, and `/schedules off <id>` (or `off all`) cancels. A `chrome.alarms`
tick every minute checks what is due, books the next slot before starting — so a hanging run cannot make a
task fire repeatedly — and opens the panel in a background tab with the task loaded. That tab runs exactly
one task, posts a notification when it finishes, and closes itself. This is how a scheduled task works with
the side panel shut: the tab is the driver, not the panel.

**Entry points.** `Alt+Shift+M` opens the panel, `Alt+Shift+S` asks about the selection (or about the page
when nothing is selected), `Alt+Shift+P` summarises the page. Right-clicking gives *Ask Mezze about this
selection*, *Look at this page with Mezze*, and *Use this page in my Mezze task*. Whatever a menu item or
shortcut produces is left in the composer rather than sent, so you can see it before it runs.

**Notifications.** A run that ends while the panel is hidden posts a desktop notification with the first
line of the result. Nothing is announced while you are watching, because you can already see it.

**Tab groups.** Tabs the agent navigates are gathered into one green group called *Mezze*, so you can see
the tabs a run has touched and close them in one move.

**The cursor.** A rounded green dot with a soft halo follows the agent's clicks — no arrow, no tail, because
an arrow implies a mouse you are holding. It glides to the target and ripples where the click lands, and
never intercepts a click itself.

**Languages.** The extension's name, description, menu items and toolbar title are translatable
(`_locales/en`, `_locales/zh_CN`). The panel's own interface is still English.

## Commands, skills, and what follows them

Typing works as well as picking from the list. A slash token resolves as you type — the chip shows the command it matched and what it does, a prefix is enough when it is unambiguous (`/tr` is `/transcribe`), and an unmatched token gets a dashed chip that says it will be sent as text.

Everything else in the message is context for what happens next. `/tr summarise the third point` transcribes the page and then starts the agent with "summarise the third point" as its goal, the transcript already in the chat for it to read. The same rule covers every command and every skill, so `/weekly-report focus on last month` runs that skill with your words as the goal: the skill supplies the method and you supply the specifics. If the command is still running when you send it — a transcription, a recording — the instruction is left in the box rather than fired at the wrong moment, and chips are clickable to run with the rest of the message as the goal.

## What a round costs

The hourglass button in the topbar (and `/timings`) opens the speed panel: how long whole tasks take, then what the last 60 rounds actually spent, as medians with a stacked bar and the last rounds listed, exportable as `mezze-timings.json`.

Both levels are recorded, because they answer different questions. A **task** record is written once per run — wall clock from the moment you send to the moment the report appears, so it includes the pauses while you approve a step and the settle windows, which is the wait you actually sit through — with its round count and the summed read/model/act underneath. A **round** record covers one decision. Each decision prints a faint line in the timeline under the steps it paid for — `1.24s · read 380ms · model 700ms · act 160ms` — and the end of a run prints `task 1m 12s · 9 rounds · model 4.1s · read 12s · act 38s`. Every step card carries its own duration. What is measured:

- **read** — the observation round trip, including a second read when a screenshot had to be taken
- **model** — the Worker's own timing of the Gemini call, including its internal correction retry
- **network** — the round trip minus the model, so Worker overhead and transport are visible
- **act** — the CDP action and its effect check, settle window included
- **payload** — the exact byte count of the JSON sent to `/agent`, plus whether the round carried a screenshot and the Worker's prompt/completion token counts

One round record is written per decision and one task record per run, capped at 400 together in extension storage, and the first round of a run reports `read` as unknown rather than zero because its observation is taken alongside the planner. This is the baseline the System 1 question in [docs/jev-pivot-report.md](docs/jev-pivot-report.md) depends on: replacing a model call only shortens a round by the model's share of it, and until these numbers exist that share is a guess.

## Accessibility refs, safety boundary, skills, evals and the MCP bridge

**Grounding.** Every observation now includes an accessibility-tree snapshot (`Accessibility.getFullAXTree`) exposed as refs (`e12`). Actions may target `{"ref":"e12"}` instead of coordinates, which works off-screen and inside shadow roots; refs are stored per tab in session storage and expire with the page. A `fill` action sets up to 12 fields in one call.

**Context.** The screenshot is only attached when the tree is thin (fewer than 15 refs) or when the model asks with `{"needScreenshot":true}`, and each reply may carry a three-field `memory` that is fed back on the next round.

**Permissions.** Site access is one optional grant covering `https://*/*` and `http://*/*`, requested on the first task and remembered by Chrome from then on — the agent no longer asks again for each new website. Reloading or updating the unpacked extension keeps the same extension ID, so the grant survives reloads too; to revoke it, open `chrome://extensions` → Details → Site access. Separately, Chrome shows a "started debugging this browser" bar while the agent holds the debugger — that is Chrome's own notice for the `debugger` permission, not a request, and it disappears when the task stops.

**Safety.** Page text is wrapped in random `<<SNAP-…>>` delimiters, instruction-looking lines are removed before the model sees them, CSS-hidden text is dropped at extraction, cross-origin navigation extends the task's sites instead of stopping it, and consequential labels (`delete`, `pay`, `send`, …) are matched against the **intent** of your goal, the plan and the chat — not its exact wording — so "clean up my inbox" covers a Delete button. A matching step runs with a notice; only spending money or closing an account is refused (`BLOCKED_ACTION`) when autopilot runs unattended and the goal implies neither. Password fields are always blocked.

**Keyboard.** Keys are sent as real key events, so the agent can use what a person would: `/` or `s` to focus a site's search, `Escape` to close a dialog, `Tab`/`Shift+Tab`, `Space`/`Shift+Space`, `Home`/`End`, `PageUp`/`PageDown`, arrow keys, plus any printable character and chords like `Control+K`, `Shift+Tab` or `Meta+Enter`. When a nested scroller ignores programmatic scrolling, `scroll` falls back to the Space bar.

**Typed errors.** Failures return codes (`STALE_REF`, `NOT_ACTIONABLE`, `BLOCKED_ACTION`, `PAGE_CHANGED`, `NO_EFFECT`, `PASSWORD_FIELD`) which appear in the timeline and in the model's history. A failed step is feedback, not an ending: the run re-reads the page and tries another route (up to three consecutive retries) instead of handing control back after one obstacle.

**Rate limits.** When Gemini answers with a usage limit — a per-minute call cap, not a bad key — the run does not end. The loading card counts down thirty seconds (*Usage limit — restarting in 26s*) and the same round is retried by itself, up to six times in a row before the limit is reported as a stop. The wait does not consume the ordinary retries, and a rate-limited `write` or click waits the same way before it looks at the page again.

**Skills.** `/skill` distils the current run into a named, parameterised skill (secrets listed as parameters, values never stored) and `/` lists saved skills to replay. One skill ships built in: **Summarize with Gemini**. On a Google page — Docs, Drive, Sheets, Slides, Gmail or Search — a purple pill appears inside the message box, and typing anything with *summarize*, *tl;dr*, *key points* or *recap* in it attaches the skill automatically, so "summarize this" needs no setup. The skill tells the agent to read the page, answer with its `done` summary and leave the document untouched; the result lands in the chat report.

**Evals.** `node evals/run.mjs --validate` checks the 30-task rubric suite; grading exported chats gives pass@3.

**MCP bridge.** Enable **Local bridge** in Settings, run `node bridge/server.mjs`, then point any MCP client at `node mcp/server.mjs` to drive the tab with `browser_observe`, `browser_click`, `browser_type`, `browser_fill`, `browser_key`, `browser_scroll`, `browser_navigate`, `browser_read` and `browser_screenshot`. The bridge binds loopback only and rejects requests carrying a web Origin. Neither piece needs an account or a key.
