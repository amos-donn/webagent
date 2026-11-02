const $ = id => document.getElementById(id);
const ICONS = { think:'sparkle', click:'cursor-click', type:'keyboard', write:'sparkle', read:'book-open-text', scroll:'arrows-down-up', wait:'hourglass', navigate:'arrow-right', key:'key-return', switch:'arrow-right', open:'plus', gather:'book-open-text', close:'x' };
// Two names per step: what it is doing while it runs, and what it did once it finished. The
// timeline keeps the past tense because it is a record of work, not a spinner that vanished.
const VERBS = {
  think: ['Thinking', 'Thought'], click: ['Clicking', 'Clicked'], type: ['Typing', 'Typed'],
  write: ['Writing with Gemini', 'Wrote'], read: ['Reading the page', 'Read the page'],
  scroll: ['Scrolling', 'Scrolled'], wait: ['Waiting', 'Waited'],
  navigate: ['Opening the page', 'Opened the page'], key: ['Pressing a key', 'Pressed a key'],
  switch: ['Switching tabs', 'Switched tabs'], open: ['Opening a new page', 'Opened a new page'],
  gather: ['Reading tabs', 'Read the tabs'], close: ['Closing the tab', 'Closed the tab'],
  inspect: ['Looking at the page', 'Looked at the page']
};
const verb = (type, tense = 0) => (VERBS[type] || ['Working', 'Worked'])[tense];
const LABELS = Object.fromEntries(Object.entries(VERBS).map(([type, names]) => [type, names[0]]));
function activeLabel(action) {
  const what = String(action.description || '').trim();
  return `${verb(action.type)}${what ? `: ${what}` : ''}`;
}
const TAB_STEPS = new Set(['open', 'switch', 'gather', 'close']);const STEP_LIMIT = 60;
const MAX_CHATS = 20;
const MAX_MESSAGES = 400;
const RISK = /\b(buy now|place order|pay now|purchase|checkout|transfer|withdraw|delete account|close account|cancel subscription)\b/i;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Nothing in a run may wait forever: a hung Worker, debugger or tab becomes a retry, not a stall.
const REQUEST_TIMEOUT = 50000;
const PLAN_TIMEOUT = 22000;
const OBSERVE_TIMEOUT = 30000;
function timed(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
let workflow = null, proposal = null, plan = [], chats = [], chat = null;
let tabCache = [], actingTabId = null, contextIds = [];
// There is no mode picker any more: every round runs on its own, and a risky-looking step is still
// matched against the goal and announced in the timeline.
let mode = 'autopilot', planMode = 'auto', lastShot = '', skills = [];
// Speed moves the model and the pauses together: a light model answers in about a second, so a
// 600 ms pause between actions is most of the wait. Careful is the old behaviour.
let speed = 'fast', slowPages = false, stayPut = true;
const PACING = { fast: 120, balanced: 400, careful: 800 };
const SETTLE_MS = { fast: 800, balanced: 2200, careful: 4000 };
const pace = () => PACING[speed] || PACING.balanced;
const settleFor = () => (slowPages ? 4000 : SETTLE_MS[speed] || SETTLE_MS.balanced);
/* ---------- round timings ---------- */
// Phase 0 of the System 1 work: a round is read + decide + act, and until those are three separate
// numbers nobody can say what a faster decision model would actually save. One record per round,
// capped in local storage, read back with /timings.
const METRICS_KEY = 'timings';
const METRICS_LIMIT = 400;
let timings = [];
function logTiming(record) {
  if (!record) return;
  timings.push(record);
  timings = timings.slice(-METRICS_LIMIT);
  chrome.storage.local.set({ [METRICS_KEY]: timings }).catch(() => {});
}
// The action that follows a decision is timed after the record was opened, so the record is closed
// when the next round starts, when the run ends, or when the final check takes over.
function flushTiming(run) {
  const record = run?.timing;
  if (!record) return;
  run.timing = null;
  record.total = [record.observeMs, record.modelMs, record.netMs, record.actionMs].reduce((sum, value) => sum + (Number(value) || 0), 0);
  logTiming(record);
}
function noteActionMs(run, started, type) {
  const record = run?.timing;
  if (!record) return;
  record.actionMs = (record.actionMs || 0) + Math.max(0, Math.round(performance.now() - started));
  record.actions = (record.actions || 0) + 1;
  record.kinds = [...(record.kinds || []), type];
}
const median = values => { const list = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b); if (!list.length) return 0; const mid = Math.floor(list.length / 2); return list.length % 2 ? list[mid] : Math.round((list[mid - 1] + list[mid]) / 2); };
const p90 = values => { const list = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b); return list.length ? list[Math.min(list.length - 1, Math.ceil(list.length * 0.9) - 1)] : 0; };
function timingSummary() {
  const list = timings.slice(-60);
  if (!list.length) return ['No rounds logged yet. Run a task, then /timings.'];
  const secs = value => `${(value / 1000).toFixed(2)}s`;
  const shots = list.filter(record => record.image).length;
  const bytes = Math.round(list.reduce((sum, record) => sum + (record.bytes || 0), 0) / list.length);
  const tokensIn = list.reduce((sum, record) => sum + (record.tokens?.in || 0), 0);
  const tokensOut = list.reduce((sum, record) => sum + (record.tokens?.out || 0), 0);
  const modelMs = median(list.map(record => record.modelMs || 0));
  const totalMs = median(list.map(record => record.total || 0));
  return [
    `${list.length} round${list.length === 1 ? '' : 's'} logged · median ${secs(totalMs)} · p90 ${secs(p90(list.map(record => record.total || 0)))}`,
    `Median split: read ${secs(median(list.map(record => record.observeMs || 0)))} · model ${secs(modelMs)} · network ${secs(median(list.map(record => record.netMs || 0)))} · act ${secs(median(list.map(record => record.actionMs || 0)))}`,
    `Model is ${totalMs ? Math.round(modelMs / totalMs * 100) : 0}% of the round · ${shots}/${list.length} rounds used a screenshot · ${Math.round(bytes / 1024)} KB average payload · ${(tokensIn / 1000).toFixed(1)}k in / ${(tokensOut / 1000).toFixed(1)}k out tokens`
  ];
}
function showTimings() {
  for (const line of timingSummary()) pushMessage('note', line);
  if (timings.length) download('mezze-timings.json', JSON.stringify(timings, null, 2));
  notify(timings.length ? 'Timings written to the chat and exported as JSON.' : 'No rounds logged yet.', !timings.length);
}

function notify(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); $('notice').hidden = false; }
function baseUrl() { const url = new URL($('worker').value.trim()); if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname)))) throw new Error('Use an HTTPS Worker URL or localhost.'); return url.origin + url.pathname.replace(/\/$/, ''); }
// Ask once for every site, not once per site: Chrome remembers this grant until you revoke it.
const ALL_SITES = ['https://*/*', 'http://*/*'];
let allSites = false;
async function permission() {
  if (allSites) return;
  if (await chrome.permissions.contains({ origins: ALL_SITES })) { allSites = true; return; }
  if (!await chrome.permissions.request({ origins: ALL_SITES })) throw new Error('Site access was not granted. Allow it once and the agent will not ask again.');
  allSites = true;
}
async function activeUrl() { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (!tab?.url) throw new Error('Select a webpage first.'); return tab.url; }
async function send(type, data = {}) { const out = await chrome.runtime.sendMessage({ type, ...data }); if (out.error) throw Object.assign(new Error(out.error), { code: out.code || 'ERROR' }); return out.data; }
// A per-minute cap is a pause, not a failure: count it down and pick the run back up by itself.
const COOLDOWN_SECONDS = 30;
const COOLDOWN_LIMIT = 6;
// Every Worker failure says "…and rate limits." in its boilerplate, so the bare phrase is not a signal;
// only a real quota answer counts, otherwise a fast 404 would be waited out six times.
const RATE_LIMIT = /(quota|too many requests|resource.?exhausted|rate limit exceeded|limit reached)/i;
let cooldowns = 0;
const isRateLimit = (status, message) => Number(status) === 429 || RATE_LIMIT.test(String(message || ''));
async function cooldown(seconds = COOLDOWN_SECONDS) {
  const end = Date.now() + seconds * 1000;
  cooldowns += 1;
  notify(`The model hit its usage limit. Restarting in ${seconds}s.`);
  while (Date.now() < end) {
    const left = Math.max(1, Math.ceil((end - Date.now()) / 1000));
    loading(`Usage limit — restarting in ${left}s`, 'hourglass');
    await sleep(200);
  }
}
async function api(path, data, retries = 2) {
  const base = baseUrl();
  let lastError = new Error('Request failed.');
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type':'application/json' }, body: typeof data === 'string' ? data : JSON.stringify(data), signal: AbortSignal.timeout(REQUEST_TIMEOUT) });
      const out = await res.json().catch(() => ({}));
      if (res.ok) { cooldowns = 0; return out; }
      const error = new Error(out.error || `Request failed (${res.status}).`);
      if (isRateLimit(res.status, error.message)) {
        // Waiting does not spend a retry, and the cap keeps a hard outage from hanging forever.
        if (cooldowns < COOLDOWN_LIMIT) { await cooldown(); attempt -= 1; continue; }
        error.code = 'RATE_LIMIT';
        throw error;
      }
      if (res.status < 500 && res.status !== 429) throw error;
      lastError = error;
    } catch (e) {
      lastError = e;
      if (e.code === 'RATE_LIMIT') throw e;
      if (e.name === 'TimeoutError') e.message = `The Worker did not answer within ${REQUEST_TIMEOUT / 1000}s.`;
      if (/failed \(4/.test(e.message) || /limit reached/i.test(e.message)) throw e;
    }
    if (attempt < retries) await sleep(400 * (attempt + 1));
  }
  throw lastError;
}
function task(id, fn) { $(id).addEventListener('click', async () => { $(id).disabled = true; try { await fn(); } catch (e) { notify(e.message || 'Something went wrong.', true); } finally { $(id).disabled = false; } }); }

function grow() { const el = $('goal'); el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 240)}px`; }
// There is no Continue button any more: a dead end stops the run and puts the task back in the box.
function halt(run, message) { const goal = run?.goal || ''; stop(); if (goal) { $('goal').value = goal; grow(); } if (message) notify(message, true); }

/* ---------- final check ---------- */
const VERDICTS = {
  passed: { icon: 'check', label: 'Checked and done' },
  partial: { icon: 'warning-circle', label: 'Partly done' },
  failed: { icon: 'x', label: 'Did not work' },
  unknown: { icon: 'info', label: 'Reported, not checked' }
};
function verdictOf(report) { return VERDICTS[report.verdict] ? report.verdict : 'unknown'; }
// The end of a run is a reply, not a work order: the steps above already say what happened, so this
// only says whether it worked, in the first person, and what is still open.
function reportText(report) {
  const reply = report.reply || report.summary || '';
  const left = Array.isArray(report.blocked) && report.blocked.length ? `\n\n${report.blocked.map(item => `- ${item}`).join('\n')}` : '';
  const text = `${reply}${left}`.trim();
  return text || VERDICTS[verdictOf(report)].label;
}
function reportCard(report) {
  const verdict = verdictOf(report);
  const card = document.createElement('div');
  card.className = `message report ${verdict}`;
  const head = document.createElement('div'); head.className = 'report-head';
  const badge = document.createElement('span'); badge.className = 'report-badge'; setIcon(badge, VERDICTS[verdict].icon, 13);
  const title = document.createElement('strong'); title.textContent = report.headline || VERDICTS[verdict].label;
  head.append(badge, title); card.append(head);
  const reply = document.createElement('p'); reply.className = 'report-reply';
  reply.textContent = report.reply || report.summary || VERDICTS[verdict].label;
  card.append(reply);
  // What is still open, in the agent's own voice; a list of everything it did would just repeat the timeline.
  const left = (Array.isArray(report.blocked) ? report.blocked : []).filter(Boolean);
  if (left.length) {
    const ul = document.createElement('ul'); ul.className = 'report-left';
    for (const item of left) { const li = document.createElement('li'); li.textContent = item; ul.append(li); }
    card.append(ul);
  }
  return card;
}
// Before a run reports success it looks at the page again and has the model check its own work; a
// failed check feeds back as a correction instead of ending the run, and the user always gets a report.
async function finalCheck(run, claim, incomplete = []) {
  flushTiming(run);
  if (workflow !== run) return;
  loading('Checking the result', 'check');
  $('loading-label').textContent = 'Checking the result against the page';
  let shot = null;
  try { shot = await timed(send('observe', { tabId: run.actingTabId, activate: false }), 20000, 'The final check could not read the page.'); } catch { /* the transcript still allows a report */ }
  if (workflow !== run) return;
  let report;
  try {
    report = await api('/review', { speed,
      goal: run.goal, claim: claim || '', todos: plan, steps: run.steps,
      url: shot?.url || run.view?.url, title: shot?.title, text: shot?.text || '',
      ...(shot ? { image: shot.image, width: shot.width, height: shot.height } : {})
    });
  } catch (e) {
    if (workflow !== run) return;
    // A check that cannot run must not swallow the result: say so and report the claim as unverified.
    report = { verdict: 'unknown', headline: 'Finished without a final check', did: [], failed: [], blocked: [], needsWork: false, reply: `I finished the run, but I couldn't check it: ${e.message} Treat what is on the page as unverified.`, summary: `${claim || 'The task finished.'} The final check could not run: ${e.message}` };
  }
  if (workflow !== run) return;
  if (incomplete?.length) {
    const titles = plan.filter(item => incomplete.includes(item.id)).map(item => `I couldn't finish “${item.title}”.`);
    report = { ...report, verdict: report.verdict === 'passed' ? 'partial' : report.verdict, blocked: [...(report.blocked || []), ...titles] };
  }
  if (report.needsWork && (run.checks || 0) < 2 && run.mode !== 'manual') {
    run.checks = (run.checks || 0) + 1;
    run.correction = report.problem || 'The final check did not confirm the goal.';
    pushMessage('note', `Not done yet: ${run.correction} Going back to the page.`);
    $('loading').hidden = true;
    await next(run, shot || undefined);
    return;
  }
  pushMessage('report', reportText(report), { report });
  renderPlan();
  stop();
  notify(report.verdict === 'passed' ? 'Finished, and the result checked out.' : 'Finished without full confirmation — see the report.', report.verdict !== 'passed');
}

/* ---------- tabs ---------- */
async function listTabs() { const { tabs } = await send('tabs'); tabCache = tabs; const ids = new Set(tabs.map(t => t.id)); if (!ids.has(actingTabId)) actingTabId = (tabs.find(t => t.active) || tabs[0])?.id ?? null; contextIds = contextIds.filter(id => ids.has(id) && id !== actingTabId); renderTabs(); return tabs; }
function shortTitle(t) { const s = (t.title || t.url).trim(); return s.length > 60 ? s.slice(0, 60) + '…' : s; }
function renderTabs() {
  const box = $('tab-list'); box.textContent = '';
  if (!tabCache.length) box.textContent = 'No tabs found.';
  for (const t of tabCache) {
    const row = document.createElement('div'); row.className = 'tab-row' + (t.id === actingTabId ? ' acting' : '');
    const act = document.createElement('button'); act.type = 'button'; act.className = 'tab-btn' + (t.id === actingTabId ? ' on' : ''); setIcon(act, 'star', 12); act.title = 'Act in this tab'; act.setAttribute('aria-label', `Act in ${shortTitle(t)}`);
    act.addEventListener('click', async () => { actingTabId = t.id; contextIds = contextIds.filter(id => id !== t.id); renderTabs(); try { await permission(t.url); } catch (e) { notify(e.message || 'Site access was not granted.', true); } });
    const ctx = document.createElement('button'); ctx.type = 'button'; ctx.className = 'tab-btn' + (contextIds.includes(t.id) ? ' on' : ''); setIcon(ctx, 'plus', 12); ctx.title = 'Include as read-only context'; ctx.setAttribute('aria-label', `Include ${shortTitle(t)} as context`);
    ctx.addEventListener('click', async () => { if (t.id === actingTabId) return; contextIds = contextIds.includes(t.id) ? contextIds.filter(id => id !== t.id) : [...contextIds, t.id].slice(0, 5); renderTabs(); if (contextIds.includes(t.id)) { try { await permission(t.url); } catch (e) { notify(e.message || 'Site access was not granted.', true); } } });
    const label = document.createElement('span'); label.className = 'tab-label'; label.textContent = shortTitle(t); label.title = t.url;
    if (!t.supported) { const tag = document.createElement('span'); tag.className = 'tab-tag'; tag.textContent = 'unsupported'; label.append(' ', tag); }
    else if (workflow?.opened?.includes(t.id)) { const tag = document.createElement('span'); tag.className = 'tab-tag agent'; tag.textContent = 'agent'; label.append(' ', tag); }
    row.append(act, ctx, label); box.append(row);
  }
  const acting = tabCache.find(t => t.id === actingTabId);
  $('tabs-label').textContent = acting ? `★ ${shortTitle(acting)}${contextIds.length ? ` · +${contextIds.length} context` : ''}` : 'No tab selected';
  renderSkillChip(); renderTabStrip();
}
function tabPill(text, icon, className, title) {
  const pill = document.createElement('button');
  pill.type = 'button'; pill.className = `tab-pill ${className}`.trim(); pill.title = title;
  pill.append(phosphor(icon, 11), document.createElement('span'));
  pill.lastChild.textContent = text;
  return pill;
}
// The strip above the box: what the agent acts in and what it can read. No "add a tab" button — @ in
// the message box attaches a tab, and the agent can pull other tabs in itself when a task needs them.
function renderTabStrip() {
  const strip = $('tab-strip');
  if (!strip) return;
  const acting = tabCache.find(t => t.id === actingTabId);
  strip.textContent = '';
  if (!acting) { strip.hidden = true; return; }
  const current = tabPill(shortTitle(acting), 'star', 'acting', `${acting.url} — the tab the agent acts in`);
  current.addEventListener('click', toggleTabsBox);
  strip.append(current);
  for (const id of contextIds) {
    const tab = tabCache.find(t => t.id === id);
    if (!tab) continue;
    const pill = document.createElement('span');
    pill.className = 'tab-pill context'; pill.title = `${tab.url} — read-only context`;
    pill.append(phosphor('plus', 11));
    const label = document.createElement('span'); label.textContent = shortTitle(tab); pill.append(label);
    const drop = document.createElement('button'); drop.type = 'button'; drop.className = 'tab-drop'; drop.title = 'Stop using this tab as context'; drop.setAttribute('aria-label', `Remove ${shortTitle(tab)} from context`); setIcon(drop, 'x', 9);
    drop.addEventListener('click', () => { contextIds = contextIds.filter(item => item !== id); renderTabs(); });
    pill.append(drop);
    strip.append(pill);
  }
  strip.hidden = false;
}
function toggleTabsBox() {
  const box = $('tabs-box');
  box.open = !box.open;
  if (box.open) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ---------- chats ---------- */
function newChatRecord() { return { id: crypto.randomUUID(), title: 'New chat', goal: '', messages: [], plan: [], steps: [], at: Date.now() }; }
async function persist() {
  if (!chat) return;
  chat.plan = plan;
  chat.messages = chat.messages.slice(-MAX_MESSAGES);
  if (workflow) chat.steps = workflow.steps;
  chat.at = Date.now();
  const index = chats.findIndex(item => item.id === chat.id);
  if (index === -1) chats.unshift(chat); else chats[index] = chat;
  chats = chats.slice(0, MAX_CHATS);
  await chrome.storage.local.set({ chats, activeChat: chat.id });
}
function welcome() {
  const box = document.createElement('div'); box.className = 'welcome';
  const icon = document.createElement('span'); icon.className = 'welcome-icon'; setIcon(icon, 'asterisk', 14);
  const body = document.createElement('div'); body.className = 'welcome-body';
  const strong = document.createElement('strong'); strong.textContent = 'Ready when you are.';
  const p = document.createElement('p'); p.textContent = "Tell me what to do in this tab. I'll read the page, plan only if it helps, and work through it; every step appears above as it happens.";
  const examples = document.createElement('div'); examples.className = 'welcome-examples';
  for (const idea of ['Summarize this page', 'Fill in this form', 'Find this cheaper elsewhere']) {
    const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'example'; chip.textContent = idea;
    chip.addEventListener('click', () => { $('goal').value = idea; grow(); $('goal').focus(); });
    examples.append(chip);
  }
  body.append(strong, p, examples); box.append(icon, body);
  return box;
}
function renderMessage(message) {
  if (message.role === 'activity') {
    const details = document.createElement('details'); details.className = 'activity' + (message.failure ? ' failed' : '');
    const summary = document.createElement('summary');
    const badges = `${message.failure ? ' · failed' : message.changed === false ? ' · no visible change' : ''}${message.fallback ? ' · retried with a scripted click' : ''}`;
    summary.append(phosphor(ICONS[message.type] || 'sparkle', 13), document.createTextNode(`  ${verb(message.type, 1)}${message.elapsed ? ` · ${(message.elapsed / 1000).toFixed(1)}s` : ''}${badges}`));
    const thought = document.createElement('p'); thought.textContent = message.text || 'Action completed.';
    details.append(summary, thought);
    if (message.page) { const page = document.createElement('p'); page.className = 'page-url'; page.textContent = `Webpage: ${message.page}`; details.append(page); }
    if (message.failure) { const error = document.createElement('p'); error.className = 'step-error'; error.textContent = message.failure; details.append(error); details.open = true; }
    if (message.input) { const text = document.createElement('p'); text.textContent = `Text: ${message.input}${message.submit ? ' (then Enter)' : ''}`; details.append(text); }
    if (message.destination) { const dest = document.createElement('p'); dest.textContent = `Destination: ${message.destination}`; details.append(dest); }
    if (message.excerpt) { const excerpt = document.createElement('p'); excerpt.textContent = `Read: ${message.excerpt}`; details.append(excerpt); }
    if (message.opened?.url) {
      // A created tab is a thing you can go back to, so it gets a chip rather than a sentence.
      const chip = document.createElement('a'); chip.className = 'tab-chip'; chip.href = message.opened.url; chip.target = '_blank'; chip.rel = 'noreferrer';
      chip.textContent = message.opened.title || hostOf(message.opened.url); chip.title = message.opened.url;
      details.append(chip);
    }
    return details;
  }
  // What the DOM round actually saw, printed before any model call.
  if (message.role === 'inspect') {
    const line = document.createElement('div'); line.className = 'inspect';
    line.append(phosphor('eye', 11), document.createTextNode(` ${message.text}`));
    return line;
  }
  // A finished thought is flat text, not a card: the shimmer belongs to the wait, not the result.
  if (message.role === 'thought') {
    const line = document.createElement('div');
    line.className = 'thought';
    line.textContent = message.text;
    return line;
  }
  if (message.role === 'report') return reportCard(message.report || {});
  const el = document.createElement('div');
  el.className = `message ${message.role}`;
  el.textContent = message.text;
  return el;
}
function renderChat() {
  const box = $('steps'); box.textContent = '';
  if (!chat.messages.length) { box.append(welcome()); return; }
  for (const message of chat.messages) box.append(renderMessage(message));
  box.scrollTop = box.scrollHeight;
}
function pushMessage(role, text, extra = {}) {
  if (!chat) return;
  const message = { role, text, at: Date.now(), ...extra };
  chat.messages.push(message);
  $('steps').querySelector('.welcome')?.remove();
  const el = renderMessage(message);
  $('steps').append(el);
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  persist().catch(() => {});
}
function renderPlan() {
  const box = $('plan-box'), list = $('plan-list');
  if (!plan.length) { box.hidden = true; return; }
  box.hidden = false;
  list.textContent = '';
  const done = plan.filter(item => item.done).length;
  $('plan-label').textContent = workflow ? 'PLAN' : 'PREVIOUS PLAN';
  $('plan-progress').textContent = `${done}/${plan.length} done`;
  $('plan-clear').hidden = !!workflow;
  for (const item of plan) {
    const li = document.createElement('li'); li.className = 'plan-item' + (item.done ? ' done' : '');
    const mark = document.createElement('button'); mark.type = 'button'; mark.className = 'plan-mark'; setIcon(mark, item.done ? 'check' : 'circle', 13);
    mark.title = item.done ? 'Mark as not done' : 'Mark as done';
    mark.setAttribute('aria-label', `${mark.title}: ${item.title}`);
    mark.addEventListener('click', () => { item.done = !item.done; renderPlan(); persist().catch(() => {}); });
    const text = document.createElement('span'); text.textContent = item.title;
    li.append(mark, text); list.append(li);
  }
}
function applyCompleted(run, ids = []) {
  if (!run || !ids.length) return false;
  if (!(run.evidence > 0)) { run.unproven = (run.unproven || 0) + ids.length; return false; }
  const fresh = plan.filter(item => !item.done && ids.includes(item.id));
  if (!fresh.length) return false;
  for (const item of fresh) item.done = true;
  run.evidence = 0;
  renderPlan();
  return true;
}
async function newChat() {
  if (workflow) stop();
  chat = newChatRecord();
  plan = [];
  chats.unshift(chat);
  $('steps').textContent = '';
  $('steps').append(welcome());
  $('plan-box').hidden = true;
  $('notice').hidden = true;
  proposal = null; $('approval').hidden = true;
  await persist();
  notify('New chat started.');
}
function openChat(id) {
  const target = chats.find(item => item.id === id);
  if (!target) return;
  if (workflow) stop();
  chat = target; plan = chat.plan || [];
  renderChat(); renderPlan(); persist().catch(() => {});
  if (plan.some(item => !item.done)) notify('Restored a chat with unfinished steps. Send a message to keep going.');
}
function renderHistory() {
  const list = $('history-list'); list.textContent = '';
  if (!chats.length) { list.textContent = 'No chats yet.'; return; }
  for (const item of chats) {
    const row = document.createElement('div'); row.className = 'history-row' + (chat && item.id === chat.id ? ' current' : '');
    const button = document.createElement('button'); button.type = 'button'; button.className = 'history-open';
    const title = document.createElement('strong'); title.textContent = item.title || 'Untitled chat';
    const meta = document.createElement('span'); meta.className = 'history-time'; meta.textContent = `${new Date(item.at || Date.now()).toLocaleString()} · ${item.messages?.length || 0} messages`;
    button.append(title, meta);
    button.addEventListener('click', () => { $('history-dialog').close(); openChat(item.id); });
    row.append(button); list.append(row);
  }
}
function download(name, text) {
  const blob = new Blob([text], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function markdown(target) {
  const lines = [`# ${target.title || 'Mezze chat'}`, '', `Goal: ${target.goal || '(none)'}`, `Started: ${new Date(target.at || Date.now()).toLocaleString()}`, ''];
  if (target.plan?.length) {
    lines.push('## Plan', '');
    for (const item of target.plan) lines.push(`- [${item.done ? 'x' : ' '}] ${item.title}`);
    lines.push('');
  }
  lines.push('## Transcript', '');
  for (const message of target.messages || []) {
    if (message.role === 'activity') {
      const badges = `${message.failure ? ' (failed)' : message.changed === false ? ' (no visible change)' : ''}`;
      lines.push(`- ${message.type}${badges}: ${message.text}${message.page ? ` — ${message.page}` : ''}`);
    } else if (message.role === 'thought') lines.push(`_${message.text}_`);
    else if (message.role === 'note') lines.push(`> ${message.text}`);
    else lines.push(`**${message.role === 'user' ? 'You' : 'Mezze'}:** ${message.text}`, '');
  }
  return lines.join('\n');
}
function exportChat() {
  const target = chat;
  if (!target) return;
  download(`mezze-${(target.title || 'chat').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}.md`, markdown(target));
  notify('Exported this chat as Markdown.');
}

/* ---------- workflow ---------- */
function stop() {
  flushTiming(workflow);
  workflow = null; proposal = null; currentAction(null);
  $('approval').hidden = true; $('stop').hidden = true; $('start').hidden = false;
  $('goal').disabled = false; $('loading').hidden = true;
  renderPlan(); renderSkillChip(); persist().catch(() => {});
}
function loading(label, icon = 'spinner-gap') {
  // Only the word "Thinking" shimmers: it says the model is still working, and everything after it
  // stays readable.
  const box = $('loading-label');
  const text = String(label || '');
  const rest = text.startsWith('Thinking') ? text.slice(8) : '';
  box.textContent = '';
  if (rest) {
    const word = document.createElement('span'); word.className = 'shimmer'; word.textContent = 'Thinking';
    box.append(word, document.createTextNode(rest));
  } else box.textContent = text;
  setIcon($('loading-icon'), icon, 17);
  $('loading-icon').classList.toggle('spin', icon === 'spinner-gap' || icon === 'circle-notch');
  $('loading').hidden = false;
}
// One line for the step that is running right now. It says what is happening in the present tense
// and disappears when the step finishes, where it becomes a past-tense entry in the timeline.
function currentAction(label) {
  const existing = $('current-action');
  if (!label) { existing?.remove(); return; }
  if (existing) existing.replaceChildren(phosphor('spinner-gap', 11), document.createTextNode(` ${label}`));
  else { const row = document.createElement('div'); row.id = 'current-action'; row.className = 'message current'; row.replaceChildren(phosphor('spinner-gap', 11), document.createTextNode(` ${label}`)); $('steps').append(row); }
  $('current-action').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function recordActivity(action, url, result, elapsed, failure, meta = {}) {
  if (!chat) return;
  const message = {
    role: 'activity', type: action.type, text: action.description || '',
    elapsed: elapsed || 0, failure: failure || '', changed: meta.changed, fallback: meta.fallback, page: url,
    input: action.type === 'type' ? action.text : undefined, submit: action.submit,
    opened: meta.opened,
    destination: action.type === 'navigate' ? action.url : undefined,
    excerpt: action.type === 'read' ? String(result?.text || '').slice(0, 400) : undefined
  };
  chat.messages.push({ ...message, at: Date.now() });
  $('steps').querySelector('.welcome')?.remove();
  const el = renderMessage(message);
  $('steps').append(el);
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  persist().catch(() => {});
}
// How long the model thought, written once the answer is in. The shimmer is for the wait only.
function thoughtFor(elapsed) {
  const value = Number(elapsed) || 0;
  if (value >= 1000) return `Thought for ${(value / 1000).toFixed(2)}s`;
  return `Thought for ${Math.max(1, Math.round(value))}ms`;
}
function textHash(text) { const value = String(text || ''); let hash = 0; for (let i = 0; i < value.length; i += 5) hash = (hash * 31 + value.charCodeAt(i)) | 0; return `${value.length}:${hash}`; }
function riskyAction(action) {
  if (action.type === 'type' && /password|passcode|card number|cvv|ssn|iban|passport/i.test(action.text || '')) return 'typing sensitive-looking data';
  const text = `${action.description || ''} ${action.text || ''}`;
  const hit = text.match(RISK);
  return hit ? `“${(action.description || action.text || action.type).slice(0, 60)}” looks irreversible` : '';
}
function describe(action, queued) {
  const extra = [
    action.type === 'type' ? `\nText: ${action.text}${action.submit ? ' (then Enter)' : ''}` : '',
    action.type === 'write' ? `\nBrief: ${action.brief}${action.replace ? '\nReplaces what is already in the field' : ''}` : '',
    action.type === 'navigate' ? `\nDestination: ${action.url}` : '',
    action.type === 'scroll' ? `\nDirection: ${action.direction}` : '',
    action.type === 'wait' ? `\nWait: ${action.seconds}s` : '',
    action.type === 'key' ? `\nKey: ${action.key}` : '',
    queued ? `\n+${queued} more action${queued === 1 ? '' : 's'} queued to run back to back` : ''
  ].join('');
  return `${action.type.toUpperCase()}: ${action.description || 'Review the proposed action.'}${extra}`;
}
function showProposal(run, action, queued, quiet = false) {
  proposal = { tabId: run.view.tabId, url: run.view.url, width: run.view.width, height: run.view.height, action: { ...action } };
  const coordinate = ['click', 'type'].includes(action.type);
  $('marker').hidden = !coordinate;
  if (coordinate && run.view.naturalWidth) {
    $('marker').style.left = `${action.x / run.view.naturalWidth * 100}%`;
    $('marker').style.top = `${action.y / run.view.naturalHeight * 100}%`;
    proposal.action.x = action.x / run.view.naturalWidth * run.view.width;
    proposal.action.y = action.y / run.view.naturalHeight * run.view.height;
  }
  $('proposal').textContent = describe(action, queued);
  if (!quiet) { $('approval').hidden = false; $('loading').hidden = true; }
  return proposal;
}

async function next(run, prefetched) {
  if (workflow !== run) return;
  flushTiming(run);
  if (run.steps.length >= STEP_LIMIT) { pushMessage('note', `Stopped at the ${STEP_LIMIT}-action limit. Start a new chat to keep going.`); stop(); return; }
  await listTabs().catch(() => {});
  const acting = tabCache.find(t => t.id === run.actingTabId) || tabCache.find(t => t.active) || tabCache[0];
  if (!acting) throw new Error('No open tab found. Open a webpage first.');
  if (!acting.supported) throw new Error('The acting tab is not supported. Pick an HTTPS page — Chrome internal pages are blocked.');
  run.actingTabId = acting.id;
  // Context tabs keep the order the user attached them in, so the numbering the model gets last round still means the same tab.
  const contexts = run.contextIds.map(id => tabCache.find(t => t.id === id)).filter(t => t && t.id !== acting.id && t.supported).slice(0, 5);
  try { await permission(); }
  catch (e) { if (workflow !== run) return; halt(run, e.message); return; }
  // A first round arrives with an observation already in hand, taken next to the planner: that read is
  // not separately attributable, so it is recorded as unknown rather than as zero.
  let shot = prefetched, observeMs = null;
  if (!shot) {
    const readStart = performance.now();
    loading(`Reading ${shortTitle(acting)}`, 'eye');
    shot = await timed(send('observe', { tabId: acting.id, stayPut }), OBSERVE_TIMEOUT, `Reading ${shortTitle(acting)} took too long — the tab may be stuck or closed.`);
    observeMs = Math.round(performance.now() - readStart);
    if (workflow !== run) return;
  }
  const hash = textHash(shot.text);
  run.stalled = hash === run.lastHash ? (run.stalled || 0) + 1 : 0;
  run.apiRetries = 0;
  run.lastHash = hash;
  const read = await Promise.all(contexts.map(t => timed(send('context', { tabId: t.id }), 15000, 'The context tab did not answer.').then(c => c.text ? { id: t.id, url: c.url, title: c.title, text: c.text.slice(0, 12000) } : null).catch(() => null)));
  const extra = read.filter(Boolean).map(c => ({ url: c.url, title: c.title, text: c.text }));
  // A switch action names a tab by its position in this list, so the mapping must match the payload exactly.
  run.contextTabs = read.filter(Boolean).map(c => c.id);
  run.warned = run.warned || [];
  for (const [index, tab] of contexts.entries()) {
    if (read[index] || run.warned.includes(tab.id)) continue;
    run.warned.push(tab.id);
    pushMessage('note', `Could not read ${shortTitle(tab)} as context — it may have been closed or asleep.`);
  }
  let refs = Array.isArray(shot.refs) ? shot.refs : [];
  // Vision is a fallback, not the default. A screenshot costs a paint, an encode, image tokens and a
  // slower round; the tree alone is enough for almost every page, so one is captured only when the
  // tree is too thin to act on, or when the model asked to see the page after working from the DOM.
  if (run.wantShot || refs.length < 6) {
    if (!shot.image) {
      const lookStart = performance.now();
      loading(`Looking at ${shortTitle(acting)}`, 'eye');
      shot = { ...shot, ...(await timed(send('observe', { tabId: acting.id, stayPut, shot: true }), OBSERVE_TIMEOUT, `Looking at ${shortTitle(acting)} took too long.`)) };
      if (observeMs !== null) observeMs += Math.round(performance.now() - lookStart);
      if (workflow !== run) return;
      refs = Array.isArray(shot.refs) ? shot.refs : [];
    }
    if (!run.looked) {
      run.looked = true;
      pushMessage('note', refs.length < 6 ? 'This page had almost no readable controls, so I looked at it as an image this round.' : 'I asked to see the page, so this round includes a screenshot.');
    }
  }
  const width = shot.width || 1, height = shot.height || 1;
  const image = $('screenshot');
  let naturalWidth = width, naturalHeight = height;
  if (shot.image) {
    image.src = `data:image/jpeg;base64,${shot.image}`; await image.decode();
    naturalWidth = image.naturalWidth || width; naturalHeight = image.naturalHeight || height;
    lastShot = `data:image/jpeg;base64,${shot.image}`;
    $('saw-image').src = lastShot; $('saw-btn').hidden = false;
    chrome.storage.local.set({ lastShot }).catch(() => {});
  }
  const scale = naturalWidth / width;
  const elements = (shot.elements || []).map(el => ({ role: el.role, name: el.name, x: Math.round(el.x * scale), y: Math.round(el.y * scale), off: el.off, state: el.state }));
  // The DOM line: what this round could read, printed before the model is asked anything.
  if (run.lastFound !== refs.length) {
    run.lastFound = refs.length;
    pushMessage('inspect', `Found ${refs.length} accessible element${refs.length === 1 ? '' : 's'}`);
  }
  const tabs = tabList(run).filter(({ tab }) => tab.supported).map(({ token, tab }) => ({ id: token, title: shortTitle(tab), url: tab.url, acting: tab.id === acting.id, context: run.contextIds.includes(tab.id), opened: (run.opened || []).includes(tab.id) }));
  run.view = { tabId: shot.tabId, url: shot.url, width, height, naturalWidth, naturalHeight };
  const done = plan.filter(item => item.done).length;
  loading(plan.length ? `Thinking · ${done}/${plan.length} plan steps · action ${run.steps.length + 1}/${STEP_LIMIT}` : `Thinking about action ${run.steps.length + 1}`, 'sparkle');
  const sendImage = !!shot.image;
  // Every field is normalised here, because the Worker's only answer to a bad one is a 400 that the
  // panel cannot explain. Context tabs belong in this body: dropping them silently cost attachments.
  const body = { goal:aimed(run), speed, intent:[run.goal, ...plan.map(item => item.title)].join('\n'), todos:plan, steps:run.steps.slice(-60), url:shot.url, title:shot.title, text:String(shot.text || ''), ...(sendImage ? { image: shot.image } : {}), width:Math.max(1, Math.round(Number(naturalWidth) || width)), height:Math.max(1, Math.round(Number(naturalHeight) || height)), elements, refs, tabs, contexts:extra, memory: run.memory || undefined, stalled:run.stalled, automatic:run.mode === 'autopilot', correction: run.correction || undefined };
  // Serialised once and sent verbatim, so the byte count below is the payload the Worker really gets.
  const payload = JSON.stringify(body);
  run.timing = { at: Date.now(), round: run.steps.length + 1, goal: run.goal.slice(0, 80), speed, refs: refs.length, image: sendImage, bytes: new TextEncoder().encode(payload).length, observeMs, actionMs: 0, actions: 0, settle: settleFor() };
  const started = performance.now();
  const answer = await api('/agent', payload);
  const apiMs = Math.round(performance.now() - started);
  const { actions, action, completed, incomplete, memory, needScreenshot, ms, tokens, model } = answer;
  // The Worker's own timing is the model call; the rest of the round trip is transport.
  Object.assign(run.timing, { modelMs: Number(ms) || 0, netMs: Math.max(0, apiMs - (Number(ms) || 0)), model: model || '', tokens: tokens || null });
  if (memory) run.memory = memory;
  run.correction = '';
  if (needScreenshot && !run.wantShot) { if (run.timing) run.timing.screenshotAsked = true; run.wantShot = true; return next(run); }
  run.wantShot = false;
  const elapsed = ms ?? Math.round(performance.now() - started);
  if (workflow !== run) return;
  pushMessage('thought', thoughtFor(elapsed));
  if (applyCompleted(run, completed)) persist().catch(() => {});
  if (run.unproven) { pushMessage('note', `${run.unproven} plan step${run.unproven === 1 ? '' : 's'} were claimed done without a verified action, so the tick waits until the work is proven.`); run.unproven = 0; }
  const batch = Array.isArray(actions) && actions.length ? actions : (action ? [action] : []);
  const finish = batch.find(item => item.type === 'done');
  if (finish) {
    if (incomplete?.length && run.mode !== 'manual' && (run.keepGoing || 0) < 4) {
      const titles = plan.filter(item => incomplete.includes(item.id)).map(item => item.title);
      run.keepGoing = (run.keepGoing || 0) + 1;
      pushMessage('note', `${titles.length} plan step${titles.length === 1 ? '' : 's'} still open (${titles.join(' · ')}), so I’ll keep going instead of finishing.`);
      $('loading').hidden = true;
      return next(run);
    }
    return finalCheck(run, finish.summary || '', incomplete || []);
  }
  run.queue = batch.slice();
  const risky = run.queue.map(riskyAction).find(Boolean) || '';
  showProposal(run, run.queue[0], run.queue.length - 1, run.mode === 'autopilot' || (run.mode === 'auto' && !risky));
  if (run.mode === 'autopilot' || (run.mode === 'auto' && !risky)) {
    $('approval').hidden = true;
    if (risky) pushMessage('note', `Auto mode paused this step because ${risky}.`);
    await runBatch(run);
  } else {
    $('approval').hidden = false; $('loading').hidden = true;
    notify(risky ? `Paused before this round because ${risky}. Approve to continue.` : 'Review the queued actions before they run.');
  }
}
async function runBatch(run) {
  while (run.queue.length && workflow === run) {
    const action = run.queue.shift();
    const outcome = await executeOne(run, showProposal(run, action, run.queue.length, true));
    if (outcome === 'recover') { await sleep(pace()); if (workflow === run) await safeNext(run); return; }
    if (outcome !== 'ok') {
      // Recover in place: re-observe and let the model pick a different route before giving up.
      if (outcome === 'failed' && run.mode !== 'manual' && (run.hardFails || 0) < 2) {
        run.hardFails = (run.hardFails || 0) + 1;
        pushMessage('note', 'That step kept failing, so I’ll look at the page again and try a different route.');
        await sleep(pace() * 2);
        if (workflow === run) await safeNext(run);
        return;
      }
      halt(run, 'Stopped where the page would not accept the action. The task is back in the box to retry.');
      return;
    }
    if (run.queue.length) { loading('Next queued action', '◌'); await sleep(Math.round(pace() / 2)); }
  }
  if (workflow !== run) return;
  loading('Waiting for the page', '◌');
  await sleep(pace());
  if (workflow !== run) return;
  await safeNext(run);
}
async function safeNext(run) {
  try { await next(run); }
  catch (e) {
    if (workflow !== run) return;
    if (run.mode !== 'manual' && (run.apiRetries || 0) < 2) {
      run.apiRetries = (run.apiRetries || 0) + 1;
      pushMessage('note', `${e.message} Retrying with a fresh look at the page.`);
      await sleep(pace() * 2);
      if (workflow === run) return safeNext(run);
      return;
    }
    halt(run, e.message || 'Could not continue.');
  }
}
/* ---------- tabs as tools ---------- */
const webTarget = value => { try { const url = new URL(value); if (url.username || url.password) return null; return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)) ? url.href : null; } catch { return null; } };
// Tab ids stay stable for the whole run, so a t2 the model learned in round one still means the same tab.
function tabList(run) {
  run.tokens = run.tokens || {}; run.tokenSeq = run.tokenSeq || 0;
  const seen = new Map(Object.entries(run.tokens).map(([token, id]) => [id, token]));
  return tabCache.map(tab => {
    let token = seen.get(tab.id);
    if (!token) { run.tokenSeq += 1; token = `t${run.tokenSeq}`; run.tokens[token] = tab.id; }
    return { token, tab };
  });
}
function tabByToken(run, token) {
  const tab = tabCache.find(item => item.id === run.tokens?.[token]);
  if (!tab) throw new Error(`Tab ${token} is closed or no longer listed. Check the TABS list and pick another.`);
  return tab;
}
async function waitForTab(tabId, timeout = 9000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return null;
    if (tab.status === 'complete') return tab;
    await sleep(220);
  }
  return chrome.tabs.get(tabId).catch(() => null);
}
// One tab acts at a time, but the agent can move between tabs without losing the page it was on.
// That is what makes research in a new tab, then acting back in the original, a single run.
async function actOnTabs(run, action) {
  if (action.type === 'open') {
    const url = webTarget(action.url) || (action.query ? webTarget(`https://duckduckgo.com/?q=${encodeURIComponent(String(action.query).slice(0, 200))}`) : null);
    if (!url) throw new Error('That address is not an HTTPS page.');
    if ((run.opened || []).length >= 3) throw new Error('This task already opened three tabs. Use one of them, or focus a tab the user already has.');
    currentAction(`Waiting for the new tab to load`);
    const tab = await chrome.tabs.create({ url, active: !stayPut });
    await waitForTab(tab.id);
    run.opened = [...(run.opened || []), tab.id];
    run.actingTabId = tab.id;
    send('group', { tabId: tab.id }).catch(() => {});
    run.allow = [...new Set([...run.allow, new URL(url).origin])];
    pushMessage('note', stayPut ? `Opened ${hostOf(url)} in a new tab.` : `Opened ${hostOf(url)} in a new tab and switched to it.`);
    return { url, title: tab.title || hostOf(url), effect: { verified: true } };
  }
  if (action.type === 'switch') {
    const tab = tabByToken(run, action.tab);
    if (!tab.supported) throw new Error('That tab is a Chrome page the agent cannot drive. Pick another from the TABS list.');
    const previous = run.actingTabId;
    if (!stayPut) { await chrome.tabs.update(tab.id, { active: true }); await sleep(320); }
    run.actingTabId = tab.id;
    // The tab it just left becomes readable context, which is what strings one run across tabs.
    run.contextIds = [...new Set([...run.contextIds, previous])].filter(id => id !== tab.id).slice(0, 5);
    if (tab.url) run.allow = [...new Set([...run.allow, new URL(tab.url).origin])];
    pushMessage('note', `Now working in ${shortTitle(tab)}.`);
    return { url: tab.url, effect: { verified: true } };
  }
  if (action.type === 'gather') {
    const fallback = tabList(run).filter(({ tab }) => tab.id !== run.actingTabId && tab.supported).map(({ token }) => token);
    const tokens = [...new Set(action.tabs?.length ? action.tabs : fallback)].slice(0, 5);
    if (!tokens.length) throw new Error('There is no other tab to gather from yet. Open one first.');
    const pages = [];
    for (const token of tokens) {
      const tab = tabByToken(run, token);
      if (!tab.supported) continue;
      const page = await send('context', { tabId: tab.id }).catch(() => null);
      if (page?.text) pages.push(`— ${shortTitle(tab)} (${hostOf(tab.url)})\n${String(page.text).slice(0, 4000)}`);
    }
    if (!pages.length) throw new Error('Those tabs had no readable text. Let them load, then gather again.');
    pushMessage('note', `Read ${pages.length} tab${pages.length === 1 ? '' : 's'} at once.`);
    return { text: pages.join('\n\n'), effect: { verified: true } };
  }
  const tab = tabByToken(run, action.tab);
  if (!(run.opened || []).includes(tab.id)) throw new Error('Only a tab this task opened can be closed.');
  await chrome.tabs.remove(tab.id).catch(() => {});
  run.opened = run.opened.filter(id => id !== tab.id);
  if (run.actingTabId === tab.id) run.actingTabId = tabCache.find(item => item.id === run.homeTabId)?.id || tabCache.find(item => item.id !== tab.id)?.id || null;
  pushMessage('note', `Closed the tab for ${hostOf(tab.url)}.`);
  return { effect: { verified: true } };
}
async function executeOne(run, current) {
  if (!current || workflow !== run) return 'stop';
  const action = current.action;
  loading(LABELS[action.type] || 'Working', ICONS[action.type] || 'sparkle');
  currentAction(activeLabel(action));
  proposal = null;
  const actionStart = performance.now();
  let result;
  try {
    if (action.type === 'navigate') {
      const origin = new URL(action.url).origin;
      if (!run.allow.includes(origin)) {
        // Following the goal to another site is progress, not a reason to stop.
        run.allow = [...run.allow, origin];
        if (run.mode === 'manual') await permission(action.url).catch(() => {});
        pushMessage('note', `Extended this task to ${new URL(action.url).hostname}.`);
      }
    }
    result = TAB_STEPS.has(action.type) ? await actOnTabs(run, action) : await send('act', { ...current, settleMs: settleFor(), stayPut, goal: run.goal, intent: [run.goal, ...plan.map(item => item.title)].join('\n'), allow: run.allow, automatic: run.mode === 'autopilot' });  }
  catch (error) {
    noteActionMs(run, actionStart, action.type);
    if (workflow !== run) return 'stop';
    // A rate-limited write or click is also just a pause: wait out the window, then look again.
    if (isRateLimit(error.status, error.message) && cooldowns < COOLDOWN_LIMIT) { await cooldown(); return 'recover'; }
    if (error.code === 'PAGE_CHANGED' && (run.recovered || 0) < 2) { run.recovered = (run.recovered || 0) + 1; notify('The page shifted while acting. Re-reading it and trying again.'); return 'recover'; }
    run.steps.push({ type: action.type, description: action.description || '', ok: false, changed: false, code: error.code || 'ERROR', note: error.message, page: current.url, ref: action.ref, x: current.action.x, y: current.action.y, url: action.url, direction: action.direction, text: action.type === 'type' ? action.text : undefined });
    recordActivity(action, current.url, {}, 0, `${error.message}${error.code ? ` [${error.code}]` : ''}`);
    currentAction(null);
    const label = `${error.message}${error.code ? ` (${error.code})` : ''}`;
    // A failed step is feedback for the model, not the end of the run.
    if (run.mode !== 'manual' && (run.retries || 0) < 3) {
      run.retries = (run.retries || 0) + 1;
      notify(`${label}. Trying a different approach instead of stopping.`, true);
      return 'recover';
    }
    notify(`${label} Trying a different approach instead of ending the run.`, true);
    return 'failed';
  }
  if (workflow !== run) return 'stop';
  noteActionMs(run, actionStart, action.type);
  if (result?.notice) pushMessage('note', result.notice);
  if (result?.generated) pushMessage('note', `Gemini wrote ${Number(result.generated).toLocaleString()} characters into the field.`);
  const verified = result?.effect?.verified;
  const changed = verified !== false;
  if (changed) { run.evidence = (run.evidence || 0) + 1; run.stalled = 0; run.recovered = 0; run.retries = 0; run.lastHash = ''; run.apiRetries = 0; }
  else run.stalled = (run.stalled || 0) + 1;
  const note = ['read', 'gather'].includes(action.type) && result?.text ? `page excerpt: ${String(result.text).slice(0, 1500)}` : '';
  run.steps.push({ type: action.type, description: action.description || '', ok: true, changed, page: current.url, note, code: result?.code || '', ref: action.ref, x: current.action.x, y: current.action.y, url: action.url, direction: action.direction, text: action.type === 'type' ? action.text : undefined });
  recordActivity(action, result?.url || current.url, result, 0, null, { changed, fallback: !!result?.fallback, opened: action.type === 'open' ? { url: result?.url, title: result?.title } : undefined });
  currentAction(null);
  return 'ok';
}
async function startWorkflow(goal, skill) {
  await listTabs().catch(() => {});
  const acting = tabCache.find(t => t.id === actingTabId) || tabCache.find(t => t.active) || tabCache[0];
  if (!acting) throw new Error('Open a webpage first.');
  await permission(acting.url);
  if (!chat) { chat = newChatRecord(); chats.unshift(chat); }
  // A clicked or named skill wins; otherwise a Google page plus summarising words picks it up by itself.
  const chosen = skill || builtinFor(acting.url, goal);
  chat.goal = goal; chat.title = goal.slice(0, 60);
  workflow = { goal, skill: chosen || null, steps: [], mode, actingTabId: acting.id, homeTabId: acting.id, contextIds: [...contextIds], opened: [], tokens: {}, tokenSeq: 0, stalled: 0, lastHash: '', queue: [], evidence: 0, unproven: 0, recovered: 0, retries: 0, apiRetries: 0, keepGoing: 0, allow: [new URL(acting.url).origin], memory: null, wantShot: false, contextTabs: [], warned: [] };  const run = workflow;
  plan = [];
  pushMessage('user', goal);
  if (chosen) pushMessage('note', `Using the built-in “${chosen.name}” skill for this page.`);
  $('goal').value = ''; grow();
  renderSkillChip();
  $('suggest').hidden = true;
  $('start').hidden = true; $('stop').hidden = false; $('goal').disabled = true;
  loading('Reading the page', 'eye');
  try {
    const observed = timed(send('observe', { tabId: acting.id, stayPut }), OBSERVE_TIMEOUT, 'Reading the page took too long — the tab may be stuck or closed.');
    if (planMode === 'never') {
      const shot = await observed;
      if (workflow !== run) return;
      pushMessage('note', 'No checklist for this one — running it directly.');
      await next(run, shot);
      return;
    }
    // A slow planner must not hold the whole run on "Reading the page": it gets a short budget and the
    // page work starts with or without a checklist.
    const [planned, shot] = await Promise.allSettled([timed(api('/plan', { goal: aimed(run), url: acting.url, title: acting.title }), PLAN_TIMEOUT, 'The planner did not answer in time.'), observed]);
    if (workflow !== run) return;
    if (shot.status === 'rejected') throw shot.reason;
    if (planned.status === 'fulfilled' && planned.value.todos?.length) plan = planned.value.todos;
    else if (planMode === 'always') plan = [{ id: '1', title: goal.slice(0, 140), done: false }];
    else if (planned.status === 'rejected') pushMessage('note', 'No checklist this time — the planner was slow, so I went straight to the page.');
    else pushMessage('note', 'This task is short enough to run without a checklist.');
    renderPlan();
    persist().catch(() => {});
    await next(run, shot.value);
  } catch (e) {
    if (workflow !== run) return;
    $('loading').hidden = true;
    throw e;
  }
}

/* ---------- composer & palette ---------- */
const COMMANDS = [
  { cmd: '/new', hint: 'Start a fresh chat', run: () => newChat() },
  { cmd: '/chats', hint: 'Open chat history', run: () => openHistory() },
  { cmd: '/export', hint: 'Download this chat as Markdown', run: () => exportChat() },
  { cmd: '/plan', hint: 'Always write a checklist first', run: () => setPlanMode('always') },
  { cmd: '/noplan', hint: 'Skip the checklist', run: () => setPlanMode('never') },
  { cmd: '/auto-plan', hint: "Let the agent decide about a checklist", run: () => setPlanMode('auto') },
  { cmd: '/skill', hint: 'Save this run as a reusable skill', run: () => saveSkill().catch(e => notify(e.message || 'Could not save the skill.', true)) },
  { cmd: '/saw', hint: 'Show the screenshot behind the last step', run: () => openSaw() },
  { cmd: '/timings', hint: 'Show what a round costs', run: () => showTimings() },
  { cmd: '/stop', hint: 'Stop the running workflow', run: () => { stop(); notify('Workflow stopped.'); } }
];
function setPlanMode(value) { planMode = value; chrome.storage.local.set({ planMode }); notify(value === 'always' ? 'Every task will get a checklist.' : value === 'never' ? 'Tasks will run without a checklist.' : 'The agent decides whether a checklist helps.'); }
// Built-in skills. They are not stored with the distilled ones: they are matched from the page the
// user is on, so "summarize this" on a Google doc needs no setup at all.
const BUILTIN_SKILLS = [{
  id: 'summarize-google',
  name: 'Summarize with Gemini',
  description: 'Summarize this Google doc, sheet, thread or results page',
  hosts: ['docs.google.com', 'drive.google.com', 'sheets.google.com', 'slides.google.com', 'mail.google.com', 'google.com'],
  triggers: /\b(summar\w*|tl;?dr|key ?points|recap|digest|bullet ?points|main ideas)\b/i,
  defaultGoal: 'Summarize this page',
  prompt: 'Summarize what is on this page. The page text in the observation is the source; use read once only if it is missing or cut off. Finish with a done action whose summary is the answer: one sentence with the main point, then 3 to 5 short key points on their own lines. Do not click, type into, edit, reformat or write into the page — the summary belongs in the chat.'
}];
const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
// Host decides which skill a page offers; the wording decides whether an ordinary goal picks it up.
function builtinFor(url, goal = '') {
  const host = hostOf(url);
  if (!host) return null;
  if (goal && !BUILTIN_SKILLS.some(skill => skill.triggers.test(goal))) return null;
  return BUILTIN_SKILLS.find(skill => skill.hosts.includes(host)) || null;
}
const aimed = run => run.skill ? `${run.skill.prompt}\n\nUSER GOAL: ${run.goal}` : run.goal;
function renderSkillChip() {
  const chip = $('skill-chip');
  const tab = tabCache.find(t => t.id === actingTabId) || tabCache.find(t => t.active);
  const skill = !workflow && tab?.supported ? builtinFor(tab.url) : null;
  if (!skill) { chip.hidden = true; return; }
  const button = $('skill-run');
  button.textContent = skill.name;
  button.title = skill.description;
  button.onclick = () => { if (workflow) return; $('goal').value = skill.defaultGoal; grow(); $('composer').requestSubmit(); };
  chip.hidden = false;
}
async function saveSkill() {
  const steps = (workflow ? workflow.steps : chat?.steps) || [];
  const goal = workflow ? workflow.goal : (chat?.goal || '');
  if (!steps.length) throw new Error('Run a task first, then save it as a skill.');
  const { skill } = await api('/skill', { goal, steps });
  skills = [{ ...skill, at: Date.now() }, ...skills].slice(0, 20);
  await chrome.storage.local.set({ skills });
  notify(`Saved “${skill.name}”. Type / to run it.`);
}
function openHistory() { renderHistory(); if (!$('history-dialog').open) $('history-dialog').showModal(); }
function openSaw() { if (!lastShot) { notify('No screenshot yet — run a task first.', true); return; } $('saw-image').src = lastShot; if (!$('saw-dialog').open) $('saw-dialog').showModal(); }
function hideSuggest() { $('suggest').hidden = true; $('suggest').textContent = ''; }
function renderSuggest() {
  const value = $('goal').value;
  const box = $('suggest');
  const slash = value.match(/(?:^|\s)\/([a-z-]*)$/i);
  const at = value.match(/(?:^|\s)@([^\s@]*)$/i);
  let items = [];
  if (slash) items = [
    ...COMMANDS.filter(command => command.cmd.startsWith('/' + slash[1].toLowerCase())).map(command => ({ label: command.cmd, hint: command.hint, apply: () => { $('goal').value = ''; command.run(); hideSuggest(); } })),
    ...skills.filter(skill => ('/' + skill.name).toLowerCase().replace(/[^a-z0-9/]+/g, '-').startsWith('/' + slash[1].toLowerCase())).map(skill => ({ label: '/' + skill.name, hint: skill.description || 'Run a saved skill', apply: () => { $('goal').value = skill.prompt || (skill.steps || []).join(' → '); hideSuggest(); notify('Skill loaded — send the message to run it.'); } })),
    ...BUILTIN_SKILLS.filter(skill => ('/' + skill.name).toLowerCase().replace(/[^a-z0-9/]+/g, '-').startsWith('/' + slash[1].toLowerCase())).map(skill => ({ label: '/' + skill.name, hint: skill.description, apply: () => { $('goal').value = skill.defaultGoal; grow(); hideSuggest(); notify(`Skill loaded — send it to run “${skill.name}”.`); } }))
  ];
  else if (at) items = tabCache.filter(tab => tab.supported && tab.id !== actingTabId && `${shortTitle(tab)} ${tab.url} ${hostOf(tab.url)}`.toLowerCase().includes(at[1].toLowerCase())).slice(0, 6).map(tab => ({ label: `@${shortTitle(tab)}`, hint: `Add ${hostOf(tab.url)} as context`, apply: () => { contextIds = [...new Set([...contextIds, tab.id])].slice(0, 5); renderTabs(); $('goal').value = value.replace(/(?:^|\s)@([^\s@]*)$/i, '').trim(); notify(`Added ${shortTitle(tab)} as context.`); hideSuggest(); } }));
  box.textContent = '';
  if (!items.length) { hideSuggest(); return; }
  for (const item of items) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'suggest-item'; button.setAttribute('role', 'option');
    const label = document.createElement('strong'); label.textContent = item.label;
    const hint = document.createElement('span'); hint.textContent = item.hint;
    button.append(label, hint); button.addEventListener('click', item.apply);
    box.append(button);
  }
  box.hidden = false;
}
$('composer').addEventListener('submit', async event => {
  event.preventDefault();
  if (workflow) return;
  const goal = $('goal').value.trim();
  if (!goal) return;
  if (goal.length > 4000) { notify('Keep your task under 4,000 characters.', true); return; }
  hideSuggest();
  try { await startWorkflow(goal); } catch (e) { notify(e.message || 'Something went wrong.', true); }
});
$('goal').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('composer').requestSubmit(); } });
$('goal').addEventListener('input', () => { grow(); renderSuggest(); });
$('goal').addEventListener('blur', () => setTimeout(hideSuggest, 150));
$('new-chat').addEventListener('click', () => { newChat().catch(e => notify(e.message || 'Could not start a chat.', true)); });
$('history-btn').addEventListener('click', openHistory);
$('history-close').addEventListener('click', event => { event.preventDefault(); $('history-dialog').close(); });
$('saw-btn').addEventListener('click', openSaw);
$('saw-close').addEventListener('click', event => { event.preventDefault(); $('saw-dialog').close(); });
$('history-export').addEventListener('click', exportChat);
$('history-clear').addEventListener('click', async () => {
  if (!confirm('Delete every stored chat in this browser?')) return;
  const keep = workflow ? workflow : null;
  chats = keep ? chats.filter(item => item === chat) : [];
  if (!chats.length) { chat = null; await newChat(); }
  renderHistory();
  notify('Chat history cleared.');
});
$('settings-btn').addEventListener('click', () => { if (!$('settings-dialog').open) $('settings-dialog').showModal(); });
$('settings-close').addEventListener('click', event => { event.preventDefault(); $('settings-dialog').close(); });
$('settings-dialog').addEventListener('click', event => { if (event.target === $('settings-dialog')) $('settings-dialog').close(); });
$('history-dialog').addEventListener('click', event => { if (event.target === $('history-dialog')) $('history-dialog').close(); });
$('saw-dialog').addEventListener('click', event => { if (event.target === $('saw-dialog')) $('saw-dialog').close(); });
$('plan-clear').addEventListener('click', () => { if (workflow) return; plan = []; renderPlan(); persist().catch(() => {}); });
task('approve', async () => { const run = workflow; if (!run) throw new Error('Start a task first.'); if (!run.queue?.length) throw new Error('Nothing queued — send a message to continue.'); if (run.queue[0]?.type === 'navigate') await permission(run.queue[0].url); if (workflow !== run) return; $('approval').hidden = true; await runBatch(run); });
$('tabs-refresh').addEventListener('click', async () => { try { await listTabs(); } catch (e) { notify(e.message || 'Could not list tabs.', true); } });
$('tabs-current').addEventListener('click', async () => { try { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (!tab?.id) throw new Error('Select a webpage first.'); actingTabId = tab.id; contextIds = contextIds.filter(id => id !== tab.id); renderTabs(); await permission(tab.url); } catch (e) { notify(e.message || 'Something went wrong.', true); } });
$('reject').addEventListener('click', () => { stop(); notify('Stopped without taking the proposed action.'); });
$('stop').addEventListener('click', () => { stop(); notify('Workflow stopped. An action already in progress may still finish.'); });
$('worker').addEventListener('change', async () => { await chrome.storage.local.set({ worker: $('worker').value.trim().replace(/\/$/, '') }); });
$('bridge-toggle').addEventListener('change', async () => { try { const out = await send('bridge', { on: $('bridge-toggle').checked }); notify(out.connected ? 'Bridge on. Start node bridge/server.mjs to accept MCP clients.' : 'Bridge off.'); } catch (e) { notify(e.message || 'Could not toggle the bridge.', true); } });
$('pointer-toggle').addEventListener('change', async () => { await chrome.storage.local.set({ pointer: $('pointer-toggle').checked }); notify($('pointer-toggle').checked ? 'Pointer on: a purple cursor shows where the agent clicks.' : 'Pointer off.'); });
$('speed').addEventListener('change', async () => {
  const value = $('speed').value;
  speed = Object.prototype.hasOwnProperty.call(PACING, value) ? value : 'fast';
  await chrome.storage.local.set({ speed });
  notify(`Speed: ${speed}. This applies from the next action.`);
});
$('slow-toggle').addEventListener('change', async () => {
  slowPages = $('slow-toggle').checked;
  await chrome.storage.local.set({ slowPages });
  notify(slowPages ? 'Waiting up to four seconds for a slow menu before calling an action a failure.' : 'Deciding quickly. A slow menu may look like a failed click.');
});
$('stay-toggle').addEventListener('change', async () => {
  stayPut = $('stay-toggle').checked;
  await chrome.storage.local.set({ stayPut });
  notify(stayPut ? 'Working in the background — switch tabs freely.' : 'Switching to the working tab before each action.');
});
chrome.runtime.onMessage.addListener(message => { if (message && message.type === 'pointerBlocked') notify('Pointer is on, but this page blocks the cursor overlay — the click still went ahead.', true); });

(async () => {
  const saved = await chrome.storage.local.get(['worker', 'chats', 'activeChat', 'planMode', 'lastShot', 'skills', 'bridge', 'pointer', 'speed', 'slowPages', 'stayPut', 'timings']);
  $('worker').value = saved.worker || 'https://webagent.amos-donn.workers.dev';
  skills = Array.isArray(saved.skills) ? saved.skills : [];
  $('bridge-toggle').checked = saved.bridge === true;
  $('pointer-toggle').checked = saved.pointer !== false;
  speed = Object.prototype.hasOwnProperty.call(PACING, saved.speed) ? saved.speed : 'fast';
  slowPages = saved.slowPages === true;
  $('speed').value = speed;
  $('slow-toggle').checked = slowPages;
  stayPut = saved.stayPut !== false;
  $('stay-toggle').checked = stayPut;
  planMode = ['auto', 'always', 'never'].includes(saved.planMode) ? saved.planMode : 'auto';
  lastShot = saved.lastShot || '';
  $('saw-btn').hidden = !lastShot;
  timings = Array.isArray(saved.timings) ? saved.timings : [];
  chats = Array.isArray(saved.chats) ? saved.chats : [];
  chat = chats.find(item => item.id === saved.activeChat) || chats[0] || newChatRecord();
  if (!chats.includes(chat)) chats.unshift(chat);
  plan = chat.plan || [];
  renderChat(); renderPlan();
  if (chat.messages?.length) notify('Restored your last chat. Send a message to keep going, or start a new one.');
  listTabs().catch(() => { $('tabs-label').textContent = 'Could not list tabs.'; });
})();
