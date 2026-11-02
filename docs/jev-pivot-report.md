# Pivot report: Jev as Mezze's System 1

**Question:** what would it actually take for Mezze to let Jev make the action decisions, and does the System 1 / System 2 pitch survive contact with this codebase?

Researched 2 November 2026. Sources are listed at the end; every product claim below is the vendor's, not a measurement of ours. Nothing here has been benchmarked against our own rounds yet.

## 1. What Jev is, precisely

Jev is TypeSafe AI's first "System One" model, released 15 September 2026. It is not an LLM with a JSON mode. It does not generate text at all: you send a **state** and a map of **typed questions**, and it returns a map of **typed answers** in one response.

- Endpoint: `POST https://api.typesafe.ai/v1/systemone`, bearer `TYPESAFE_API_KEY`. There are JavaScript and Python SDKs (`TypeSafeClient`, `langchain-typesafe`); the Worker would use `fetch` against the same endpoint.
- Model field: `jev-latest` (currently `jev-1.14.0`), or a pinned version id. Responses echo the versioned id that answered, which matters if we ever tune a threshold.
- Three question primitives:
  - **Choice** — pick one of a fixed set. Returns `choice`, a `probabilities` distribution over every option, and `confidence` derived from how peaked that distribution is. Maximum **255 options** per question.
  - **Score** — rate the state on ordered levels; returns a continuous score, distribution and confidence.
  - **Noul** — a yes/no statement; returns one number from 0 to 1.
- All questions in a request are evaluated in parallel and in isolation against the same state. Adding questions barely changes latency; they only cost input tokens.
- Price: **$0.042 per million input tokens**, output free. Context: 64k per request / 32k per question by default (262k with a long-context header). Rate limits are per organisation, tokens/sec and requests/sec, `429` above them.
- Input is **text only** — string, JSON object or array of strings. No images, no audio, no video.
- Latency: the vendor quotes **70–500 ms** end to end per request, from their own laptops on the US west coast, and claims 40x–200x faster / ~400x cheaper than LLMs on "System One shaped" tasks. Their published speedups come from a benchmark of curated decision workflows, not browser automation.

Two structural consequences follow immediately and shape everything else:

1. **Jev cannot write a string.** Every action in Mezze that carries prose — `type` a search query, fill a description, `write` a paragraph — needs the text from somewhere else. Jev can *choose* which of several candidate strings, but it can never compose one.
2. **Jev cannot see.** A canvas app, a CAPTCHA-adjacent visual puzzle, or an image-only page is outside its input space entirely. Vision stays on the LLM.

## 2. What our loop looks like today

One round, per `extension/panel.js` and `worker/index.js`:

```
observe (DOM + AX tree, screenshot only when the tree is thin or asked for)
  → POST /agent  (Gemini, JSON: thought, plan ticks, 1-4 actions, memory)
  → execute each action via CDP, verify effect against the page fingerprint
  → feed typed errors (STALE_REF, NO_EFFECT, PAGE_CHANGED…) into the next round
```

The model call is one step in a chain that also contains a page read, a debugger attach, an action, an effect check, and — on slow sites — a settle window. That matters for the pitch: **Jev can only shorten the middle of the loop.** If a round is dominated by observation and settle waits, replacing a 1 s Gemini call with a 200 ms Jev call does not produce a sub-200 ms round. That is the single most important thing to measure before repeating the "sub-200 ms loop" claim.

## 3. Mapping Jev's primitives onto our action vocabulary

Our actions: `click` (by `ref`, else x/y), `type`, `fill`, `key`, `scroll`, `open`, `switch`, `gather`, `close`, `wait`, `write`, `done`. A Jev round can ask several questions at once, and the code decides what to do with the answers:

| Question id | Type | Options / statement | What the code does with it |
|---|---|---|---|
| `next` | Choice | `click`, `type`, `key`, `scroll`, `open`, `switch`, `gather`, `close`, `wait`, `write`, `done`, `escalate` | Top-level action kind |
| `target` | Choice | The accessible refs of the filtered element map (see §4 for the 255 limit) | Which control the action lands on |
| `scroll_direction` | Choice | `down`, `up`, `top`, `bottom`, `element` | Parameter for `scroll` |
| `key` | Choice | The site's own shortcuts plus the generic set (`Enter`, `Escape`, `Tab`, `/`, …) | Parameter for `key` |
| `tab` | Choice | Stable tab tokens `t1…tn` | Parameter for `switch` / `gather` |
| `needs_system_2` | Noul | "This state cannot be resolved from the goal and the plan alone" | Gate to Gemini |
| `on_track` | Noul | "The last action moved the page toward the goal" | Early stop on a loop |
| `action_is_risky` | Noul | "This action spends money, deletes, sends or publishes" | Our existing consequential-action check, as a second opinion |

This is a good fit because **the decisions we actually ask a model for per round are choices over a set we already computed** — which ref, which kind of move, which tab. The text we need in the timeline is already templated (`VERBS`, `activeLabel`, past-tense summaries), so a model that returns no strings costs us nothing in the UI: `Opening new page…` comes from `verb('open','active')`, not from the model.

The fit is poor for two things, and they are not fringe cases:

### 3a. Typing is a text-generation problem, not a decision problem

`type` and `write` need content. Options, in order of preference:

1. **Plan-scoped value slots.** System 2's plan already returns 3–6 steps. Extend it to return the literal strings the task implies as an ordered slot list (`{"slots":["standing desk","under $400"]}`), and let Jev pick `slot:1` by Choice. Fits the primitive exactly. Fails when the value depends on something only visible mid-run ("the cheapest of the three results").
2. **System 2 on demand.** Any round whose chosen action needs new prose escalates. Cost: those rounds stay LLM-paced, which is most of a research or writing task.
3. **Hybrid read-then-write.** Jev executes navigation and reads; one LLM call at the end composes the text. This is the honest shape for "summarize this page": the entire run is not reflex-driven.

### 3b. The 255-option ceiling and the element map

`Choice` takes at most 255 options, and every option's name *and* description is sent to the model, so option text is input tokens. Our Careful profile already observes up to 220 refs; the Fast profile 50. Under the ceiling today — but only just, and a dense page can exceed it. The documented pattern for high cardinality is a two-stage decision: score or chunk first, then choose. Concretely: ask `region` (header/main/nav/footer/list/overlay/dialog) plus a `shortlist` Choice over the first 200 refs by document order, then a second request over the refs inside the chosen region if `next` came back ambiguous. They even document beam search over Choice probabilities for hierarchical cases. That is extra round trips when it triggers, which is why the trigger has to be a cheap Noul rather than a fixed two-stage design.

## 4. Architecture if we do it

Keep the Worker as the only place that holds keys. Jev becomes a second policy behind the same action schema:

```
POST /step  (new, Worker)
  body: goal, plan, step history, filtered element map, refs, last result, cap counts
  1. build state (compact, text: goal + plan + history + elements with refs and labels)
  2. if no TYPESAFE_API_KEY or JEV_MODE=off → existing /agent
  3. POST /v1/systemone { model, state, questions }
  4. if answers.needs_system_2.noul > THRESHOLD or answers.next.confidence < FLOOR
       → /agent (Gemini), with Jev's answer injected as a hint
  5. else → shape a normal action object, return the same response interface
```

Four things make this a smaller change than it sounds:

- The panel already consumes one response shape and renders whatever actions it gets. A Jev round that produces a valid `{"actions":[…]}` needs no panel change at all.
- Our action validation (typed errors, ref checks, coordinates within the viewport) runs *after* the decision, so a Jev policy cannot bypass it. Type safety is Jev's guarantee about the *answer shape*, not about whether the ref exists.
- Confidence is the thing LLMs cannot give us. Today the Worker guesses "the model repeated an action that did nothing" from history; with Jev we can route a low-confidence round to Gemini *before* burning an action.
- Shadow mode is cheap and risk-free: run Jev beside Gemini for a run, log whether `next`/`target` agreed, and change nothing the user sees. `JEV_MODE=shadow` is the first commit, not the last.

What changes on the panel side: a per-round badge suggesting which system decided, and a Settings field for the TypeSafe key *on the Worker*. Nothing about the "client-side Jev" in the pitch survives as stated — see §5.

## 5. Where the pitch needs correcting

The pitch says Jev is fed **client-side**. In a Chrome extension that means either shipping `TYPESAFE_API_KEY` in the unpacked bundle (anyone can read it; it is not a secret) or asking every user to paste their own key. The first is not shippable, the second is not a product. The defensible framing is **edge-side**: Jev runs on the Worker one hop from the browser, so the round is `extension → Worker → TypeSafe`, scores the second hop at the vendor's 70–500 ms plus our Worker's overhead. Our existing **Local bridge** (`bridge/server.mjs`, loopback-only) is the genuine "client-side" variant for power users who want the key on their own machine and no network hop to Cloudflare — that deserves the pitch language instead.

Other claims worth tightening:

- **"Zero token hallucination"** is fair as a statement about *shape*: Jev returns typed values from a fixed option set, so it cannot invent an action name or a schema field. It can still choose a valid but wrong ref — a wrong click is a decision error, not a hallucination. Worth saying precisely, because a customer will probe it.
- **"Sub-200 ms loops"** is the floor of the vendor's range and excludes observation, the extension round trip, the CDP action and the effect check. Measure our own median round first; state the model-call portion separately.
- **"System 2 wakes up only for ambiguity"** is only true if typing doesn't need new prose, which §3a shows it often does. The honest version: System 2 wakes for ambiguity *and* for any step whose content must be written.
- **"A standalone Chromium workspace"** is a different product from this repository. Nothing in the extension becomes that without a build and distribution track of its own.

## 6. Decision quality and risk

- **Early access.** Jev is on early access with a waitlist and an API console; availability and rate limits are per organisation and visible only in that console. A pivot that depends on it needs a fallback path permanently, not temporarily.
- **Boundary between the systems is the whole design.** Too eager to escalate and we are back to LLM latency; too reluctant and the agent flails with high-confidence wrong clicks. The thresholds are not guessable — they need an offline set of recorded rounds where the correct next action is known.
- **Calibration is per population, not per user.** Confidence is calibrated on the vendor's training distribution. Our states are accessibility trees full of truncated labels and identical "Learn more" links, which is not obviously their idea of a clean decision. Threshold must be tuned on our own transcripts, and that work is not optional.
- **Aliases drift.** `jev-latest` moves. If a threshold was tuned on 1.14.0, pin `jev-1.14.0` in the request and bump deliberately.
- **English.** Accuracy is best in English and uneven elsewhere; a low-confidence round is the correct route for a non-English page.
- **Data.** The vendor states requests are not used for training. The state we send is the same page text and labels we already send to Gemini, so the privacy story does not get worse — it gets one more processor, which the README's privacy section must name.

## 7. Plan, cheapest first

**Phase 0 — instrument the loop (no Jev).** Log per round: observe time, payload size, model time, action time, settle time. Without this we cannot say what Jev would save, and the pitch's central number stays unverifiable. One run of `evals/run.mjs` with a live key produces the baseline. Shipped: `extension/panel.js` now keeps one record per round — read, model, network, act, payload bytes, screenshot flag and token counts — and `/timings` prints the medians and exports the JSON.

**Phase 1 — shadow.** `worker/jev.js` adapter (request builder for `next`/`target`/`needs_system_2`/`on_track`, response shaper, version pinning), `JEV_MODE=shadow` runs it in parallel and logs agreement with the Gemini action. Nothing user-visible. Success criterion: agreement on the action kind ≥ some floor on navigation-heavy tasks, and a measured latency delta on the Jev leg.

**Phase 2 — live reflex, escalate on doubt.** `JEV_MODE=live` serves rounds where `needs_system_2 < a` and `confidence > b`; everything else goes to Gemini, with the Jev answer as a hint. Typing actions route to System 2 until value slots exist. This is where the sub-second round claim either shows up in the logs or does not.

**Phase 3 — plan-provided values.** Extend the planner to emit literal slot values so that "search for X" becomes a Choice over slots instead of an LLM call. This is the change that moves form-filling onto the fast path and therefore the one that decides whether the economics story holds for real tasks.

**Phase 4 — economics.** Report cost per completed task, not per call: Jev rounds are ~$0.0003 for a 6k-token state, but a task with a Gemini escalation is only as cheap as its escalations. Our per-task cost is the number a customer compares.

## 8. Bottom line

The pitch describes a real and well-matched product: our per-round decisions are choices over a DOM we already extract, and typed probabilistic answers with confidence are strictly more useful than parsing Gemini's JSON. But two claims need to change before this is honest. Jev does not remove the need for a heavy LLM — it moves *when* we pay for one, and any step that writes text still pays. And it does not make rounds sub-200 ms by itself; it makes the *decision* part of a round near-instant, which only becomes a fast round once observation and settle waits are measured and attacked too.

Effort, in this codebase: Phase 0–2 is a Worker module plus a settings toggle and an eval pass — small. Phase 3 is a planner contract change and touches every typing path — the real work. Nothing is worth starting before Phase 0, because right now we cannot state what a round costs.

## Sources

- TypeSafe AI, "Introducing System One Models & Jev" (15 Sep 2026) — <https://typesafe.ai/blog/introducing-system-one-models-and-jev>
- TypeSafe docs, Introduction (typed primitives) — <https://docs.typesafe.ai/introduction>
- TypeSafe docs, Choice (request/response shape, 255 options, confidence) — <https://docs.typesafe.ai/primitives/choice>
- TypeSafe docs, Models (ids, pricing, context limits, rate limits, aliases, text-only input) — <https://docs.typesafe.ai/models>
- LangChain, "Building a Harness with Jev" (17 Sep 2026) — <https://www.langchain.com/blog/building-a-harness-with-jev>
