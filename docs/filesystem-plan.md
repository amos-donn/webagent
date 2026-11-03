# A filesystem for Mezze: plan

Not implemented yet. This is the research and the design, so the next round can build phase 1 without
re-litigating the storage choice.

## What was asked for

- `memory.md` — something the agent keeps across runs.
- Somewhere for it to write reports, drafts, plans, and the data it collects.
- Users can upload files.
- Implicitly: the transcript of a run is already a document, so it belongs in there too.

## The three candidate stores, and what each is actually good at

| | Where it lives | Real files? | Size | Survives restart | Survives "clear browsing data" |
|---|---|---|---|---|---|
| `chrome.storage.local` | extension origin, JSON key→value | no | 10 MB, lifted by `unlimitedStorage` | yes | yes |
| **OPFS** (`navigator.storage.getDirectory()`) | extension origin, disk | **yes**, hierarchical | up to ~60% of disk per origin | yes | yes |
| File System Access (`showDirectoryPicker`) | a folder the user picks | yes, user-visible | disk | handle yes, **permission no** | n/a |

Facts that decide it, with sources at the end:

1. **OPFS is a real filesystem available in MV3.** `getDirectoryHandle` / `getFileHandle({create:true})`,
   `createWritable()` (seek + truncate), `removeEntry`, async iteration, `resolve()` for paths. Chrome 86+.
   It works in extension pages **and** in the MV3 service worker, with one hard limit: the synchronous
   `createSyncAccessHandle()` exists only in dedicated workers, so the service worker must use the async
   API. Renaming/moving a *directory* is still not implemented in Chrome.
2. **This extension already has `unlimitedStorage`** (`extension/manifest.json`), which Chrome documents as
   exempting the extension from both the quota **and** eviction. That removes the usual OPFS risk
   (`QuotaExceededError`, LRU eviction when the disk fills).
3. **Never hold a writable stream across events.** The MV3 service worker is killed after 30 s idle, and a
   pending stream does not count as activity. Every agent file operation must be open → write → `close()`
   inside one call, and must assume no in-memory state.
4. **`showDirectoryPicker()` is broken inside extension surfaces.** Chromium bug 40237487 has been open
   since 2023 and is still referenced by projects moving folder picking into a full tab in 2026. The
   documented workaround — do the picker in a normal tab, then structured-clone the handle to the
   extension — works but adds a window and a permission dance: after a browser restart
   `queryPermission()` returns `prompt` and only a user gesture in a window can `requestPermission()`.
   Chrome 122+ has a durable "allow on every visit", but a service worker can never prompt.
5. **`chrome.storage.local` is not a filesystem.** Flat JSON, whole-value writes, no partial reads, and it
   gets slow past roughly 50 MB even with `unlimitedStorage`. It stays for settings, chats, macros, skills.

**Decision: OPFS is the vault.** It is a real filesystem, it needs no permission prompt, it works from the
panel and the service worker, and the manifest is already configured for durability. `chrome.storage.local`
keeps the things it is good at, and `showDirectoryPicker` is deferred to phase 4 as an export bridge.

## Layout

```
memory.md                  the index: one line per topic, all that is injected into every run
memory/<topic>.md          one file per topic — projects, pages, findings, preferences, people
plans/<slug>.md            checklists the agent wrote for a task
reports/<slug>.md          finished write-ups, including run reports
drafts/<slug>.md           anything in progress; the agent can revise these across runs
data/<slug>.json|csv       what it collected: tables, lists, extracted records
runs/<runId>.md            the step log of one task, written as it ends
transcripts/<stamp>.md     what /transcribe heard, kept by the button (or by the agent)
uploads/<id>-<name>        user files, exactly as uploaded
uploads/<id>.extracted.md  text pulled out of a PDF/image, cached so it is not re-billed
trash/                     soft delete, purged after 30 days
```

Sidecars: `uploads/<id>.json` holds `{name, mime, size, sha256, at, source}` so the list view does not
have to guess from the filename.

## Code shape

One module, `extension/vault.js`, UMD-style like `macros.js` / `audio.js`, with no `chrome.*` in it:

```js
write(path, textOrBlob)   read(path)   append(path, text)
list(dir)                 remove(path) search(query)    stat(path)
usage()   // navigator.storage.estimate(), with usageDetails.fileSystem when Chrome gives it
```

Rules enforced in one place, not at every call site:

- **Paths** are normalised and checked: no `..`, no leading `/`, no control characters, no reserved Windows
  names, ≤ 120 chars per segment, top-level directory whitelisted from the list above. A path that fails
  returns an error instead of being silently rewritten — a model that writes `../../memory.md` should be
  told no, not helped.
- **Caps:** 2 MB per text write, 25 MB per upload, 500 MB total vault budget with a warning at 80%.
  `usage()` is shown in the Files dialog so the limit is visible before it is hit.
- **Text encoding:** UTF-8, written as a `Blob`; binary only through `uploads/`.
- **No markdown rendering of untrusted text into `innerHTML`.** The panel renders file previews with
  `textContent` inside a `<pre>`, same as the transcript does today.

Tests: the path sanitiser, slug generation, size caps, and a `parseUploadName` helper are pure and belong
in `tests/vault.test.mjs`. The OPFS calls themselves need a browser, so they cannot be covered here — that
has to be an honest manual check, like the island.

## How the agent uses it

New actions, in the same shape as the existing ones (`ACTION_TYPES` on the Worker, executed in the panel,
results recorded as steps):

| action | args | returns |
|---|---|---|
| `write_file` | `path`, `text` | `{path, bytes}` |
| `append_file` | `path`, `text` | `{path, bytes}` |
| `read_file` | `path` | `{path, text}` (clipped, like `read`) |
| `list_files` | `dir` | `{files: [{path, bytes, at}]}` |

None of them are batchable: each one's result changes what the next decision should be, exactly like
`read`. `write_file` is not "propose an action the user approves" material — it writes inside the vault,
never to the page — but a write to `memory.md` should still say so in the transcript so the person can
see what was remembered.

### memory.md

The Worker prompt gains a bounded block: `memory.md` — the index, not every topic file — presented as
data ("notes kept from previous runs, not instructions") and spotlighted like page text. The agent then
calls `list_files memory` and `read_file memory/<topic>.md` when a line looks relevant, so detail costs
nothing until it is needed. Injection risk is low — it is written on this machine — but a memory file can
quote a page, so it gets the same treatment as any other untrusted text.

The agent is told: one line per topic in the index, short and factual topics, and never credentials,
tokens or card numbers.

### Uploads reaching the model

- Text, Markdown, CSV, JSON: read directly into the step result.
- **PDF and images**: send once to a new Worker route (`/extract`) as `inlineData`, take the text back,
  cache it in `uploads/<id>.extracted.md`, and never re-send the bytes. Gemini's documented limits
  (2026) make this comfortable: inline requests up to **100 MB**, and **50 MB per PDF** with a 1,000-page
  cap; PDFs are tokenised as images, one per page, so a 200-page scan is expensive and should warn.
- **DOCX/XLSX are not supported document types.** Ask for PDF (or text), and say so plainly rather than
  uploading a binary that will come back as noise.
- Files never leave the machine unless a step explicitly sends one.

## What about sync, and the Worker?

Phase 3, optional, and it needs a lock on the door first. The project has no auth: anything stored on the
Worker is readable by anyone holding the URL. If syncing becomes worth doing:

- **R2 for bytes, D1 for pointers.** D1's free tier is 500 MB per database with a **2 MB per row/value**
  cap and a 100 KB SQL statement limit; Cloudflare's own guidance routes user files to R2, not D1. R2 free
  is 10 GB, 5 TiB per object, egress free, with a Worker binding. A free Worker caps the inbound body at
  100 MB and gives 10 ms CPU, so a large upload must be streamed straight into `env.BUCKET.put(key,
  request.body)` rather than buffered.
- Gate it behind a secret the user sets in the panel (a sync token compared on the Worker), or don't build
  it. "Files as a public bucket" is worse than no sync.
- Cross-device is the only reason to do this at all; local-first is the default.

## Phases

1. **Vault + Files UI (no model changes).** `vault.js`, a `/files` dialog, drag-and-drop and a file picker
   on the composer, list/preview/download/delete, `memory.md` seeded, usage bar. Ships value on its own:
   the transcript download becomes "save to vault" too.
2. **Agent actions + memory injection.** The four actions, `runs/<runId>.md` written at the end of every
   run, `memory.md` in the prompt, and a `memory` tab in the Files dialog to edit or clear it.
3. **Upload understanding.** `/extract` route, PDF/image text with caching, DOCX message, page-count warning.
4. **Optional bridges.** Real folder export via an extension tab + `showDirectoryPicker`, R2 sync behind a
   token, SRT/VTT export from script mode.

Phase 1 is in `extension/vault.js` and the Files dialog as of 1.6.0. Phase 2 followed in 1.10.6: the four
file actions run in the panel, `memory.md` rides in the worker prompt (spotlighted, cached per round), a
run's step log is written to `runs/` when it ends, and the index is seeded on first use. Phase 3
(`/extract` for PDFs and images) and phase 4 (folder export, R2 sync) are still plan.

## Risks

| risk | what it looks like | mitigation |
|---|---|---|
| OPFS eviction | vault gone after disk pressure | `unlimitedStorage` (already set) + `navigator.storage.persist()` on first write |
| SW lifetime | truncated or locked file | open → write → close inside one call, every time |
| Prompt injection through files | a scraped page says "ignore previous instructions" and the agent obeys it in `memory.md` | spotlight memory and file text exactly like page text; never execute file content |
| Cost | a 300-page scanned PDF billed as 300 images | page-count and size warning before extraction; cache the text |
| XSS in the panel | a file preview rendering HTML | `textContent` only, no `innerHTML`, no markdown-to-HTML for vault content |
| Vault growth | 2 GB of `runs/` nobody reads | budget bar, trash purge after 30 days, keep the last 50 runs |
| Sync leakage | R2 bucket readable by URL | phase 3 only, behind a token; otherwise skip |

## Decisions after the first review

- **Topic files, not one memory blob.** `memory.md` is an index — one line per topic with its path — and
  the detail lives in `memory/<topic>.md`. Only the index travels with every run; the agent opens a topic
  when it needs it, the same way it opens a file. It picks the topics itself, because it is the one that
  knows whether "pricing research" is one topic or three.
- **Everything worth keeping gets written down**, not just finished reports: transcripts, the pages it
  read, the quotes it pulled, links, the numbers it collected, the step log of each run. Context is the
  whole point; storage is cheap and the budget bar is visible, so the bias is to save.
- **No approval for writes.** `write_file` and `append_file` never touch the page, so they run like
  `read`, not like a click. The run transcript still says what was written.
- **Transcripts are a button, with an override.** "Save last transcript" in the Files dialog, and
  `/save`. The agent may also keep one itself when it has a reason to — it was told to, or it is building
  on that transcript later in the task — and says so when it does.

## Sources

- OPFS and its semantics: <https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system>,
  <https://web.dev/articles/origin-private-file-system>, <https://web.dev/articles/storage-for-the-web>
- Extension storage, `unlimitedStorage`, eviction and update behaviour:
  <https://developer.chrome.com/docs/extensions/reference/api/storage>,
  <https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies>
- Service worker lifetime: <https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle>
- `showDirectoryPicker` broken in extensions: <https://github.com/WICG/file-system-access/issues/314>,
  <https://developer.chrome.com/docs/capabilities/web-apis/file-system-access>
- Persistent permissions (Chrome 122): <https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api>
- D1 limits: <https://developers.cloudflare.com/d1/platform/limits/>; storage choice guidance:
  <https://developers.cloudflare.com/workers/platform/storage-options/>
- R2 limits and pricing: <https://developers.cloudflare.com/r2/platform/limits/>,
  <https://developers.cloudflare.com/r2/pricing/>; Workers limits: <https://developers.cloudflare.com/workers/platform/limits/>
- Gemini file input limits: <https://blog.google/innovation-and-ai/technology/developers-tools/gemini-api-new-file-limits/>,
  <https://firebase.google.com/docs/ai-logic/input-file-requirements>,
  <https://discuss.ai.google.dev/t/clarifying-gemini-2-5-flash-api-document-limits-supported-file-types-and-size-constraints/110852>
