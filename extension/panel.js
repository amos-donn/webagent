const $ = id => document.getElementById(id);
const ICONS = { think:'sparkle', click:'cursor-click', type:'keyboard', write:'sparkle', read:'book-open-text', scroll:'arrows-down-up', wait:'hourglass', navigate:'arrow-right', key:'key-return', switch:'arrow-right', open:'plus', gather:'book-open-text', close:'x', select:'arrows-down-up', secret:'keyboard', transcribe:'book-open-text' };
// Two names per step: what it is doing while it runs, and what it did once it finished. The
// timeline keeps the past tense because it is a record of work, not a spinner that vanished.
const VERBS = {
  think: ['Thinking', 'Thought'], click: ['Clicking', 'Clicked'], type: ['Typing', 'Typed'],
  write: ['Writing with Gemini', 'Wrote'], read: ['Reading the page', 'Read the page'],
  transcribe: ['Transcribing audio', 'Transcribed audio'],
  scroll: ['Scrolling', 'Scrolled'], wait: ['Waiting', 'Waited'],
  navigate: ['Opening the page', 'Opened the page'], key: ['Pressing a key', 'Pressed a key'],
  switch: ['Switching tabs', 'Switched tabs'], open: ['Opening a new page', 'Opened a new page'],
  gather: ['Reading tabs', 'Read the tabs'], close: ['Closing the tab', 'Closed the tab'],
  select: ['Choosing an option', 'Chose an option'], inspect: ['Looking at the page', 'Looked at the page']
};
const verb = (type, tense = 0) => (VERBS[type] || ['Working', 'Worked'])[tense];
const LABELS = Object.fromEntries(Object.entries(VERBS).map(([type, names]) => [type, names[0]]));
function activeLabel(action) {
  const what = String(action.description || '').trim();
  return `${verb(action.type)}${what ? `: ${what}` : ''}`;
}
const TAB_STEPS = new Set(['open', 'switch', 'gather', 'close', 'transcribe']);const STEP_LIMIT = 60;
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
let updateState = null;
let tabCache = [], actingTabId = null, contextIds = [];
// A posture of "auto" still runs on its own, but a risky-looking step is matched against the goal and
// announced in the timeline; "risky" stops before those steps and "ask" stops before every round.
// Approval posture: how much this run does without you. Stored and restored with the other settings,
// because plan mode was and this was not, and two adjacent settings that disagree is a bug people
// read as unreliability. Approval.modeFor turns it into the mode the round loop checks.
let posture = 'auto', planMode = 'auto', lastShot = '', skills = [];
// Recording state, saved macros, and the replay in flight. A replay is not a workflow: it has no
// model, no plan and no retries — it either finds the control the recording named or it stops.
let rec = null, macros = [], macroRun = null;
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
  if (!record) return null;
  run.timing = null;
  record.total = [record.observeMs, record.modelMs, record.netMs, record.actionMs].reduce((sum, value) => sum + (Number(value) || 0), 0);
  logTiming(record);
  spend(run, record);
  return record;
}
// Rounds bounce between four clocks and the model; the user waited for one task. Fold each closed
// round into the run so the total is the sum of what was actually attributed, not a guess.
function spend(run, record) {
  if (!run || !record) return;
  const total = run.spent = run.spent || { total: 0, observeMs: 0, modelMs: 0, netMs: 0, actionMs: 0, rounds: 0, tokensIn: 0, tokensOut: 0, shots: 0 };
  total.total += Number(record.total) || 0;
  for (const key of ['observeMs', 'modelMs', 'netMs', 'actionMs']) total[key] += Number(record[key]) || 0;
  total.rounds += 1;
  total.tokensIn += record.tokens?.in || 0;
  total.tokensOut += record.tokens?.out || 0;
  if (record.image) total.shots += 1;
}
// One record per task, closed on every way a run can end. Wall clock, so it includes the pauses for
// your approval and the settle windows — that is the wait being measured. Guarded by taskLogged
// because the report path closes the task before stop() runs.
function finishTask(run, status = 'done') {
  if (!run || run.taskLogged) return null;
  run.taskLogged = true;
  const endedAt = Date.now();
  const startedAt = run.taskStart || endedAt;
  const spent = run.spent || {};
  const record = {
    kind: 'task', status, chatId: run.chatId || null,
    goal: String(run.goal || '').slice(0, 80),
    startedAt, endedAt, total: Math.max(0, endedAt - startedAt),
    rounds: spent.rounds || 0, steps: (run.steps || []).length,
    observeMs: spent.observeMs || 0, modelMs: spent.modelMs || 0,
    netMs: spent.netMs || 0, actionMs: spent.actionMs || 0,
    tokensIn: spent.tokensIn || 0, tokensOut: spent.tokensOut || 0, shots: spent.shots || 0,
    speed
  };
  logTiming(record);
  return record;
}
function taskLine(record) {
  if (!record) return '';
  const parts = [`task ${elapsedLabel(record.total)}`, `${record.rounds} round${record.rounds === 1 ? '' : 's'}`];
  if (record.modelMs) parts.push(`model ${elapsedLabel(record.modelMs)}`);
  if (record.observeMs) parts.push(`read ${elapsedLabel(record.observeMs)}`);
  if (record.actionMs) parts.push(`act ${elapsedLabel(record.actionMs)}`);
  return parts.join(' · ');
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
const elapsedLabel = ms => { const value = Math.max(0, Math.round(Number(ms) || 0)); if (value >= 60000) { const minutes = Math.floor(value / 60000); return `${minutes}m ${Math.round((value % 60000) / 1000)}s`; } return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.max(1, value)}ms`; };
// One faint line per decision, under the steps it paid for: the whole point of logging is that the
// wait is attributable without opening anything.
function roundLine(record) {
  if (!record) return '';
  const parts = [elapsedLabel(record.total)];
  if (Number.isFinite(record.observeMs)) parts.push(`read ${elapsedLabel(record.observeMs)}`);
  if (record.modelMs) parts.push(`model ${elapsedLabel(record.modelMs)}`);
  if (record.actionMs) parts.push(`act ${elapsedLabel(record.actionMs)}`);
  return parts.join(' · ');
}
function showRoundTiming(run) {
  const record = run?.timing;
  if (!record || record.shown) return;
  record.shown = true;
  record.total = [record.observeMs, record.modelMs, record.netMs, record.actionMs].reduce((sum, value) => sum + (Number(value) || 0), 0);
  pushMessage('timing', roundLine(record));
}
function timingStats(list) {
  const values = key => list.map(record => Number(record[key]) || 0);
  const read = median(list.map(record => Number.isFinite(record.observeMs) ? record.observeMs : 0));
  const model = median(values('modelMs'));
  const net = median(values('netMs'));
  const act = median(values('actionMs'));
  const measured = read + model + net + act || 1;
  return {
    read, model, net, act,
    total: median(values('total')), slow: p90(values('total')),
    share: Math.round(model / measured * 100),
    shots: list.filter(record => record.image).length,
    bytes: list.reduce((sum, record) => sum + (record.bytes || 0), 0) / list.length,
    tokensIn: list.reduce((sum, record) => sum + (record.tokens?.in || 0), 0),
    tokensOut: list.reduce((sum, record) => sum + (record.tokens?.out || 0), 0)
  };
}
function renderTimings() {
  const body = $('timings-body');
  if (!body) return;
  body.textContent = '';
  // Task records live in the same array so one export and one clear cover both; they are kept out of
  // the round medians, because a task has no read/model/act split of its own.
  const tasks = timings.filter(record => record.kind === 'task');
  const list = timings.filter(record => record.kind !== 'task').slice(-60);
  if (!list.length && !tasks.length) {
    const p = document.createElement('p'); p.className = 'timings-empty';
    p.textContent = 'Nothing logged yet. Run a task and this fills in.';
    body.append(p); return;
  }
  const stats = list.length ? timingStats(list) : null;
  const row = (label, value) => {
    const div = document.createElement('div'); div.className = 'timing-stat';
    const a = document.createElement('span'); a.textContent = label;
    const b = document.createElement('span'); b.textContent = value;
    div.append(a, b); return div;
  };
  if (tasks.length) {
    const totals = tasks.map(record => record.total);
    body.append(row(`Median task · ${tasks.length} logged`, elapsedLabel(median(totals))));
    body.append(row('Slowest task', elapsedLabel(Math.max(...totals))));
  }
  if (list.length) body.append(row(`Median round · ${list.length} logged`, elapsedLabel(stats.total)));
  if (stats) {
    body.append(row('90% finish under', elapsedLabel(stats.slow)));
    body.append(row('Model · share of the round', `${elapsedLabel(stats.model)} · ${stats.share}%`));
    body.append(row('Screenshots', `${stats.shots} of ${list.length} rounds`));
    body.append(row('Payload · tokens', `${Math.round(stats.bytes / 1024)} KB · ${(stats.tokensIn / 1000).toFixed(1)}k in / ${(stats.tokensOut / 1000).toFixed(1)}k out`));
    const bar = document.createElement('div'); bar.className = 'timing-bar';
    const sum = stats.read + stats.model + stats.net + stats.act || 1;
    for (const [value, color, name] of [[stats.read, 'var(--accent)', 'read'], [stats.model, 'var(--ink)', 'model'], [stats.net, 'var(--faint)', 'network'], [stats.act, 'var(--line-strong)', 'act']]) {
      const seg = document.createElement('i');
      seg.style.width = `${value / sum * 100}%`; seg.style.background = color; seg.title = `${name} ${elapsedLabel(value)}`;
      bar.append(seg);
    }
    body.append(bar);
    const legend = document.createElement('div'); legend.className = 'timing-legend';
    for (const [color, name] of [['var(--accent)', 'read'], ['var(--ink)', 'model'], ['var(--faint)', 'network'], ['var(--line-strong)', 'act']]) {
      const item = document.createElement('b');
      const dot = document.createElement('em'); dot.style.background = color;
      item.append(dot, document.createTextNode(name)); legend.append(item);
    }
    body.append(legend);
  }
  if (tasks.length) {
    const head = document.createElement('p'); head.className = 'overline'; head.textContent = 'Tasks';
    body.append(head);
    const taskList = document.createElement('div'); taskList.className = 'round-list';
    for (const record of tasks.slice(-6).reverse()) {
      const item = document.createElement('div'); item.className = 'round-row';
      const total = document.createElement('b'); total.textContent = elapsedLabel(record.total);
      const meta = document.createElement('span');
      const bits = [`${record.rounds} round${record.rounds === 1 ? '' : 's'}`];
      if (record.modelMs) bits.push(`model ${elapsedLabel(record.modelMs)}`);
      bits.push(record.status === 'done' ? 'checked' : record.status === 'unchecked' ? 'unchecked' : 'stopped');
      meta.textContent = bits.join(' · ');
      item.title = record.goal || '';
      item.append(total, meta); taskList.append(item);
    }
    body.append(taskList);
  }
  if (!list.length) return;
  const head = document.createElement('p'); head.className = 'overline'; head.textContent = 'Rounds';
  body.append(head);
  const rounds = document.createElement('div'); rounds.className = 'round-list';
  for (const record of list.slice(-8).reverse()) {
    const item = document.createElement('div'); item.className = 'round-row';
    const total = document.createElement('b'); total.textContent = elapsedLabel(record.total);
    const parts = [];
    parts.push(Number.isFinite(record.observeMs) ? `read ${elapsedLabel(record.observeMs)}` : 'read n/a');
    parts.push(`model ${elapsedLabel(record.modelMs || 0)}`);
    parts.push(`act ${elapsedLabel(record.actionMs || 0)}`);
    if (record.image) parts.push('shot');
    const meta = document.createElement('span'); meta.textContent = parts.join(' · ');
    item.append(total, meta); rounds.append(item);
  }
  body.append(rounds);
}
function openTimings() { renderTimings(); if (!$('timings-dialog').open) $('timings-dialog').showModal(); }

function notify(text, error = false) {
  const box = $('notice');
  // role=status is already polite; a failure interrupts instead of waiting its turn.
  box.setAttribute('role', error ? 'alert' : 'status');
  box.textContent = text;
  box.classList.toggle('error', error);
  box.hidden = false;
}
// A CRX install updates itself through the manifest's update_url, but an unpacked one never does:
// Chrome does not re-read the folder. So the panel reads the same feed and turns it into two buttons —
// open the new zip, and reload once you have replaced the files.
const UPDATE_INTERVAL = 6 * 60 * 60 * 1000;
async function checkUpdate(quiet = false) {
  const current = chrome.runtime.getManifest().version;
  const status = $('update-status');
  $('update-line').textContent = 'Mezze ' + current;
  try {
    const res = await fetch(Update.FEED_URL + '?t=' + Date.now(), { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error('the feed answered ' + res.status);
    const feed = Update.parse(await res.text());
    if (!feed) throw new Error('the feed is not readable');
    updateState = { version: feed.version, current, newer: Update.newer(feed.version, current) };
    $('check-update').textContent = updateState.newer ? 'Download ' + feed.version : 'Check for updates';
    $('reload-extension').hidden = !updateState.newer;
    status.hidden = false;
    status.textContent = updateState.newer
      ? feed.version + ' is available — you have ' + current + '. Download it, unzip it over the folder you loaded, then press Reload extension.'
      : 'Up to date — ' + current + ' is the newest release.';
    if (updateState.newer && !quiet) notify('Mezze ' + feed.version + ' is available. Settings → Check for updates to download it.');
  } catch (error) {
    updateState = null;
    $('check-update').textContent = 'Check for updates';
    $('reload-extension').hidden = true;
    status.hidden = false;
    status.textContent = 'Could not check for updates: ' + error.message + '. The feed is public, so this is usually the network or a site-access grant that has not been given yet.';
  }
}
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
  const closing = flushTiming(run);
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
  if (closing) pushMessage('timing', roundLine(closing));
  const ended = finishTask(run, report.verdict === 'passed' ? 'done' : 'unchecked');
  pushMessage('report', reportText(report), { report });
  if (ended) pushMessage('timing', taskLine(ended));
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
// The topbar badge is the chat title, not a fixed product label: the panel should say what it is
// working on. Clicking it opens the chat list.
function renderChatTitle() {
  const label = $('chat-title');
  if (!label) return;
  const title = (chat?.title || '').trim();
  label.textContent = title && title !== 'New chat' ? title : 'agent';
  label.title = title ? `${title} — open chats` : 'Open chats';
}
function newChatRecord() { return { id: crypto.randomUUID(), title: 'New chat', goal: '', messages: [], plan: [], steps: [], done: [], at: Date.now() }; }
let persistTimer = 0, saveWarned = false;
// Every step used to write the whole chat list to storage immediately. A trailing write collapses a
// burst of them into one, and a failure is said out loud instead of being swallowed: a chat that
// stops saving without a word is a transcript lost.
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = 0; persist().catch(() => {}); }, 250);
}
async function persist() {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = 0; }
  if (!chat) return;
  renderChatTitle();
  chat.plan = plan;
  chat.messages = chat.messages.slice(-MAX_MESSAGES);
  if (workflow) chat.steps = workflow.steps;
  chat.at = Date.now();
  const index = chats.findIndex(item => item.id === chat.id);
  if (index === -1) chats.unshift(chat); else chats[index] = chat;
  if (chats.length > MAX_CHATS) {
    // The cap used to drop the oldest chat without a word.
    const dropped = chats.splice(MAX_CHATS);
    notify(`Only the newest ${MAX_CHATS} chats are kept, so the oldest ${dropped.length === 1 ? 'one was' : `${dropped.length} were`} removed. Export a chat to keep a copy.`, true);
  }
  try {
    await chrome.storage.local.set({ chats, activeChat: chat.id });
    saveWarned = false;
  } catch (e) {
    if (!saveWarned) { saveWarned = true; notify(`This browser refused the save (${e?.message || 'storage may be full'}). Export the chat to keep a copy.`, true); }
  }
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
  renderChatTitle();
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
  schedulePersist();
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
    mark.addEventListener('click', () => { item.done = !item.done; renderPlan(); schedulePersist(); });
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
  renderChat(); renderPlan(); schedulePersist();
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
    const drop = document.createElement('button'); drop.type = 'button'; drop.className = 'history-drop';
    drop.title = 'Delete this chat'; drop.setAttribute('aria-label', `Delete ${item.title || 'chat'}`); setIcon(drop, 'x', 12);
    drop.addEventListener('click', async () => {
      if (workflow && chat?.id === item.id) { notify('Stop the run before deleting the chat it is working in.', true); return; }
      chats = chats.filter(entry => entry.id !== item.id);
      if (chat?.id === item.id) { chat = null; await newChat(); } else await persist();
      renderHistory();
      notify('Chat deleted.');
    });
    row.append(button, drop); list.append(row);
  }
}
function download(name, text, type = 'text/markdown') {
  const blob = text instanceof Blob ? text : new Blob([text], { type });
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
  // The stop button and Escape mean the same thing for a transcription as for a run, and when the
  // agent is the one transcribing both have to stop: the capture settles the step it is waiting on.
  if (transcribeRun) stopTranscribe();
  const running = workflow;
  if (running) { rememberSteps(running); flushTiming(running); }
  // Every ending funnels through here: report, halt, stop button, step limit. The report path closes
  // the task first, so this only fires for the others.
  const ended = running ? finishTask(running, 'stopped') : null;
  workflow = null; proposal = null; currentAction(null);
  announceRunEnd();
  if (running) { running.paused = false; running.held = false; running.resume?.(); running.resume = null; }
  $('approval').hidden = true; $('stop').hidden = true; $('start').hidden = false; $('pause').hidden = true;
  $('goal').disabled = false; $('loading').hidden = true;
  $('run-dot').hidden = true;
  if (ended && chat?.id === ended.chatId) pushMessage('timing', taskLine(ended));
  renderPlan(); renderSkillChip(); schedulePersist();
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
  schedulePersist();
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

// A run used to be all-or-nothing: stop threw the goal and the checklist away. A pause freezes it
// between rounds instead, so a login wall or a 2FA code can be dealt with by hand and the same run
// carries on afterwards with its plan and evidence intact.
async function hold(run) {
  run.held = true;
  $('loading').hidden = true;
  currentAction(null);
  pauseLabel(run);
  notify('Paused between rounds. Do what you need in the page, then press Continue.');
  await new Promise(resolve => { run.resume = resolve; });
  run.held = false; run.resume = null; run.paused = false;
  pauseLabel(run);
  if (workflow !== run) return false;
  loading('Continuing');
  return true;
}
function pauseLabel(run) {
  const button = $('pause');
  if (!button) return;
  const held = !!run?.held, requested = !!run?.paused;
  setIcon(button, held ? 'arrow-right' : 'hourglass', 16);
  const text = held ? 'Continue the run' : requested ? 'Pausing after this round — click to cancel' : 'Pause after this round';
  button.title = text; button.setAttribute('aria-label', text);
  button.classList.toggle('held', held);
}
// Notes are the agent's scratchpad: keyed values it writes with remember, kept in this browser so a
// value found in one run is still there in the next. Loaded once, then kept in memory.
let notesStore = null, notesLoading = null;
let shadowMode = false;
async function loadNotes() {
  if (notesStore) return notesStore;
  notesLoading = notesLoading || chrome.storage.local.get('notes').then(saved => {
    notesStore = saved?.notes && typeof saved.notes === 'object' ? saved.notes : {};
    return notesStore;
  }).catch(() => (notesStore = {}));
  return notesLoading;
}
function notesList() {
  return Object.entries(notesStore || {}).slice(-20).map(([key, value]) => ({ key, value: String(value).slice(0, 500) }));
}
async function rememberFact(run, action) {
  await loadNotes().catch(() => {});
  const key = String(action.key || '').slice(0, 60);
  if (!key) throw new Error('A note needs a key.');
  if (action.forget) delete notesStore[key];
  else notesStore[key] = String(action.value ?? '').slice(0, 500);
  await chrome.storage.local.set({ notes: notesStore || {} }).catch(() => {});
  const shown = action.forget ? 'forgot ' + key : key + ' = ' + notesStore[key];
  run.steps.push({ type: 'remember', description: action.description || key, ok: true, changed: false, note: shown });
  pushMessage('note', action.forget ? 'Forgot “' + key + '”.' : 'Noted ' + key + ': ' + String(notesStore[key]).slice(0, 160));
  return 'ok';
}
// A blocking question: the run waits here until the person answers, which is the only way past a
// CAPTCHA or a choice the goal does not settle. The answer becomes a step, so the next round sees it.
function askUser(run, action) {
  return new Promise(resolve => {
    const card = document.createElement('div');
    card.className = 'message ask-card';
    const question = document.createElement('p');
    question.className = 'ask-question';
    question.textContent = action.question || 'I need your help before I can continue.';
    const row = document.createElement('div');
    row.className = 'ask-row';
    card.append(question, row);
    $('steps').append(card);
    card.scrollIntoView({ block: 'nearest' });
    let poll = 0;
    const finish = answer => {
      clearInterval(poll);
      card.remove();
      run.steps.push({ type: 'ask', description: action.question || '', ok: true, changed: false, note: 'the user answered: ' + answer });
      pushMessage('assistant', answer);
      resolve('ok');
    };
    const button = (label, answer) => {
      const node = document.createElement('button');
      node.type = 'button';
      node.className = 'secondary';
      node.textContent = label;
      node.addEventListener('click', () => finish(answer));
      row.append(node);
      return node;
    };
    if (action.kind === 'takeover') {
      pushMessage('note', 'Take over in the page. I will carry on when you press Done.');
      button('Done — continue', 'The user handled it in the page and said to continue.');
    } else if (action.kind === 'confirm') {
      button('Yes', 'yes');
      button('No', 'no');
    }
    for (const option of Array.isArray(action.options) ? action.options : []) button(option, option);
    if (action.kind !== 'takeover' && action.kind !== 'confirm') {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'ask-input';
      input.placeholder = 'Your answer';
      input.setAttribute('aria-label', 'Your answer');
      const send = document.createElement('button');
      send.type = 'button';
      send.className = 'secondary';
      send.textContent = 'Send';
      send.addEventListener('click', () => { if (input.value.trim()) finish(input.value.trim()); });
      input.addEventListener('keydown', event => { if (event.key === 'Enter' && input.value.trim()) { event.preventDefault(); finish(input.value.trim()); } });
      row.append(input, send);
      input.focus();
    }
    poll = window.setInterval(() => { if (workflow !== run) { clearInterval(poll); card.remove(); resolve('stop'); } }, 500);
  });
}
async function next(run, prefetched) {
  if (workflow !== run) return;
  flushTiming(run);
  await loadNotes().catch(() => {});
  if (run.paused && !(await hold(run))) return;
  if (workflow !== run) return;
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
  const body = { goal:aimed(run), speed, intent:[run.goal, ...plan.map(item => item.title)].join('\n'), todos:plan, steps:run.steps.slice(-60), url:shot.url, title:shot.title, text:String(shot.text || ''), ...(sendImage ? { image: shot.image } : {}), width:Math.max(1, Math.round(Number(naturalWidth) || width)), height:Math.max(1, Math.round(Number(naturalHeight) || height)), elements, refs, tabs, contexts:extra, memory: run.memory || undefined, notes: notesList(), shadow: shadowMode, ...(run.shots?.length ? { images: run.shots } : {}), stalled:run.stalled, automatic:run.mode === 'autopilot', history: run.history?.length ? run.history : undefined, correction: run.correction || undefined };
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
  if (applyCompleted(run, completed)) schedulePersist();
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
    // Which posture stopped the run, said in the card: "needs your approval" on its own never made it
    // clear whether this was the setting or the step.
    $('approval-why').textContent = `${risky ? `Paused because ${risky}.` : Approval.whyFor(posture)} Approval: ${Approval.labelFor(posture).toLowerCase()}.`;
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
  showRoundTiming(run);
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
  if (action.type === 'transcribe') {
    // The agent asks for the spoken content of the page it is on; the capture is the same one
    // /transcribe uses, and the transcript comes back as this step's result.
    const tab = tabCache.find(item => item.id === run.actingTabId);
    if (!tab?.id) throw new Error('There is no page to transcribe.');
    if (!tab.supported) throw new Error('That page cannot be read. Chrome internal pages are blocked.');
    loading('Transcribing the audio', 'book-open-text');
    const out = await transcribePage(null, 'agent', tab);
    const text = out?.text || '';
    const words = text ? text.split(/\s+/).length : 0;
    pushMessage('note', text
      ? `Transcribed ${MezzeAudio.stamp(out.seconds)} of audio — ${words} word${words === 1 ? '' : 's'}${out.error ? ` (stopped early: ${out.error})` : ''}.`
      : `The audio on ${hostOf(tab.url)} had no speech to transcribe${out?.error ? ` (${out.error})` : ''}.`);
    return { text, chars: text.length, seconds: out?.seconds || 0, parts: out?.parts || 0, code: out?.error ? 'TRANSCRIPT_PARTIAL' : '', effect: { verified: !!text } };
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
  if (action.type === 'ask') return askUser(run, action);
  if (action.type === 'remember') return rememberFact(run, action);
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
    if (action.type === 'see') {
      // Sight for another tab: a chart, a PDF page or a canvas that text cannot describe. The picture
      // rides on the next round instead of being described here.
      const seen = tabByToken(run, action.tab);
      const shotTab = await send('observe', { tabId: seen.id, activate: false, shot: true });
      if (shotTab?.image) {
        run.shots = [...(run.shots || []), { tab: action.tab, url: shotTab.url, image: shotTab.image }].slice(-2);
        pushMessage('note', 'Looked at ' + shortTitle(seen) + ' as an image.');
      } else pushMessage('note', 'Could not capture ' + shortTitle(seen) + ', so that image is missing.');
      result = { seen: !!shotTab?.image, effect: { verified: null } };
    }
    if (action.type !== 'see') result = TAB_STEPS.has(action.type) ? await actOnTabs(run, action) : await send('act', { ...current, settleMs: settleFor(), stayPut, goal: run.goal, intent: [run.goal, ...plan.map(item => item.title)].join('\n'), allow: run.allow, automatic: run.mode === 'autopilot' });  }
  catch (error) {
    noteActionMs(run, actionStart, action.type);
    if (workflow !== run) return 'stop';
    // A rate-limited write or click is also just a pause: wait out the window, then look again.
    if (isRateLimit(error.status, error.message) && cooldowns < COOLDOWN_LIMIT) { await cooldown(); return 'recover'; }
    if (error.code === 'PAGE_CHANGED' && (run.recovered || 0) < 2) { run.recovered = (run.recovered || 0) + 1; notify('The page shifted while acting. Re-reading it and trying again.'); return 'recover'; }
    run.steps.push({ type: action.type, description: action.description || '', ok: false, changed: false, code: error.code || 'ERROR', note: error.message, page: current.url, ref: action.ref, x: current.action.x, y: current.action.y, url: action.url, direction: action.direction, text: action.type === 'type' ? action.text : undefined });
    recordActivity(action, current.url, {}, Math.round(performance.now() - actionStart), `${error.message}${error.code ? ` [${error.code}]` : ''}`);
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
  if (result?.shadow) {
    // Preview only: the step is described, nothing is fired, and the run stops here.
    const planned = result.planned || {};
    const shape = [planned.type, planned.ref ? 'ref ' + planned.ref : '', Number.isFinite(planned.x) ? 'at ' + planned.x + ',' + planned.y : '', planned.text ? 'text "' + String(planned.text).slice(0, 80) + '"' : '', planned.url ? planned.url : ''].filter(Boolean).join(' ');
    pushMessage('note', 'Preview: ' + (shape || 'that step') + '. Nothing was clicked.');
    pushMessage('note', 'That is shadow mode — turn Preview off in Settings and send the task again to run it.');
    stop();
    return 'stop';
  }
  // The page's own words for what just happened ("Saved", "Item added") are the best receipt there is.
  if (result?.receipt) pushMessage('note', 'The page said: “' + String(result.receipt).slice(0, 160) + '”.');
  if (result?.generated) pushMessage('note', `Gemini wrote ${Number(result.generated).toLocaleString()} characters into the field.`);
  const verified = result?.effect?.verified;
  const changed = verified !== false;
  if (changed) { run.evidence = (run.evidence || 0) + 1; run.stalled = 0; run.recovered = 0; run.retries = 0; run.lastHash = ''; run.apiRetries = 0; }
  else run.stalled = (run.stalled || 0) + 1;
  // A transcript is the evidence for the next round, so more of it travels than a page excerpt.
  const note = !result?.text ? ''
    : action.type === 'transcribe' ? `transcript: ${String(result.text).slice(0, 6000)}`
      : ['read', 'gather'].includes(action.type) ? `page excerpt: ${String(result.text).slice(0, 1500)}` : '';
  run.steps.push({ type: action.type, description: action.description || '', ok: true, changed, page: current.url, note, code: result?.code || '', ref: action.ref, x: current.action.x, y: current.action.y, url: action.url, direction: action.direction, text: action.type === 'type' ? action.text : undefined });
  recordActivity(action, result?.url || current.url, result, Math.round(performance.now() - actionStart), null, { changed, fallback: !!result?.fallback, opened: action.type === 'open' ? { url: result?.url, title: result?.title } : undefined });
  currentAction(null);
  return 'ok';
}
async function startWorkflow(goal, skill) {
  if (rec) throw new Error('Save or cancel the recording first — a run and a recording cannot share the tab.');
  await listTabs().catch(() => {});
  const acting = tabCache.find(t => t.id === actingTabId) || tabCache.find(t => t.active) || tabCache[0];
  if (!acting) throw new Error('Open a webpage first.');
  await permission(acting.url);
  if (!chat) { chat = newChatRecord(); chats.unshift(chat); }
  // A clicked or named skill wins; otherwise a Google page plus summarising words picks it up by itself.
  const chosen = skill || builtinFor(acting.url, goal);
  const history = chatHistory();
  chat.goal = goal; chat.title = goal.slice(0, 60);
  workflow = { goal, skill: chosen || null, steps: [], mode: Approval.modeFor(posture), taskStart: Date.now(), chatId: chat.id, spent: null, history, paused: false, held: false, resume: null, actingTabId: acting.id, homeTabId: acting.id, contextIds: [...contextIds], opened: [], tokens: {}, tokenSeq: 0, stalled: 0, lastHash: '', queue: [], evidence: 0, unproven: 0, recovered: 0, retries: 0, apiRetries: 0, keepGoing: 0, allow: [new URL(acting.url).origin], memory: null, wantShot: false, contextTabs: [], warned: [] };  const run = workflow;
  $('run-dot').hidden = false;
  plan = [];
  pushMessage('user', goal);
  if (chosen) pushMessage('note', `Using the built-in “${chosen.name}” skill for this page.`);
  $('goal').value = ''; grow();
  renderSkillChip();
  $('suggest').hidden = true;
  $('start').hidden = true; $('stop').hidden = false; $('pause').hidden = false; pauseLabel(run); $('goal').disabled = true;
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
    const [planned, shot] = await Promise.allSettled([timed(api('/plan', { goal: aimed(run), url: acting.url, title: acting.title, history: run.history?.length ? run.history : undefined }), PLAN_TIMEOUT, 'The planner did not answer in time.'), observed]);
    if (workflow !== run) return;
    if (shot.status === 'rejected') throw shot.reason;
    if (planned.status === 'fulfilled' && planned.value.todos?.length) plan = planned.value.todos;
    else if (planMode === 'always') plan = [{ id: '1', title: goal.slice(0, 140), done: false }];
    else if (planned.status === 'rejected') pushMessage('note', 'No checklist this time — the planner was slow, so I went straight to the page.');
    else pushMessage('note', 'This task is short enough to run without a checklist.');
    renderPlan();
    schedulePersist();
    await next(run, shot.value);
  } catch (e) {
    if (workflow !== run) return;
    $('loading').hidden = true;
    throw e;
  }
}

/* ---------- composer & palette ---------- */
/* ---------- transcription ---------- */
// /transcribe reads the audio of the video or audio element the page is playing, in ten-second
// slices, and sends each slice to the Worker. Nothing is downloaded from the site and no media file
// is stored: the element's own track is captured as it plays, which is the only path that also works
// for a player that streams through MediaSource and never exposes a file.
let transcribeRun = null;

function transcribeUi(on) {
  $('stop').hidden = !on; $('start').hidden = on; $('goal').disabled = on; $('run-dot').hidden = !on;
  if (!on) { $('loading').hidden = true; currentAction(null); }
}

function renderTranscribe() {
  const run = transcribeRun;
  if (!run) return;
  const heard = run.duration ? `${MezzeAudio.stamp(run.seconds)} of ${MezzeAudio.stamp(run.duration)}` : MezzeAudio.stamp(run.seconds);
  loading(`Transcribing ${heard}`, 'book-open-text');
}

// Script mode keeps the last transcript per tab, so the island can come back after the panel has been
// closed or reloaded and /script is useful even when nothing is being transcribed.
const SCRIPT_KEY = 'script:lines';
let scriptCache = {};
let scriptTab = null;
const scriptFor = tabId => scriptCache[tabId] || null;

async function saveScript(tabId, data) {
  if (!tabId) return;
  scriptCache = { ...scriptCache, [tabId]: { title: data.title || '', url: data.url || '', lines: (data.lines || []).slice(-400) } };
  await chrome.storage.session.set({ [SCRIPT_KEY]: scriptCache }).catch(() => {});
}

async function openScript() {
  await listTabs().catch(() => {});
  const tab = tabCache.find(item => item.id === actingTabId) || tabCache.find(item => item.active) || tabCache[0];
  if (!tab?.id) throw new Error('Open the page with the video first.');
  if (scriptTab === tab.id) {
    await send('player-close', { tabId: tab.id }).catch(() => {});
    scriptTab = null;
    notify('Script mode closed.');
    return;
  }
  const saved = scriptFor(tab.id);
  await send('player-open', { tabId: tab.id, title: saved?.title || tab.title || '', lines: saved?.lines || [], live: !!transcribeRun && transcribeRun.tabId === tab.id });
  scriptTab = tab.id;
  notify(saved?.lines?.length
    ? 'Script mode is on — the transcript follows the video.'
    : 'Script mode is on. Start /transcribe and the lines appear as they are transcribed.');
}

// The same capture serves the /transcribe command and the agent's transcribe action, so it reports a
// result instead of delivering one: the caller decides whether that is a chat message or a step.
async function transcribePage(url = null, mode = 'command', forced = null) {
  if (transcribeRun) throw new Error('A transcription is already running.');
  if (mode === 'command' && (workflow || macroRun)) throw new Error('Stop the run in progress first.');
  if (!forced) await listTabs().catch(() => {});
  let tab = forced || tabCache.find(item => item.id === actingTabId) || tabCache.find(item => item.active) || tabCache[0];
  if (!tab?.id) throw new Error('Open the page with the video first.');
  if (url) {
    await permission(url);
    await chrome.tabs.update(tab.id, { url, active: !stayPut });
    tab = await waitForTab(tab.id, 20000);
    if (!tab?.id) throw new Error('That page did not open.');
    actingTabId = tab.id;
    renderTabs();
  }
  const session = crypto.randomUUID();
  const run = { session, tabId: tab.id, mode, text: [], lines: [], title: '', url: '', queue: [], parts: 0, seconds: 0, duration: 0, done: false, finished: false, busy: false, settle: null, error: '' };
  const settled = new Promise(resolve => { run.settle = resolve; });
  transcribeRun = run;
  let out;
  try { out = await send('capture-start', { tabId: tab.id, session }); }
  catch (e) { transcribeRun = null; throw e; }
  if (out?.state !== 'running') {
    transcribeRun = null;
    throw new Error(out?.error || 'No video or audio was found on this page.');
  }
  run.duration = Number(out.duration) || 0;
  run.title = String(out.title || tab.title || '');
  run.url = String(out.url || tab.url || '');
  // Script mode opens with the capture: watching the lines arrive is the point of it.
  scriptTab = tab.id;
  await send('player-open', { tabId: tab.id, title: run.title, lines: run.lines, live: true }).catch(() => {});
  if (mode === 'command') transcribeUi(true);
  currentAction('Recording the audio from this page');
  renderTranscribe();
  if (mode === 'command') {
    pushMessage('note', `Transcribing the audio from ${shortTitle(tab)}. It is captured as it plays, so this takes as long as the video runs — keep this panel open.`);
    if (out.paused) pushMessage('note', 'The player is paused. Press play on the video and the transcription continues by itself.');
  } else if (out.paused) pushMessage('note', 'The player is paused — the transcription waits for it to start.');
  if (out.via === 'tab') pushMessage('note', 'This player does not expose its own audio track, so Mezze is capturing the whole tab instead. Keep the tab playing — muting Chrome is fine, closing the tab is not.');
  return settled;
}

async function transcribeCommand() {
  deliverTranscript(await transcribePage());
}

function deliverTranscript(result) {
  const text = result?.text || '';
  const words = result?.words || (text ? text.split(/\s+/).length : 0);
  lastTranscript = text;
  if (!text) { notify(result?.error || 'No speech was found in that audio.', true); return; }
  pushMessage('assistant', text);
  download(`mezze-transcript-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`, text, 'text/plain');
  if (result?.error) notify(`Stopped early (${result.error}) — ${words} word${words === 1 ? '' : 's'} saved.`, true);
  else if (result?.partial) notify(`Stopped — ${words} word${words === 1 ? '' : 's'} saved.`);
  else notify(`Transcript ready — ${words} word${words === 1 ? '' : 's'}, saved as a text file.`);
}

async function onTranscribeEvent(event) {
  const run = transcribeRun;
  if (!run || !event?.event) return;
  if (event.event === 'start') { run.duration = Number(event.duration) || run.duration; renderTranscribe(); return; }
  if (event.event === 'progress') { run.seconds = Number(event.seconds) || run.seconds; renderTranscribe(); return; }
  if (event.event === 'chunk') {
    run.seconds = Number(event.seconds) || run.seconds;
    run.queue.push({ part: Number(event.part) || run.parts + 1, audio: event.audio, mimeType: event.mimeType, seconds: run.seconds, from: Number(event.from), to: Number(event.to) });
    pumpTranscribe();
    return;
  }
  if (event.event === 'done') { run.done = true; run.seconds = Number(event.seconds) || run.seconds; pumpTranscribe(); }
}

// Three slices in flight instead of one. Speech arrives in real time, so a ten-second request that
// takes longer than ten seconds to come back never catches up with the video; a small pool keeps the
// transcript level with the audio. Answers are released in part order, because a transcript that jumps
// around is worse than one that arrives a few seconds late.
const SLICES_IN_FLIGHT = 3;

function startSlice(run, job) {
  run.inflight = (run.inflight || 0) + 1;
  api('/transcribe', { audio: job.audio, mimeType: job.mimeType, part: job.part, seconds: job.seconds })
    .then(out => {
      if (transcribeRun !== run) return;
      run.results = run.results || new Map();
      run.results.set(job.part, {
        from: Number.isFinite(job.from) ? job.from : (job.part - 1) * MezzeAudio.SLICE,
        to: Number.isFinite(job.to) ? job.to : job.part * MezzeAudio.SLICE,
        text: String(out?.text || '').trim()
      });
      releaseSlices(run);
    })
    .catch(e => {
      if (transcribeRun !== run) return;
      run.error = e?.message || 'Transcription stopped.';
      stopTranscribe().catch(() => {});
    })
    .finally(() => {
      if (transcribeRun !== run) return;
      run.inflight = Math.max(0, (run.inflight || 0) - 1);
    });
}

// A line joins the transcript only once every earlier slice has answered, so the island can light the
// line being spoken without the text rearranging itself behind the video.
function releaseSlices(run) {
  run.next = run.next || 1;
  while (run.results && run.results.has(run.next)) {
    const line = run.results.get(run.next);
    run.results.delete(run.next);
    run.next += 1;
    if (!line.text) continue;
    run.text.push(line.text);
    run.lines.push(line);
    saveScript(run.tabId, { title: run.title, url: run.url, lines: run.lines });
    send('player-line', { tabId: run.tabId, line, title: run.title }).catch(() => {});
  }
  renderTranscribe();
}

async function pumpTranscribe() {
  const run = transcribeRun;
  if (!run || run.pumping) return;
  run.pumping = true;
  try {
    for (;;) {
      if (transcribeRun !== run) return;
      if (!run.queue.length && !run.inflight) {
        if (run.done) await finishTranscribe();
        return;
      }
      while ((run.inflight || 0) < SLICES_IN_FLIGHT && run.queue.length) {
        const job = run.queue.shift();
        run.parts = Math.max(run.parts, job.part);
        currentAction('Transcribing ' + MezzeAudio.stamp(job.seconds));
        startSlice(run, job);
      }
      await sleep(80);
    }
  } finally {
    if (transcribeRun === run) run.pumping = false;
  }
}


async function finishTranscribe() {
  const run = transcribeRun;
  if (!run || run.finished) return;
  run.finished = true;
  const text = MezzeAudio.joinParts(run.text);
  transcribeRun = null;
  if (run.mode === 'command') transcribeUi(false);
  run.settle?.({ text, words: text ? text.split(/\s+/).length : 0, seconds: run.seconds, parts: run.parts });
  send('player-idle', { tabId: run.tabId }).catch(() => {});
}

async function stopTranscribe() {
  const run = transcribeRun;
  if (!run) return;
  transcribeRun = null;
  await send('capture-stop', { tabId: run.tabId, session: run.session }).catch(() => {});
  if (run.mode === 'command') transcribeUi(false);
  run.settle?.({ text: MezzeAudio.joinParts(run.text), partial: true, error: run.error, seconds: run.seconds, parts: run.parts });
  send('player-idle', { tabId: run.tabId }).catch(() => {});
}

/* ---------- schedules: recurring runs, menus and shortcuts ---------- */
// A schedule is stored by the background and fired by an alarm there. This side adds them, lists them,
// and — when a scheduled tab opens with ?task=<id> — runs exactly one task and closes itself.

async function addScheduleFromText(raw) {
  const rest = String(raw).replace(/^\/every\s*/i, '').trim();
  const match = rest.match(/^(\S+)\s+([\s\S]+)$/);
  if (!match) throw new Error('Say it like /every 60 summarize my inbox, or /every 2h check prices.');
  const out = await send('schedule-add', { every: match[1], prompt: match[2] });
  const wait = Math.max(1, Math.round((out.schedule.nextRun - Date.now()) / 60000));
  notify(`Scheduled: ${Schedule.describe(out.schedule)}. First run in ${wait} min.`);
}

async function showSchedules(raw = '/schedules') {
  const arg = String(raw).replace(/^\/schedules\s*/i, '').trim();
  const out = await send('schedule-list');
  const list = Array.isArray(out.schedules) ? out.schedules : [];
  if (/^off\b/i.test(arg)) {
    const which = arg.replace(/^off\s*/i, '').trim();
    if (!which || /^all$/i.test(which)) {
      for (const entry of list) await send('schedule-remove', { id: entry.id });
      notify(list.length ? `Removed ${list.length} scheduled task${list.length === 1 ? '' : 's'}.` : 'Nothing was scheduled.');
      return;
    }
    const target = list.find(entry => entry.id === which) || list[Number(which) - 1];
    if (!target) { notify('No scheduled task matches that.', true); return; }
    await send('schedule-remove', { id: target.id });
    notify(`Removed “${target.prompt.slice(0, 40)}”.`);
    return;
  }
  if (!list.length) { notify('Nothing scheduled yet. Add one with /every 60 <task>.'); return; }
  const lines = list.map((entry, index) => `${index + 1}. **${Schedule.describe(entry)}** — next in ${Math.max(0, Math.round((entry.nextRun - Date.now()) / 60000))} min, ${entry.runs || 0} run${(entry.runs || 0) === 1 ? '' : 's'} · id \`${entry.id}\``);
  pushMessage('assistant', `Scheduled tasks:\n\n${lines.join('\n')}\n\nCancel one with \`/schedules off <id>\`.`);
  notify(`${list.length} scheduled task${list.length === 1 ? '' : 's'}.`);
}

// Scheduled tabs are background tabs, and nobody is watching them: they announce themselves instead.
function announceRunEnd() {
  if (document.visibilityState === 'visible') return;
  const last = [...(chat?.messages || [])].reverse().find(message => message.role === 'assistant');
  const text = String(last?.text || '').replace(/\s+/g, ' ').trim();
  chrome.runtime.sendMessage({ type: 'notify', title: 'Mezze finished this run', message: text.slice(0, 160) || 'Open Mezze to see what happened.' }).catch(() => {});
}

// `?task=<id>&auto=1` is one scheduled run in one tab: start it, wait for the end, say so, close.
async function autorun() {
  const id = new URLSearchParams(location.search).get('task');
  if (!id) return false;
  const out = await send('schedule-list').catch(() => ({ schedules: [] }));
  const entry = (out.schedules || []).find(item => item.id === id);
  if (!entry) { notify('That scheduled task is gone. Remove this tab.', true); return true; }
  document.title = `Mezze — ${entry.prompt.slice(0, 28)}`;
  notify(`Scheduled run: ${entry.prompt.slice(0, 80)}`);
  await startWorkflow(entry.prompt).catch(error => notify(error.message || 'The scheduled run could not start.', true));
  await send('schedule-done', { id }).catch(() => {});
  let seen = false;
  for (let tick = 0; tick < 900; tick += 1) {
    await new Promise(done => setTimeout(done, 2000));
    if (workflow || proposal) seen = true;
    else if (seen) break;
    else if (tick > 10) break;
  }
  await send('notify', { title: 'Mezze finished a scheduled task', message: entry.prompt.slice(0, 160) }).catch(() => {});
  setTimeout(() => window.close(), 800);
  return true;
}

/* ---------- the vault: memory, files, uploads ---------- */
let lastTranscript = '';
let vaultDir = 'memory';

function filesDialog() {
  let dialog = $('files-dialog');
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'files-dialog';
  dialog.className = 'files-dialog';

  const head = document.createElement('header');
  head.className = 'files-head';
  const title = document.createElement('h2');
  title.textContent = 'Files';
  const usage = document.createElement('span');
  usage.className = 'files-usage';
  usage.id = 'files-usage';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'files-close';
  close.textContent = 'Close';
  close.addEventListener('click', () => dialog.close());
  head.append(title, usage, close);

  const bar = document.createElement('div');
  bar.className = 'files-bar';
  bar.id = 'files-bar';

  const tools = document.createElement('div');
  tools.className = 'files-tools';
  const upload = document.createElement('button');
  upload.type = 'button';
  upload.className = 'files-btn';
  upload.textContent = 'Upload files';
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.hidden = true;
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'files-btn';
  save.textContent = 'Save last transcript';
  upload.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { const picked = [...input.files]; input.value = ''; uploadToVault(picked).catch(e => notify(e.message || 'That upload did not work.', true)); });
  save.addEventListener('click', () => saveTranscript().catch(e => notify(e.message || 'Could not save that transcript.', true)));
  tools.append(upload, input, save);

  const list = document.createElement('div');
  list.className = 'files-list';
  list.id = 'files-list';

  const preview = document.createElement('pre');
  preview.className = 'files-preview';
  preview.id = 'files-preview';
  preview.hidden = true;

  dialog.append(head, bar, tools, list, preview);
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('dragover', event => event.preventDefault());
  dialog.addEventListener('drop', event => {
    event.preventDefault();
    const dropped = [...(event.dataTransfer?.files || [])];
    if (dropped.length) uploadToVault(dropped).catch(e => notify(e.message || 'That upload did not work.', true));
  });
  document.body.append(dialog);
  return dialog;
}

async function openFiles(dir = vaultDir) {
  const dialog = filesDialog();
  vaultDir = Vault.DIRS.includes(dir) ? dir : 'memory';
  if (!dialog.open) dialog.showModal();
  await renderFiles();
}

async function renderFiles() {
  const bar = $('files-bar');
  const list = $('files-list');
  if (!bar || !list) return;
  bar.replaceChildren(...Vault.DIRS.map(dir => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = `files-tab${dir === vaultDir ? ' on' : ''}`;
    tab.textContent = dir;
    tab.addEventListener('click', () => {
      vaultDir = dir;
      const preview = $('files-preview');
      if (preview) preview.hidden = true;
      renderFiles().catch(() => {});
    });
    return tab;
  }));

  list.replaceChildren();
  let entries = [];
  try { entries = await Vault.list(vaultDir); } catch (error) { notify(error.message || 'Could not read the vault.', true); }
  const files = entries.filter(entry => entry.kind !== 'directory');
  if (!files.length) {
    const empty = document.createElement('p');
    empty.className = 'files-empty';
    empty.textContent = vaultDir === 'uploads'
      ? 'Nothing uploaded yet. Use Upload files, or drop a file on this window.'
      : 'Nothing here yet. The agent writes this folder as it works.';
    list.append(empty);
  }
  for (const entry of files) {
    const row = document.createElement('div');
    row.className = 'files-row';
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'files-name';
    name.textContent = entry.name;
    name.title = entry.path;
    name.addEventListener('click', () => previewFile(entry.path).catch(e => notify(e.message || 'Could not open that file.', true)));
    const meta = document.createElement('span');
    meta.className = 'files-meta';
    meta.textContent = `${Vault.humanSize(entry.bytes)} · ${new Date(entry.at || Date.now()).toLocaleDateString()}`;
    const get = document.createElement('button');
    get.type = 'button';
    get.className = 'files-act';
    get.textContent = 'Download';
    get.addEventListener('click', () => fetchFromVault(entry.path).catch(e => notify(e.message || 'Could not read that file.', true)));
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'files-act danger';
    drop.textContent = 'Delete';
    drop.addEventListener('click', () => deleteFromVault(entry.path).catch(e => notify(e.message || 'Could not delete that file.', true)));
    row.append(name, meta, get, drop);
    list.append(row);
  }

  const usage = $('files-usage');
  if (usage) {
    try { const totals = await Vault.usage(); usage.textContent = `${Vault.humanSize(totals.used)} used`; } catch { usage.textContent = ''; }
  }
}

async function previewFile(path) {
  const preview = $('files-preview');
  if (!preview) return;
  if (!Vault.isText(path)) {
    preview.hidden = false;
    preview.textContent = 'A binary file. Download it to open it outside Mezze.';
    return;
  }
  const text = await Vault.readText(path);
  preview.hidden = false;
  preview.textContent = text.length > 60000 ? `${text.slice(0, 60000)}\n\n… ${Vault.humanSize(text.length)} in all — download it to read the rest.` : (text || '(empty)');
}

async function uploadToVault(picked = []) {
  if (!picked.length) return;
  let saved = 0;
  for (const file of picked) {
    if (file.size > Vault.MAX_UPLOAD) { notify(`${file.name} is larger than ${Vault.humanSize(Vault.MAX_UPLOAD)}.`, true); continue; }
    const dot = file.name.lastIndexOf('.');
    const ext = dot > 0 ? file.name.slice(dot).toLowerCase().replace(/[^.a-z0-9]/g, '') : '';
    const base = dot > 0 ? file.name.slice(0, dot) : file.name;
    await Vault.writeBlob(`uploads/${Date.now()}-${Vault.slug(base, 40)}${ext}`, file);
    saved += 1;
  }
  if (saved) {
    vaultDir = 'uploads';
    notify(`${saved} file${saved === 1 ? '' : 's'} saved to the vault.`);
  }
  await renderFiles();
}

async function fetchFromVault(path) {
  const blob = await Vault.readBlob(path);
  download(path.split('/').pop(), blob, blob.type || 'application/octet-stream');
}

async function deleteFromVault(path) {
  if (!confirm(`Delete ${path}? This cannot be undone.`)) return;
  await Vault.remove(path);
  notify(`Deleted ${path}.`);
  await renderFiles();
}

async function saveTranscript() {
  if (!lastTranscript) { notify('No transcript yet — transcribe a video first.', true); return; }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const path = `transcripts/${stamp}.md`;
  await Vault.writeText(path, lastTranscript);
  vaultDir = 'transcripts';
  notify(`Transcript saved to ${path}.`);
  await renderFiles();
}

const COMMANDS = [
  { cmd: '/new', hint: 'Start a fresh chat', run: () => newChat() },
  { cmd: '/chats', hint: 'Open chat history', run: () => openHistory() },
  { cmd: '/export', hint: 'Download this chat as Markdown', run: () => exportChat() },
  { cmd: '/plan', hint: 'Always write a checklist first', run: () => setPlanMode('always') },
  { cmd: '/noplan', hint: 'Skip the checklist', run: () => setPlanMode('never') },
  { cmd: '/auto-plan', hint: "Let the agent decide about a checklist", run: () => setPlanMode('auto') },
  { cmd: '/skill', hint: 'Save this run as a reusable skill', run: () => saveSkill().catch(e => notify(e.message || 'Could not save the skill.', true)) },
  { cmd: '/record', hint: 'Record a macro in this tab', run: () => { openMacros(); startRecording().catch(e => notify(e.message || 'Could not start recording.', true)); } },
  { cmd: '/macros', hint: 'Open recorded macros', run: () => openMacros() },
  { cmd: '/transcribe', hint: 'Transcribe the audio of the video on this page', run: () => transcribeCommand().catch(e => notify(e.message || 'Could not transcribe this page.', true)) },
  { cmd: '/script', hint: 'Show the floating transcript player on this page', run: () => openScript().catch(e => notify(e.message || 'Could not open script mode.', true)) },
  { cmd: '/files', hint: 'Open the local vault: memory, reports, uploads', run: () => openFiles().catch(e => notify(e.message || 'Could not open the vault.', true)) },
  { cmd: '/save', hint: 'Save the last transcript to the vault', run: () => saveTranscript().catch(e => notify(e.message || 'Could not save that transcript.', true)) },
  { cmd: '/every', hint: 'Run a task on a schedule, like /every 60 check the inbox', run: () => notify('Type it in the box: /every 60 <task>.') },
  { cmd: '/schedules', hint: 'List or cancel scheduled tasks', run: () => showSchedules().catch(() => {}) },
  { cmd: '/approval', hint: 'How much the agent does without asking', run: () => notify(`Approval: ${Approval.labelFor(posture)}. ${Approval.whyFor(posture)}`) },
  { cmd: '/saw', hint: 'Show the screenshot behind the last step', run: () => openSaw() },
  { cmd: '/timings', hint: 'Open the speed panel', run: () => openTimings() },
  { cmd: '/stop', hint: 'Stop the running workflow', run: () => { stop(); notify('Workflow stopped.'); } }
];
function setPosture(value) {
  const wanted = Approval.read(value);
  posture = wanted;
  chrome.storage.local.set({ approval: posture }).catch(() => {});
  if (workflow) workflow.mode = Approval.modeFor(posture);
  $('approval-mode').value = posture;
  notify(`Approval: ${Approval.labelFor(posture).toLowerCase()}. ${Approval.whyFor(posture)}`);
}
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
// A follow-up message used to start from nothing: the Worker got the new goal and the page, so "do that
// again for the second one" had no referent. The last turns and a digest of the previous run's steps
// travel with every request now, and the Worker clips them before they reach the prompt.
const CHAT_TURNS = 10;
function chatHistory() {
  if (!chat) return [];
  const turns = [];
  for (const message of chat.messages) {
    if (!['user', 'report'].includes(message.role)) continue;
    const text = String(message.text || '').trim();
    if (text) turns.push({ role: message.role === 'user' ? 'user' : 'agent', text });
  }
  const done = chat.done?.length ? chat.done : (chat.steps || []);
  const previous = done.filter(step => step.description).slice(-8);
  if (previous.length) turns.push({ role: 'agent', text: `What I already did in this chat: ${previous.map(step => `${step.type}${step.changed === false ? ' (no page change)' : ''}: ${String(step.description).slice(0, 90)}`).join(' | ')}` });
  return turns.slice(-CHAT_TURNS);
}
// chat.steps only ever held the latest run, so a chat with three runs remembered the third and forgot
// the first two. Completed steps accumulate here, capped, and the digest reads from it.
function rememberSteps(run) {
  if (!run?.steps?.length || !chat || chat.id !== run.chatId) return;
  const seen = new Set((chat.done || []).map(step => step.key));
  const fresh = run.steps
    .filter(step => step.ok && step.description)
    .map(step => ({ key: `${step.type}|${step.description}`, type: step.type, description: step.description, changed: step.changed }))
    .filter(step => !seen.has(step.key));
  if (fresh.length) chat.done = [...(chat.done || []), ...fresh].slice(-40);
}
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
  renderSkills();
}
// Saved skills were write-only: /skill stored them and nothing listed or deleted them.
function renderSkills() {
  const box = $('skill-box'), list = $('skill-list');
  if (!box || !list) return;
  list.textContent = '';
  box.hidden = !skills.length;
  for (const skill of skills) {
    const row = document.createElement('div'); row.className = 'skill-row';
    const name = document.createElement('span'); name.textContent = skill.name || 'Skill'; name.title = skill.description || skill.prompt || '';
    const drop = document.createElement('button'); drop.type = 'button'; drop.title = 'Delete this skill'; drop.setAttribute('aria-label', `Delete ${skill.name || 'skill'}`); setIcon(drop, 'x', 11);
    drop.addEventListener('click', async () => {
      skills = skills.filter(item => item !== skill);
      await chrome.storage.local.set({ skills });
      renderSkills();
      notify(`Deleted “${skill.name || 'skill'}”.`);
    });
    row.append(name, drop); list.append(row);
  }
}
/* ---------- macros ---------- */
// A macro is a recorded sequence of ordinary actions, replayed without a model call. The rules about
// what a step means live here; the capture itself runs in the page (installRecorder in
// background.js), and the locator resolution runs there too, so replay uses trusted CDP input.
const MACROS_KEY = 'macros';
const REC_KEY = 'macro:rec';
const REC_STEPS_KEY = 'macro:steps';

async function saveRec() {
  if (!rec) return;
  await chrome.storage.session.set({
    [REC_STEPS_KEY]: { session: rec.session, name: rec.name, startUrl: rec.startUrl, href: rec.href, steps: rec.steps, lastAt: rec.lastAt }
  }).catch(() => {});
}

function renderMacros() {
  const list = $('macro-list');
  if (!list) return;
  $('macros-btn').classList.toggle('recording', !!rec);
  $('macro-record').hidden = !!rec;
  syncRail().catch(() => {});
  $('rec-box').hidden = !rec;
  if (rec) {
    if ($('rec-name').value !== rec.name) $('rec-name').value = rec.name;
    const box = $('rec-steps'); box.textContent = '';
    if (!rec.steps.length) { const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = 'Nothing yet — click and type in the page. Working in another tab is recorded too.'; box.append(empty); }
    rec.steps.forEach((step, index) => {
      const row = document.createElement('div'); row.className = 'rec-step';
      const text = document.createElement('span'); text.textContent = `${index + 1}. ${Macros.label(step)}`; text.title = Macros.label(step);
      const drop = document.createElement('button'); drop.type = 'button'; drop.title = 'Drop this step'; drop.setAttribute('aria-label', `Drop step ${index + 1}`); setIcon(drop, 'x', 10);
      drop.addEventListener('click', () => { rec.steps = rec.steps.filter((_, at) => at !== index); saveRec(); renderMacros(); });
      row.append(text, drop); box.append(row);
    });
  }
  list.textContent = '';
  if (!macros.length) { const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = 'No macros yet. Record one, then replay it in one click — no model call, no quota.'; list.append(empty); return; }
  for (const macro of macros) {
    const row = document.createElement('div'); row.className = 'macro-row';
    const open = document.createElement('button'); open.type = 'button'; open.className = 'macro-open'; open.title = `Run “${macro.name}” on ${Macros.host(macro.startUrl) || 'this tab'}`;
    const name = document.createElement('strong'); name.textContent = macro.name || 'Macro';
    const meta = document.createElement('span'); meta.className = 'macro-meta';
    meta.textContent = `${Macros.summary(macro)}${macro.lastRun ? ` · last ran ${new Date(macro.lastRun).toLocaleDateString()}` : ''}`;
    open.append(name, meta);
    open.addEventListener('click', () => { $('macros-dialog').close(); runMacro(macro).catch(e => notify(e.message || 'Could not run that macro.', true)); });
    const start = document.createElement('button'); start.type = 'button'; start.className = 'macro-run'; start.title = 'Run without the agent'; start.setAttribute('aria-label', `Run ${macro.name}`); setIcon(start, 'arrow-right', 12);
    start.addEventListener('click', () => { $('macros-dialog').close(); runMacro(macro).catch(e => notify(e.message || 'Could not run that macro.', true)); });
    const drop = document.createElement('button'); drop.type = 'button'; drop.className = 'macro-drop'; drop.title = 'Delete this macro'; drop.setAttribute('aria-label', `Delete ${macro.name}`); setIcon(drop, 'x', 11);
    drop.addEventListener('click', async () => {
      if (macroRun && macroRun.macro.id === macro.id) { notify('Stop the replay before deleting this macro.', true); return; }
      macros = macros.filter(item => item.id !== macro.id);
      await chrome.storage.local.set({ [MACROS_KEY]: macros });
      renderMacros(); notify(`Deleted “${macro.name}”.`);
    });
    // A pinned macro gets an icon on the page rail, so the one you run all day is a click away.
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'macro-drop';
    pin.textContent = macro.pinned ? '\u25cf' : '\u25cb';
    pin.title = macro.pinned ? 'Remove from the page rail' : 'Keep on the page rail';
    pin.setAttribute('aria-label', pin.title);
    pin.setAttribute('aria-pressed', macro.pinned ? 'true' : 'false');
    pin.addEventListener('click', async () => {
      macros = macros.map(item => item.id === macro.id ? { ...item, pinned: !item.pinned } : item);
      await chrome.storage.local.set({ [MACROS_KEY]: macros });
      renderMacros();
      notify(macro.pinned ? 'Removed that macro from the rail.' : 'On the rail — look at the right edge of the page.');
    });
    row.append(open, start, pin, drop); list.append(row);
  }
}

// The rail lives in the page, so the panel pushes it a shaped list whenever macros change.
async function syncRail() {
  if (!globalThis.Macros?.rail) return;
  await send('rail-sync', { entries: Macros.rail(macros) }).catch(() => {});
}

function runMacroById(id) {
  const macro = macros.find(item => item.id === id);
  if (!macro) { notify('That macro is gone — open Macros and check the list.', true); return Promise.resolve(false); }
  if (workflow || macroRun) { notify('Mezze is busy — stop the run before starting a macro.', true); return Promise.resolve(false); }
  runMacro(macro).catch(e => notify(e.message || 'Could not run that macro.', true));
  return Promise.resolve(true);
}
function onMacroEvent(event) {
  if (!rec || !event?.type) return;
  const now = Date.now();
  if (event.type === 'page') {
    if (!event.href || event.href === rec.href) return;
    // A click that navigated already said what happened; a typed address, a back button or a link
    // opened by the page itself did not, so those become a navigation step of their own.
    if (!rec.lastAt || now - rec.lastAt > 4000) rec.steps = Macros.append(rec.steps, { type: 'navigate', url: event.href, at: now });
    rec.href = event.href;
    rec.lastAt = now;
    saveRec(); renderMacros();
    return;
  }
  const step = Macros.prune([{ ...event, at: now }])[0];
  if (!step) return;
  rec.steps = Macros.append(rec.steps, step);
  rec.lastAt = now;
  saveRec(); renderMacros();
}

// Recording outlives one tab. A click that opens a tab, or a person who moves to another tab to carry
// on, keeps the same recording: candidate tabs are armed so their events exist at all, and the first
// event from a tab other than the current one becomes a switch step. A tab that is only looked at
// records nothing, because nothing happened in it.
const armedTabs = new Set();
async function armRecordTab(tabId) {
  if (!rec || armedTabs.has(tabId)) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url || !/^https?:/i.test(tab.url)) return;
  armedTabs.add(tabId);
  await send('record-target', { tabId }).catch(() => armedTabs.delete(tabId));
}
chrome.tabs.onActivated.addListener(({ tabId }) => { if (rec && tabId !== rec.tabId) armRecordTab(tabId).catch(() => {}); });
// A tab that merely loads in the background is not a place anyone worked, so only the active tab is
// armed on load — that is what catches a popup that opens blank and then navigates.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!rec || tabId === rec.tabId || info.status !== 'complete' || !tab?.active) return;
  armRecordTab(tabId).catch(() => {});
});

function macroEnterTab(tabId, event, senderTab) {
  // Only the tab being looked at counts: a page reloading itself in the background is not a move the
  // person made, and recording it would send a replay to an unrelated tab.
  if (!rec || !senderTab?.active) return;
  const url = event?.type === 'page' ? event.href : senderTab?.url;
  // The same page in another tab is not a move the replay has to make.
  if (!url || !/^https?:/i.test(url) || Macros.pageKey(url) === Macros.pageKey(rec.href)) return;
  rec.tabId = tabId;
  rec.href = url;
  rec.lastAt = Date.now();
  rec.steps = Macros.append(rec.steps, { type: 'switch', url, title: event?.title || senderTab?.title || '', at: rec.lastAt });
  saveRec(); renderMacros();
  notify(`Recording continues in ${Macros.host(url) || 'another tab'}.`);
}

async function startRecording() {
  if (rec) return;
  if (workflow || macroRun) throw new Error('Stop the run in progress before recording.');
  await listTabs().catch(() => {});
  const tab = tabCache.find(t => t.id === actingTabId) || tabCache.find(t => t.active) || tabCache[0];
  if (!tab?.id) throw new Error('Open a webpage first.');
  if (!tab.supported) throw new Error('This page cannot be recorded. Chrome internal pages are blocked.');
  await permission(tab.url);
  const session = crypto.randomUUID();
  const out = await send('record-start', { tabId: tab.id, session });
  rec = { session, tabId: out.tabId, startUrl: out.url, href: out.url, steps: [], name: Macros.nameFor(tab.title, out.url), lastAt: 0 };
  armedTabs.clear();
  await saveRec();
  renderMacros();
  notify('Recording. Do the task by hand — switching tabs or opening a new one keeps recording; press Save when you are done.');
}

async function stopRecording() {
  const current = rec;
  rec = null;
  armedTabs.clear();
  await chrome.storage.session.remove(REC_STEPS_KEY).catch(() => {});
  if (current) await send('record-stop', { tabId: current.tabId, session: current.session }).catch(() => {});
  renderMacros();
}

async function saveRecording() {
  if (!rec) return;
  const steps = Macros.prune(rec.steps);
  if (!steps.length) throw new Error('Nothing recorded yet — click or type in the page, then save.');
  const name = ($('rec-name').value || '').trim() || rec.name;
  const macro = { id: crypto.randomUUID(), name: name.slice(0, 60), startUrl: rec.startUrl, host: Macros.host(rec.startUrl), steps, at: Date.now(), runs: 0, lastRun: 0 };
  macros = [macro, ...macros].slice(0, 30);
  await chrome.storage.local.set({ [MACROS_KEY]: macros });
  await stopRecording();
  notify(`Saved “${macro.name}” — ${steps.length} step${steps.length === 1 ? '' : 's'}.`);
}

async function resumeRecording() {
  const saved = await chrome.storage.session.get([REC_KEY, REC_STEPS_KEY]).catch(() => ({}));
  const live = saved[REC_KEY], steps = saved[REC_STEPS_KEY];
  if (!live || !steps || live.session !== steps.session) return;
  const tab = await chrome.tabs.get(live.tabId).catch(() => null);
  if (!tab?.id) { await chrome.storage.session.remove([REC_KEY, REC_STEPS_KEY]).catch(() => {}); return; }
  rec = { session: live.session, tabId: live.tabId, startUrl: steps.startUrl || live.startUrl, href: steps.href || live.startUrl, steps: steps.steps || [], name: steps.name || Macros.nameFor(tab.title, tab.url), lastAt: steps.lastAt || 0 };
  notify('Still recording this tab — open Macros and press Save when you are done.');
}

// One step of a replay. A step waits for its control instead of sleeping, so a slow page is slower,
// not broken; a step that never finds it stops the macro and hands the rest to the agent.
// A switch step names a page, not a tab id: by the time a macro runs the tab that held it may be
// closed, so an open tab with that address is reused and one is opened when there is none. A query
// string that shifted still lands on the right page once a just-opened tab has had a moment to load.
async function switchToRecordedTab(step) {
  await permission(step.url).catch(() => {});
  const exact = Macros.pageKey(step.url), loose = Macros.pageLoose(step.url);
  const here = (await chrome.tabs.get(macroRun.tabId).catch(() => null))?.windowId;
  const pick = list => list.find(tab => tab.windowId === here) || list[0] || null;
  const started = Date.now();
  while (Date.now() - started < 8000) {
    const tabs = (await chrome.tabs.query({}).catch(() => [])).filter(tab => tab.id && tab.url && /^https?:/i.test(tab.url));
    const found = pick(tabs.filter(tab => Macros.pageKey(tab.url) === exact)) || (Date.now() - started > 2500 ? pick(tabs.filter(tab => Macros.pageLoose(tab.url) === loose)) : null);
    if (found) {
      if (!stayPut && !found.active) await chrome.tabs.update(found.id, { active: true }).catch(() => {});
      return found.id;
    }
    await sleep(250);
  }
  const created = await chrome.tabs.create({ url: step.url, active: !stayPut });
  const ready = await waitForTab(created.id, 15000);
  if (!ready?.id) throw new Error(`The tab for ${Macros.host(step.url) || 'that step'} is gone and could not be opened again.`);
  return ready.id;
}

function finishStep(step, result, started, url) {
  const shown = step.type === 'fill' ? 'type' : step.type === 'secret' ? 'wait' : step.type;
  recordActivity({ type: shown, description: Macros.label(step) }, url, result, Math.round(performance.now() - started), null, { changed: result?.effect?.verified !== false });
  currentAction(null);
}

async function playStep(step, index, macro) {
  loading(`Replaying ${index + 1}/${macro.steps.length}`, ICONS[step.type] || 'arrow-right');
  currentAction(Macros.label(step));
  const started = performance.now();
  let tab = await chrome.tabs.get(macroRun.tabId).catch(() => null);
  // The person moved tab while doing the task, so the replay follows the page instead of driving
  // whichever tab it happened to start in.
  if (step.type === 'switch') {
    const moved = await switchToRecordedTab(step);
    macroRun.tabId = moved;
    actingTabId = moved;
    tab = await chrome.tabs.get(moved).catch(() => null);
    renderTabs();
    return finishStep(step, { url: tab?.url || step.url }, started, tab?.url || step.url);
  }
  if (!tab?.url) throw new Error('The tab this macro runs in was closed.');
  const base = { tabId: tab.id, url: tab.url, stayPut, settleMs: settleFor() };
  let result = {};
  if (step.type === 'navigate') {
    await permission(step.url).catch(() => {});
    result = await send('act', { ...base, action: { type: 'navigate', url: step.url, description: Macros.label(step) } });
    await waitForTab(tab.id, 12000);
  } else if (step.type === 'key') {
    result = await send('act', { ...base, action: { type: 'key', key: step.key, description: Macros.label(step) } });
  } else {
    const action = { description: Macros.label(step), target: step.target, label: step.label || Macros.label(step) };
    if (step.type === 'fill') { action.type = 'type'; action.text = step.text; }
    else if (step.type === 'select') { action.type = 'select'; action.value = step.value; }
    else action.type = 'click';
    result = await send('act', { ...base, action });
    // The value was never recorded, so the replay stops here and waits for the person to type it.
    if (step.type === 'secret') await macroHold(`Type your own value into “${step.label || 'that field'}” in the page, then press Continue.`);
  }
  finishStep(step, result, started, result?.url || tab.url);
}

function macroHold(message) {
  const run = macroRun;
  if (!run) return Promise.resolve();
  $('loading').hidden = true;
  currentAction(null);
  notify(message);
  $('pause').hidden = false;
  setIcon($('pause'), 'arrow-right', 16);
  $('pause').title = 'Continue the macro';
  $('pause').setAttribute('aria-label', 'Continue the macro');
  $('pause').classList.add('held');
  return new Promise(resolve => { run.awaiting = resolve; });
}

function cancelMacro() {
  if (!macroRun) return false;
  macroRun.cancelled = true;
  macroRun.awaiting?.();
  macroRun.awaiting = null;
  return true;
}

async function runMacro(macro) {
  if (workflow || macroRun) throw new Error('Stop what is running first.');
  if (!macro?.steps?.length) throw new Error('That macro has no steps.');
  await listTabs().catch(() => {});
  let tab = tabCache.find(t => t.id === actingTabId) || tabCache.find(t => t.active) || tabCache[0];
  if (!tab?.id) throw new Error('Open a webpage first.');
  if (Macros.host(tab.url) !== macro.host) {
    // A macro starts where it was recorded, not wherever the panel happened to be.
    await permission(macro.startUrl);
    await chrome.tabs.update(tab.id, { url: macro.startUrl, active: !stayPut });
    tab = await waitForTab(tab.id, 15000);
    if (!tab?.id) throw new Error('Could not open the page that macro starts on.');
    actingTabId = tab.id;
    renderTabs();
  }
  macroRun = { macro, tabId: tab.id, index: 0, cancelled: false, awaiting: null };
  $('stop').hidden = false; $('start').hidden = true; $('goal').disabled = true; $('run-dot').hidden = false;
  renderMacros();
  pushMessage('note', `Replaying “${macro.name}” — ${macro.steps.length} steps, no model call.`);
  try {
    for (const [index, step] of macro.steps.entries()) {
      if (!macroRun || macroRun.cancelled) break;
      macroRun.index = index;
      await playStep(step, index, macro);
    }
    if (macroRun && !macroRun.cancelled) {
      macro.runs = (macro.runs || 0) + 1;
      macro.lastRun = Date.now();
      await chrome.storage.local.set({ [MACROS_KEY]: macros });
      pushMessage('note', `Macro “${macro.name}” finished — ${macro.steps.length} steps.`);
      notify(`“${macro.name}” finished.`);
    }
  } catch (e) {
    const failed = macroRun?.index || 0;
    notify(`Macro stopped at step ${failed + 1}: ${e.message}`, true);
    pushMessage('note', `Macro stopped at step ${failed + 1} (${Macros.label(macro.steps[failed])}): ${e.message} The rest is in the message box if you want the agent to finish it.`);
    $('goal').value = Macros.recovery(macro, failed, e.message);
    grow();
  } finally {
    macroRun = null;
    $('stop').hidden = true; $('start').hidden = false; $('goal').disabled = false; $('run-dot').hidden = true; $('pause').hidden = true; $('pause').classList.remove('held');
    $('loading').hidden = true;
    currentAction(null);
    renderMacros();
  }
}

function openMacros() { renderMacros(); if (!$('macros-dialog').open) $('macros-dialog').showModal(); }

// The panel never asked the Worker anything but a full run, so a typo in the URL or a missing key only
// showed up as a failed task. /health answers in one request and names the model in use.
async function testConnection() {
  const status = $('worker-status');
  status.hidden = false; status.classList.remove('bad');
  status.textContent = 'Checking…';
  try {
    const res = await fetch(baseUrl() + '/health', { signal: AbortSignal.timeout(8000) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `Worker answered ${res.status}.`);
    if (out.db === false) {
      status.classList.add('bad');
      status.textContent = `Reachable · ${out.model || 'model unknown'} — but this Worker has no database binding, so every task answers 503. Add a D1 binding named DB.`;
      return;
    }
    status.textContent = `Reachable · ${out.model || 'model unknown'} · ${out.provider || 'gemini'}${out.db ? ' · db ok' : ''}`;
  } catch (e) {
    status.classList.add('bad');
    status.textContent = `Not reachable: ${e.message}`;
  }
}
function openHistory() { renderHistory(); if (!$('history-dialog').open) $('history-dialog').showModal(); }
function openSaw() { if (!lastShot) { notify('No screenshot yet — run a task first.', true); return; } $('saw-image').src = lastShot; if (!$('saw-dialog').open) $('saw-dialog').showModal(); }
function hideSuggest() { $('suggest').hidden = true; $('suggest').textContent = ''; }

// A slash token is resolved the moment it is typed, so the composer can show what Enter will do. A
// prefix is enough when it is unambiguous (/tr is /transcribe), which is the point of the chip: you can
// see what was understood before it is sent.
function slashToken(name) {
  const token = String(name || '').toLowerCase().replace(/^\/+/, '');
  if (!token) return null;
  const slug = value => ('/' + value).toLowerCase().replace(/[^a-z0-9/]+/g, '-');
  const exact = COMMANDS.find(command => command.cmd.slice(1).toLowerCase() === token);
  const near = exact ? [exact] : COMMANDS.filter(command => command.cmd.slice(1).toLowerCase().startsWith(token));
  if (near.length === 1) return { kind: 'command', label: near[0].cmd, hint: near[0].hint, command: near[0] };
  const saved = skills.find(skill => slug(skill.name) === '/' + token) || skills.find(skill => slug(skill.name).slice(1).startsWith(token));
  if (saved) return { kind: 'skill', label: slug(saved.name), hint: saved.description || 'Run a saved skill', skill: saved };
  const builtin = BUILTIN_SKILLS.find(skill => slug(skill.name) === '/' + token) || BUILTIN_SKILLS.find(skill => slug(skill.name).slice(1).startsWith(token));
  if (builtin) return { kind: 'builtin', label: slug(builtin.name), hint: builtin.description, skill: builtin };
  return null;
}

// A command runs first, and whatever the person wrote around it becomes the goal of the run that
// follows, with the command's own output already in the chat as context. That is what makes
// "/tr summarise the third point" mean something: transcribe, then ask the agent about the result.
async function runResolved(resolved, rest = '') {
  if (!resolved) return false;
  $('goal').value = '';
  grow();
  renderChips();
  hideSuggest();
  if (resolved.kind === 'command') {
    try { await resolved.command.run(); }
    catch (e) {
      notify(e.message || 'That command failed.', true);
      if (rest) { $('goal').value = rest; grow(); renderChips(); }
      return true;
    }
    if (!rest) return true;
    // A command that is still running (a transcription, a recording) keeps the instruction in the box
    // rather than firing a run at the wrong moment.
    if (workflow || macroRun || rec || transcribeRun) {
      $('goal').value = rest; grow(); renderChips();
      notify('Left your instruction in the box — the command is still running.', false);
      return true;
    }
    try { await startWorkflow(rest); }
    catch (e) { $('goal').value = rest; grow(); renderChips(); notify(e.message || 'Left your instruction in the box.', true); }
    return true;
  }
  // A skill supplies the method and the person supplies the specifics: the skill's prompt travels with
  // the run and the words after the token are its goal.
  const fallback = resolved.kind === 'skill'
    ? (resolved.skill.prompt || (resolved.skill.steps || []).join(' → '))
    : (resolved.skill.defaultGoal || 'Summarize this page');
  startWorkflow(rest || fallback, resolved.skill).catch(e => notify(e.message || 'Could not run that skill.', true));
  return true;
}

function renderChips() {
  const box = $('command-chips');
  if (!box) return;
  const value = $('goal').value;
  const tokens = [...value.matchAll(/(^|\s)\/([a-z][a-z0-9-]*)/gi)].map(match => {
    const start = match.index + match[1].length;
    return { name: match[2], start, end: start + 1 + match[2].length, rest: `${value.slice(0, start)} ${value.slice(start + 1 + match[2].length)}`.trim() };
  });
  box.textContent = '';
  if (!tokens.length) { box.hidden = true; return; }
  const primary = tokens.findIndex(item => slashToken(item.name));
  tokens.forEach((token, index) => {
    const resolved = slashToken(token.name);
    const runs = index === primary;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'command-chip' + (resolved ? '' : ' unknown');
    const label = document.createElement('strong');
    label.textContent = resolved ? resolved.label : `/${token.name}`;
    const hint = document.createElement('span');
    hint.textContent = resolved ? resolved.hint : 'not a command — sent as text';
    chip.append(label, hint);
    if (resolved && runs) {
      const enter = document.createElement('span');
      enter.className = 'enter';
      enter.textContent = '↵';
      chip.append(enter);
    }
    chip.title = resolved
      ? `${resolved.hint}${runs ? ' — Enter runs this, then the rest of the message is its goal' : ' — click to run it with the message as its goal'}`
      : 'This is not a command, so it will be sent to the agent as text.';
    if (resolved) chip.addEventListener('click', () => { runResolved(resolved, token.rest).catch(() => {}); });
    else chip.addEventListener('click', () => notify('That is not a command. Commands start with / and resolve as you type.', true));
    box.append(chip);
  });
  box.hidden = false;
}
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
  const typed = $('goal').value.trim();
  // Scheduling is handled before resolution: /every carries its own argument, so letting it fall
  // through would run the interval as a goal.
  if (/^\/every\b/i.test(typed)) { event.preventDefault(); $('goal').value = ''; grow(); renderChips(); addScheduleFromText(typed).catch(error => notify(error.message || 'Could not schedule that.', true)); return; }
  if (/^\/schedules\b/i.test(typed)) { event.preventDefault(); $('goal').value = ''; grow(); renderChips(); showSchedules(typed).catch(() => {}); return; }
  if (/^\/approval\b/i.test(typed)) {
    event.preventDefault(); $('goal').value = ''; grow(); renderChips();
    const arg = typed.replace(/^\/approval\s*/i, '').trim().toLowerCase();
    if (!arg) notify(`Approval: ${Approval.labelFor(posture)}. Choose with /approval ask, /approval risky or /approval auto.`);
    else if (Object.prototype.hasOwnProperty.call(Approval.MODES, arg)) setPosture(arg);
    else notify('Try /approval ask, /approval risky or /approval auto.', true);
    return;
  }
  event.preventDefault();
  if (workflow || macroRun) return;
  if (rec) { notify('Save or cancel the recording first.', true); return; }
  const goal = $('goal').value.trim();
  if (!goal) return;
  // The first slash token that resolves is the command; everything else in the message is the goal of
  // whatever follows, whether that is the agent or the skill the token named.
  const token = [...goal.matchAll(/(^|\s)\/([a-z][a-z0-9-]*)/gi)]
    .map(match => { const start = match.index + match[1].length; return { name: match[2], start, end: start + 1 + match[2].length }; })
    .map(item => ({ ...item, resolved: slashToken(item.name) }))
    .find(item => item.resolved);
  if (token) {
    const rest = `${goal.slice(0, token.start)} ${goal.slice(token.end)}`.trim();
    runResolved(token.resolved, rest).catch(() => {});
    return;
  }
  if (goal.length > 4000) { notify('Keep your task under 4,000 characters.', true); return; }
  hideSuggest();
  try { await startWorkflow(goal); } catch (e) { notify(e.message || 'Something went wrong.', true); }
});
$('goal').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('composer').requestSubmit(); } });
$('goal').addEventListener('input', () => { grow(); renderSuggest(); renderChips(); });
$('goal').addEventListener('blur', () => setTimeout(hideSuggest, 150));
$('new-chat').addEventListener('click', () => { newChat().catch(e => notify(e.message || 'Could not start a chat.', true)); });
$('history-btn').addEventListener('click', openHistory);
$('macros-btn').addEventListener('click', openMacros);
$('macros-close').addEventListener('click', event => { event.preventDefault(); $('macros-dialog').close(); });
$('macros-dialog').addEventListener('click', event => { if (event.target === $('macros-dialog')) $('macros-dialog').close(); });
$('macro-record').addEventListener('click', () => startRecording().catch(e => notify(e.message || 'Could not start recording.', true)));
$('rec-save').addEventListener('click', () => saveRecording().catch(e => notify(e.message || 'Could not save the macro.', true)));
$('rec-cancel').addEventListener('click', async () => { await stopRecording(); notify('Recording cancelled.'); });
$('rec-name').addEventListener('input', () => { if (rec) rec.name = $('rec-name').value; });
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
$('settings-btn').addEventListener('click', () => {
  $('plan-mode').value = planMode;
  $('approval-mode').value = posture;
  renderSkills();
  if (!$('settings-dialog').open) $('settings-dialog').showModal();
});
$('settings-close').addEventListener('click', event => { event.preventDefault(); $('settings-dialog').close(); });
$('settings-dialog').addEventListener('click', event => { if (event.target === $('settings-dialog')) $('settings-dialog').close(); });
$('history-dialog').addEventListener('click', event => { if (event.target === $('history-dialog')) $('history-dialog').close(); });
$('saw-dialog').addEventListener('click', event => { if (event.target === $('saw-dialog')) $('saw-dialog').close(); });
$('plan-clear').addEventListener('click', () => { if (workflow) return; plan = []; renderPlan(); schedulePersist(); });
// One run, not a setting: "stop asking" for the remainder of this task without changing the posture
// that every later run starts from.
task('approve-all', async () => {
  const run = workflow;
  if (!run) throw new Error('Start a task first.');
  run.mode = 'autopilot';
  $('approval').hidden = true;
  notify('Running the rest of this task without asking. The setting is unchanged.');
  if (run.queue?.length) await runBatch(run);
});
task('approve', async () => { const run = workflow; if (!run) throw new Error('Start a task first.'); if (!run.queue?.length) throw new Error('Nothing queued — send a message to continue.'); if (run.queue[0]?.type === 'navigate') await permission(run.queue[0].url); if (workflow !== run) return; $('approval').hidden = true; await runBatch(run); });
$('tabs-refresh').addEventListener('click', async () => { try { await listTabs(); } catch (e) { notify(e.message || 'Could not list tabs.', true); } });
$('tabs-current').addEventListener('click', async () => { try { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (!tab?.id) throw new Error('Select a webpage first.'); actingTabId = tab.id; contextIds = contextIds.filter(id => id !== tab.id); renderTabs(); await permission(tab.url); } catch (e) { notify(e.message || 'Something went wrong.', true); } });
$('reject').addEventListener('click', () => { stop(); notify('Stopped without taking the proposed action.'); });
$('stop').addEventListener('click', () => {
  if (macroRun) { cancelMacro(); notify('Macro stopped after this step.'); return; }
  stop(); notify('Workflow stopped. An action already in progress may still finish.');
});
$('pause').addEventListener('click', () => {
  // The same control serves both waits: a paused agent round, and a macro step that needs a value
  // the recorder deliberately refused to store.
  if (macroRun) {
    const resume = macroRun.awaiting;
    macroRun.awaiting = null;
    $('pause').hidden = true; $('pause').classList.remove('held');
    if (resume) { notify('Continuing the macro.'); resume(); }
    return;
  }
  const run = workflow;
  if (!run) return;
  if (run.held) { run.resume?.(); notify('Continuing.'); return; }
  if (run.paused) { run.paused = false; pauseLabel(run); notify('Pause cancelled — carrying on.'); return; }
  run.paused = true; pauseLabel(run); notify('Pausing after this round — the page is yours until you press Continue.');
});
// A closed panel or a tab switch used to lose the last few messages, so flush before it goes away.
document.addEventListener('visibilitychange', () => { if (document.hidden && chat) persist().catch(() => {}); });
$('worker').addEventListener('change', async () => { await chrome.storage.local.set({ worker: $('worker').value.trim().replace(/\/$/, '') }); });
$('bridge-toggle').addEventListener('change', async () => { try { const out = await send('bridge', { on: $('bridge-toggle').checked }); notify(out.connected ? 'Bridge on. Start node bridge/server.mjs to accept MCP clients.' : 'Bridge off.'); } catch (e) { notify(e.message || 'Could not toggle the bridge.', true); } });
$('pointer-toggle').addEventListener('change', async () => { await chrome.storage.local.set({ pointer: $('pointer-toggle').checked }); notify($('pointer-toggle').checked ? 'Pointer on: a green arrow shows where the agent clicks.' : 'Pointer off.'); });
$('check-update').addEventListener('click', async () => {
  if (updateState?.newer) {
    chrome.tabs.create({ url: Update.ZIP_URL });
    notify('Downloading ' + updateState.version + '. Unzip it over the folder you loaded, then press Reload extension.');
    return;
  }
  $('check-update').disabled = true;
  await checkUpdate();
  $('check-update').disabled = false;
});
$('reload-extension').addEventListener('click', () => chrome.runtime.reload());
$('input-mode').addEventListener('change', async () => {
  const value = $('input-mode').value === 'scripted' ? 'scripted' : 'debugger';
  await chrome.storage.local.set({ inputMode: value });
  notify(value === 'scripted'
    ? 'Input: page scripting. No debugging bar — some sites ignore it, and refs and generated writing still need the debugger.'
    : 'Input: debugger. Trusted events, element refs and screenshots; Chrome shows its debugging bar while a run works.');
});
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
$('shadow-toggle').addEventListener('change', async () => {
  shadowMode = $('shadow-toggle').checked;
  await chrome.storage.local.set({ shadow: shadowMode }).catch(() => {});
  notify(shadowMode ? 'Preview only — each step is described, nothing is clicked.' : 'Preview off — actions run for real.');
});
  stayPut = $('stay-toggle').checked;
  await chrome.storage.local.set({ stayPut });
  notify(stayPut ? 'Working in the background — switch tabs freely.' : 'Switching to the working tab before each action.');
});
// Plan mode lived only in /plan, /noplan and /auto-plan; the same three states belong in Settings.
$('plan-mode').addEventListener('change', () => setPlanMode($('plan-mode').value));
$('approval-mode').addEventListener('change', () => setPosture($('approval-mode').value));
$('test-worker').addEventListener('click', testConnection);
$('chat-title').addEventListener('click', openHistory);
// Escape stops a run and Cmd/Ctrl+K jumps to the box, but a dialog owns Escape while it is open.
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !document.querySelector('dialog[open]') && (workflow || macroRun)) {
    event.preventDefault();
    if (macroRun) { cancelMacro(); notify('Macro stopped after this step.'); } else { stop(); notify('Workflow stopped.'); }
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault(); $('goal').focus();
  }
});
$('timings-btn').addEventListener('click', openTimings);
$('timings-close').addEventListener('click', event => { event.preventDefault(); $('timings-dialog').close(); });
$('timings-dialog').addEventListener('click', event => { if (event.target === $('timings-dialog')) $('timings-dialog').close(); });
$('timings-export').addEventListener('click', () => {
  if (!timings.length) { notify('No rounds logged yet.', true); return; }
  download('mezze-timings.json', JSON.stringify(timings, null, 2));
  notify('Timings exported.');
});
$('timings-clear').addEventListener('click', () => {
  timings = [];
  chrome.storage.local.set({ timings });
  renderTimings();
  notify('Timings cleared.');
});
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'player-closed' && scriptTab && sender?.tab?.id === scriptTab) scriptTab = null;
  if (sender?.id && sender.id !== chrome.runtime.id) return;
  if (message?.type === 'pointerBlocked') { notify('Pointer is on, but this page blocks the cursor overlay — the click still went ahead.', true); return; }
  // The session is on the envelope: it belongs to the recording, not to the action it describes.
  if (message?.type === 'macro-event' && rec && message.session === rec.session) {
    // The sender says which tab the event came from, which is how one recording spans several tabs.
    const from = sender?.tab?.id;
    if (from && from !== rec.tabId) macroEnterTab(from, message.event, sender.tab);
    onMacroEvent(message.event);
  }
  if (message?.type === 'transcribe-event' && transcribeRun && message.session === transcribeRun.session && (!sender?.tab?.id || sender.tab.id === transcribeRun.tabId)) {
    onTranscribeEvent(message).catch(() => {});
  }
});

(async () => {
  const saved = await chrome.storage.local.get(['worker', 'chats', 'activeChat', 'approval', 'planMode', 'lastShot', 'skills', 'bridge', 'pointer', 'speed', 'inputMode', 'slowPages', 'stayPut', 'timings', 'macros']);
  macros = Array.isArray(saved.macros) ? saved.macros : [];
  $('worker').value = saved.worker || 'https://webagent.amos-donn.workers.dev';
  skills = Array.isArray(saved.skills) ? saved.skills : [];
  $('bridge-toggle').checked = saved.bridge === true;
  $('pointer-toggle').checked = saved.pointer !== false;
  speed = Object.prototype.hasOwnProperty.call(PACING, saved.speed) ? saved.speed : 'fast';
  slowPages = saved.slowPages === true;
  $('speed').value = speed;
  $('input-mode').value = saved.inputMode === 'scripted' ? 'scripted' : 'debugger';
  shadowMode = saved.shadow === true;
  $('shadow-toggle').checked = shadowMode;
  $('slow-toggle').checked = slowPages;
  stayPut = saved.stayPut !== false;
  $('stay-toggle').checked = stayPut;
  posture = Approval.read(saved.approval);
  $('approval-mode').value = posture;
  planMode = ['auto', 'always', 'never'].includes(saved.planMode) ? saved.planMode : 'auto';
  $('plan-mode').value = planMode;
  lastShot = saved.lastShot || '';
  $('saw-btn').hidden = !lastShot;
  timings = Array.isArray(saved.timings) ? saved.timings : [];
  chats = Array.isArray(saved.chats) ? saved.chats : [];
  chat = chats.find(item => item.id === saved.activeChat) || chats[0] || newChatRecord();
  if (!chats.includes(chat)) chats.unshift(chat);
  plan = chat.plan || [];
  renderChat(); renderPlan();
  if (chat.messages?.length) notify('Restored your last chat. Send a message to keep going, or start a new one.');
  await resumeRecording();
  scriptCache = (await chrome.storage.session.get(SCRIPT_KEY).catch(() => ({})))[SCRIPT_KEY] || {};
  renderMacros();
  listTabs().catch(() => { $('tabs-label').textContent = 'Could not list tabs.'; });
  // A request left by the context menu or a keyboard shortcut waits in session storage.
  const { pending } = await send('pending').catch(() => ({ pending: null }));
  if (pending?.prompt) {
    $('goal').value = pending.prompt;
    grow();
    renderChips();
    notify(pending.site ? 'A request from the page menu is in the box — press send.' : 'A shortcut request is in the box — press send.');
  }
  checkUpdate(true).catch(() => {});
  setInterval(() => checkUpdate(true).catch(() => {}), UPDATE_INTERVAL);
  await autorun();
})();


// A click on the page rail names a macro by id. Replay is the panel's job, so this is where it starts.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== 'macro-run-request') return undefined;
  runMacroById(String(message.id || '')).then(started => respond?.({ started })).catch(() => respond?.({ started: false }));
  return true;
});
