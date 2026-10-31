# RoboHost inference vs. the current page-reading approach

**Question:** would RoboHost inference read websites better than what webagent does today?
**Date:** 31 October 2026
**Short answer:** RoboHost does not appear to be an inference or web-reading product at all, so there is nothing to compare it against. The current approach (live DOM text + viewport screenshot + interactive-element map, read inside the user's own tab) is the right architecture for this extension, and the improvements below are where real gains are.

---

## 1. What "RoboHost" actually is

I searched across spelling variants (`RoboHost`, `Robo Host`, `robohost.ai`, "robohost inference API", "RoboHost AI agent"), plus GitHub, Hugging Face, Product Hunt/Crunchbase and generic "LLM inference API" queries. No AI inference, vision, agent, or web-extraction product by that name exists in any index I could reach. The only real entities under the name are unrelated hosting businesses:

| Entity | What it is | Relevant to reading websites? |
|---|---|---|
| robohost.ai | Generic shared hosting marketed with "AI SEO" copy (auto meta tags, schema markup, CDN, SSL). Plans $9 / $29 / $99 per month. | No. "AI" refers to SEO/speed features for hosted sites. |
| robohost.in | Small Indian shared/VPS/reseller host, cPanel + Let's Encrypt, ₹49–₹999 per month. | No. |
| robohost.app | iOS restaurant booking-management app. | No. |

No screenshot/vision capability, no DOM-to-text extraction, no API endpoint, no SDK, no model names, no benchmarks, and no pricing for inference were found for any of them.

**Caveat:** absence of evidence is not proof of non-existence. A private beta, a name used only in a Discord or a paid ad, or a recently renamed product could be invisible to search. If you saw the name somewhere specific (an ad, a listicle, a comparison table), send me the source and I will check that exact claim. Otherwise treat "RoboHost inference" as unverified/likely conflated with something else.

**Practical consequence:** there is no integration to build, no key to obtain, and no reason to change the current pipeline on RoboHost's account.

---

## 2. How webagent reads a page today

On every step, `observe` collects three things from the tab the user starred:

1. **`document.body.innerText`** (up to 40,000 chars, trimmed to 12,000 in the prompt) — the rendered, visible text after CSS and JS, in reading order.
2. **A viewport screenshot** (JPEG, device pixels) — layout, colour, state, icons, anything text misses.
3. **A map of visible interactive elements** — for every visible button, link, input, select, textarea, summary and ARIA widget in the viewport: role, accessible-ish label, and the centre coordinate in screenshot pixels. Added in this change; capped at 60 elements in the prompt.

Plus, from up to five other tabs, read-only text as context.

Then the model picks one action, and the browser executes it through the debugger with coordinate scaling, text-field safety checks, and password-form blocking.

**Why this is a good design for this product**

- **It sees what the user sees.** Logged-in sessions, carts, dashboards, consent dialogs and personalised content only exist in the user's own browser. A hosted reader that fetches a URL anonymously sees a different page — often a login wall or a bot check.
- **No extra hop.** Text, pixels and elements come from the same tab in one parallel pass, so the data is a few hundred milliseconds old, not a stale crawl.
- **No extra service in the trust path.** Page content never leaves the user's browser except to their own Worker and the model provider they chose.
- **Grounding beats raw vision for a cheap model.** The element map converts "find the Search button in this picture" into "click 412,88, which is the button labelled Search". This is the single biggest accuracy lever for a model like Gemini Flash-Lite, and it is why the pipeline does not need a specialised web-reading vendor.

**Where it is genuinely weak**

- `innerText` is flat: it loses table structure, `aria` relationships and SVG-only UI, and it over-includes nav/footer/ad boilerplate.
- Pages rendered into `<canvas>` or exotic shadow DOM give thin text.
- One viewport at a time: content below the fold is invisible until the agent scrolls.

---

## 3. Real alternatives, if you want a stronger page reader

These exist and are comparable; RoboHost is not. Treat the accuracy numbers as vendor/blog claims, not independent benchmarks — the one concrete figure I found (Firecrawl 94% vs Jina Reader 89% "meaningful content extracted with correct structure") comes from a 2026 vendor-adjacent blog post, not a controlled study.

| Option | What it gives you | Fit for a side-panel browser agent |
|---|---|---|
| **Jina Reader** (`r.jina.ai/<url>`) | URL → clean Markdown, rendered in a headless browser; generous free tier | Good for *public* pages; cannot see the user's session, so it fails on anything behind a login — which is most real agent work |
| **Firecrawl** | JS-rendered scrape, Markdown/JSON output, crawling, schema extraction | Same session problem; best when you already know the URLs and want bulk extraction |
| **Browserbase / Stagehand** | Hosted browser + agent-friendly page primitives (DOM snapshots, act/observe) | Closest real competitor to this architecture, but moves the browsing into a remote browser: loses the user's cookies and costs per browser-minute |
| **Exa / Tavily Extract** | Search + extract API, answer-shaped output | Useful for research-style tasks that start from a query, not for acting inside a page |
| **Readability/Trafilatura-style local extraction** | Boilerplate stripping in the extension itself | Cheap, private, no new dependency on a vendor; would cut prompt size and improve focus on content-heavy pages |

Not recommended: giving any hosted reader the user's session cookies to fix the login problem — that turns a local tool into a credential-handling service.

---

## 4. Recommendation

1. **Do not adopt RoboHost** — it is not verifiable as a product of this kind.
2. **Keep in-tab extraction** as the primary reader. Session access, freshness and privacy all argue for it, and the element map now covers the accuracy gap that a vision-only agent would have.
3. **Best next improvement, in order of value per unit of work:**
   - **Main-content extraction** (a small Readability-style scorer over the DOM) so the 12,000-char budget holds article text, not nav and footer. Biggest token and focus win, zero new vendors.
   - **Structured text hints**: table rows as `a | b | c`, list items with markers, `aria-label`/`alt` merged into the text stream. Fixes the biggest `innerText` blind spot for cheap models.
   - **Element map expansion**: include elements slightly outside the viewport (above and below), plus `disabled`/`checked` state, so the agent stops "clicking" off-screen buttons and scrolling blindly.
   - **Jina Reader as an optional fallback** only for pages where local text is thin (canvas/SVG-heavy) *and* the URL is public — as a user-chosen setting, never as the default path.
4. **Revisit only if** a real product named RoboHost shows up with published docs, an API and a benchmark — the bar for replacing a working in-browser pipeline should be a measured A/B on your own task set, not a landing page.

---

## Sources

- https://www.robohost.ai/ (hosting / "AI SEO", fetched)
- https://robohost.in/ (Indian hosting, fetched)
- https://robohost.app/ (iOS restaurant app, search evidence)
- https://in.linkedin.com/in/robohostai (snippet only — LinkedIn blocked fetching)
- https://kanopylabs.com/blog/firecrawl-vs-jina-reader-vs-tavily-ai-data-extraction (2026 extraction comparison, vendor-adjacent)
- https://www.firecrawl.dev/alternatives/firecrawl-vs-jina-ai (vendor comparison)
- https://browser-use.com/posts/web-scraping-guide-2026 (browser-agent scraping landscape)
- OpenRouter model catalogue (`/api/v1/models`) for the model capability and pricing facts used above
