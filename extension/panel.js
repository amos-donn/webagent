const $ = id => document.getElementById(id);
const ICONS = { think:'sparkle', click:'cursor-click', type:'keyboard', read:'book-open-text', scroll:'arrows-down-up', wait:'hourglass', navigate:'arrow-right', key:'key-return' };
const LABELS = { think:'Thinking through', click:'Clicking', type:'Typing', read:'Reading page', scroll:'Scrolling', wait:'Waiting', navigate:'Navigating', key:'Pressing key' };
const STEP_LIMIT = 60;
const MAX_CHATS = 20;
const MAX_MESSAGES = 400;
const RISK = /\b(buy now|place order|pay now|purchase|checkout|transfer|withdraw|delete account|close account|cancel subscription)\b/i;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let workflow = null, proposal = null, plan = [], chats = [], chat = null;
let tabCache = [], actingTabId = null, contextIds = [];
let mode = 'autopilot', planMode = 'auto', lastShot = '', skills = [];

function notify(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); $('notice').hidden = false; }
function setStatus(text) { $('status').textContent = text || ''; $('status').hidden = !text; }
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
async function api(path, data, retries = 2) {
  const base = baseUrl();
  let lastError = new Error('Request failed.');
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(data) });
      const out = await res.json().catch(() => ({}));
      if (res.ok) return out;
      const error = new Error(out.error || `Request failed (${res.status}).`);
      if (res.status < 500 && res.status !== 429) throw error;
      lastError = error;
    } catch (e) {
      lastError = e;
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
function reportText(report) {
  const section = (label, list) => Array.isArray(list) && list.length ? `\n${label}:\n${list.map(item => `- ${item}`).join('\n')}` : '';
  return `${report.headline || VERDICTS[verdictOf(report)].label}\n\n${report.summary || ''}${section('What I did', report.did)}${section('What failed', report.failed)}${section('Could not do', report.blocked)}`.trim();
}
function reportCard(report) {
  const verdict = verdictOf(report);
  const card = document.createElement('div');
  card.className = `message report ${verdict}`;
  const head = document.createElement('div'); head.className = 'report-head';
  const badge = document.createElement('span'); badge.className = 'report-badge'; setIcon(badge, VERDICTS[verdict].icon, 13);
  const title = document.createElement('strong'); title.textContent = report.headline || VERDICTS[verdict].label;
  head.append(badge, title); card.append(head);
  if (report.summary) { const text = document.createElement('p'); text.textContent = report.summary; card.append(text); }
  for (const [key, label] of [['did', 'What I did'], ['failed', 'What failed'], ['blocked', 'Could not do']]) {
    const list = Array.isArray(report[key]) ? report[key] : [];
    if (!list.length) continue;
    const wrap = document.createElement('div'); wrap.className = 'report-list';
    const heading = document.createElement('span'); heading.className = 'overline'; heading.textContent = label.toUpperCase();
    const ul = document.createElement('ul');
    for (const item of list) { const li = document.createElement('li'); li.textContent = item; ul.append(li); }
    wrap.append(heading, ul); card.append(wrap);
  }
  return card;
}
// Before a run reports success it looks at the page again and has the model check its own work; a
// failed check feeds back as a correction instead of ending the run, and the user always gets a report.
async function finalCheck(run, claim, incomplete = []) {
  if (workflow !== run) return;
  loading('Checking the result', 'check');
  $('loading-label').textContent = 'Checking the result against the page';
  let shot = null;
  try { shot = await send('observe', { tabId: run.actingTabId, activate: false }); } catch { /* the transcript still allows a report */ }
  if (workflow !== run) return;
  let report;
  try {
    report = await api('/review', {
      goal: run.goal, claim: claim || '', todos: plan, steps: run.steps,
      url: shot?.url || run.view?.url, title: shot?.title, text: shot?.text || '',
      ...(shot ? { image: shot.image, width: shot.width, height: shot.height } : {})
    });
  } catch (e) {
    if (workflow !== run) return;
    // A check that cannot run must not swallow the result: say so and report the claim as unverified.
    report = { verdict: 'unknown', headline: 'Finished without a final check', did: [], failed: [], blocked: [], needsWork: false, summary: `${claim || 'The task finished.'} The final check could not run: ${e.message}` };
  }
  if (workflow !== run) return;
  if (incomplete?.length) {
    const titles = plan.filter(item => incomplete.includes(item.id)).map(item => `Could not finish: ${item.title}`);
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
    row.append(act, ctx, label); box.append(row);
  }
  const acting = tabCache.find(t => t.id === actingTabId);
  $('tabs-label').textContent = acting ? `★ ${shortTitle(acting)}${contextIds.length ? ` · +${contextIds.length} context` : ''}` : 'No tab selected';
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
  const icon = document.createElement('span'); icon.className = 'welcome-icon'; setIcon(icon, 'asterisk', 15);
  const body = document.createElement('div');
  const strong = document.createElement('strong'); strong.textContent = 'Ready.';
  const p = document.createElement('p'); p.textContent = "Type a task and I'll use the starred tab, plan only when it helps, act on my own, and tick steps off only once they actually change the page. Type / for commands or @ to add another tab as context.";
  body.append(strong, p); box.append(icon, body);
  return box;
}
function renderMessage(message) {
  if (message.role === 'activity') {
    const details = document.createElement('details'); details.className = 'activity' + (message.failure ? ' failed' : '');
    const summary = document.createElement('summary');
    const badges = `${message.failure ? ' · failed' : message.changed === false ? ' · no visible change' : ''}${message.fallback ? ' · retried with a scripted click' : ''}`;
    summary.append(phosphor(ICONS[message.type] || 'sparkle', 13), document.createTextNode(`  ${String(message.type || 'step').charAt(0).toUpperCase() + String(message.type || 'step').slice(1)}${message.elapsed ? ` · ${(message.elapsed / 1000).toFixed(1)}s` : ''}${badges}`));
    const thought = document.createElement('p'); thought.textContent = message.text || 'Action completed.';
    details.append(summary, thought);
    if (message.page) { const page = document.createElement('p'); page.className = 'page-url'; page.textContent = `Webpage: ${message.page}`; details.append(page); }
    if (message.failure) { const error = document.createElement('p'); error.className = 'step-error'; error.textContent = message.failure; details.append(error); details.open = true; }
    if (message.input) { const text = document.createElement('p'); text.textContent = `Text: ${message.input}${message.submit ? ' (then Enter)' : ''}`; details.append(text); }
    if (message.destination) { const dest = document.createElement('p'); dest.textContent = `Destination: ${message.destination}`; details.append(dest); }
    if (message.excerpt) { const excerpt = document.createElement('p'); excerpt.textContent = `Read: ${message.excerpt}`; details.append(excerpt); }
    return details;
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
  const lines = [`# ${target.title || 'Webagent chat'}`, '', `Goal: ${target.goal || '(none)'}`, `Started: ${new Date(target.at || Date.now()).toLocaleString()}`, ''];
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
    } else if (message.role === 'note') lines.push(`> ${message.text}`);
    else lines.push(`**${message.role === 'user' ? 'You' : 'Webagent'}:** ${message.text}`, '');
  }
  return lines.join('\n');
}
function exportChat() {
  const target = chat;
  if (!target) return;
  download(`webagent-${(target.title || 'chat').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}.md`, markdown(target));
  notify('Exported this chat as Markdown.');
}

/* ---------- workflow ---------- */
function stop() {
  workflow = null; proposal = null; currentAction(null);
  $('approval').hidden = true; $('stop').hidden = true; $('start').hidden = false;
  $('goal').disabled = false; $('mode').disabled = false; $('loading').hidden = true;
  setStatus('');
  renderPlan(); persist().catch(() => {});
}
function loading(label, icon = 'spinner-gap') {
  $('loading-label').textContent = label;
  setIcon($('loading-icon'), icon, 17);
  $('loading-icon').classList.toggle('spin', icon === 'spinner-gap' || icon === 'circle-notch');
  $('loading').hidden = false; setStatus(label);
}
function currentAction(label) {
  const existing = $('current-action');
  if (!label) { existing?.remove(); return; }
  if (existing) existing.replaceChildren(phosphor('sparkle', 11), document.createTextNode(` ${label}`));
  else { const row = document.createElement('div'); row.id = 'current-action'; row.className = 'message current'; row.replaceChildren(phosphor('sparkle', 11), document.createTextNode(` ${label}`)); $('steps').append(row); }
  $('current-action').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function recordActivity(action, url, result, elapsed, failure, meta = {}) {
  if (!chat) return;
  const message = {
    role: 'activity', type: action.type, text: action.description || '',
    elapsed: elapsed || 0, failure: failure || '', changed: meta.changed, fallback: meta.fallback, page: url,
    input: action.type === 'type' ? action.text : undefined, submit: action.submit,
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
  if (run.steps.length >= STEP_LIMIT) { pushMessage('note', `Stopped at the ${STEP_LIMIT}-action limit. Start a new chat to keep going.`); stop(); return; }
  await listTabs().catch(() => {});
  const acting = tabCache.find(t => t.id === run.actingTabId) || tabCache.find(t => t.active) || tabCache[0];
  if (!acting) throw new Error('No open tab found. Open a webpage first.');
  if (!acting.supported) throw new Error('The acting tab is not supported. Pick an HTTPS page — Chrome internal pages are blocked.');
  run.actingTabId = acting.id;
  const contexts = tabCache.filter(t => run.contextIds.includes(t.id) && t.id !== acting.id && t.supported).slice(0, 5);
  try { await permission(); }
  catch (e) { if (workflow !== run) return; halt(run, e.message); return; }
  let shot = prefetched;
  if (!shot) { loading(`Reading ${shortTitle(acting)}`, 'eye'); shot = await send('observe', { tabId: acting.id, activate: true }); if (workflow !== run) return; }
  const hash = textHash(shot.text);
  run.stalled = hash === run.lastHash ? (run.stalled || 0) + 1 : 0;
  run.apiRetries = 0;
  run.lastHash = hash;
  const extra = (await Promise.all(contexts.map(t => send('context', { tabId: t.id }).then(c => c.text ? { url: c.url, title: c.title, text: c.text.slice(0, 4000) } : null).catch(() => null)))).filter(Boolean);
  const image = $('screenshot'); image.src = `data:image/jpeg;base64,${shot.image}`; await image.decode();
  lastShot = `data:image/jpeg;base64,${shot.image}`;
  $('saw-image').src = lastShot; $('saw-btn').hidden = false;
  chrome.storage.local.set({ lastShot }).catch(() => {});
  const scale = image.naturalWidth / shot.width;
  const elements = (shot.elements || []).map(el => ({ role: el.role, name: el.name, x: Math.round(el.x * scale), y: Math.round(el.y * scale), off: el.off, state: el.state }));
  const refs = Array.isArray(shot.refs) ? shot.refs : [];
  run.view = { tabId: shot.tabId, url: shot.url, width: shot.width, height: shot.height, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight };
  const done = plan.filter(item => item.done).length;
  loading(plan.length ? `Thinking · ${done}/${plan.length} plan steps · action ${run.steps.length + 1}/${STEP_LIMIT}` : `Thinking about action ${run.steps.length + 1}`, 'sparkle');
  // Vision is a fallback: it is only attached for thin trees or when the model asks for it.
  const sendImage = run.wantShot || refs.length < 15;
  const started = performance.now();
  const { actions, action, completed, incomplete, memory, needScreenshot, ms } = await api('/agent', { goal:run.goal, intent:[run.goal, ...plan.map(item => item.title)].join('\n'), todos:plan, steps:run.steps, url:shot.url, title:shot.title, text:shot.text, ...(sendImage ? { image: shot.image } : {}), width:image.naturalWidth, height:image.naturalHeight, elements, refs, memory: run.memory || undefined, stalled:run.stalled, automatic:run.mode === 'autopilot', correction: run.correction || undefined, contexts:extra });
  if (memory) run.memory = memory;
  run.correction = '';
  if (needScreenshot && !run.wantShot) { run.wantShot = true; return next(run); }
  run.wantShot = false;
  const elapsed = ms ?? Math.round(performance.now() - started);
  if (workflow !== run) return;
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
    $('approval').hidden = false; $('loading').hidden = true; setStatus('Waiting for you');
    notify(risky ? `Paused before this round because ${risky}. Approve to continue.` : 'Review the queued actions before they run.');
  }
}
async function runBatch(run) {
  while (run.queue.length && workflow === run) {
    const action = run.queue.shift();
    const outcome = await executeOne(run, showProposal(run, action, run.queue.length, true));
    if (outcome === 'recover') { await sleep(300); if (workflow === run) await safeNext(run); return; }
    if (outcome !== 'ok') {
      // Recover in place: re-observe and let the model pick a different route before giving up.
      if (outcome === 'failed' && run.mode !== 'manual' && (run.hardFails || 0) < 2) {
        run.hardFails = (run.hardFails || 0) + 1;
        pushMessage('note', 'That step kept failing, so I’ll look at the page again and try a different route.');
        await sleep(700);
        if (workflow === run) await safeNext(run);
        return;
      }
      halt(run, 'Stopped where the page would not accept the action. The task is back in the box to retry.');
      return;
    }
    if (run.queue.length) { loading('Next queued action', '◌'); await sleep(220); }
  }
  if (workflow !== run) return;
  loading('Waiting for the page', '◌');
  await sleep(600);
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
      await sleep(900);
      if (workflow === run) return safeNext(run);
      return;
    }
    halt(run, e.message || 'Could not continue.');
  }
}
async function executeOne(run, current) {
  if (!current || workflow !== run) return 'stop';
  const action = current.action;
  loading(LABELS[action.type] || 'Working', ICONS[action.type] || '✳');
  currentAction(`Doing ${action.type.toUpperCase()}: ${action.description || ''}`);
  proposal = null;
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
    result = await send('act', { ...current, goal: run.goal, intent: [run.goal, ...plan.map(item => item.title)].join('\n'), allow: run.allow, automatic: run.mode === 'autopilot' });
  }
  catch (error) {
    if (workflow !== run) return 'stop';
    if (error.code === 'PAGE_CHANGED' && (run.recovered || 0) < 2) { run.recovered = (run.recovered || 0) + 1; notify('The page shifted while acting. Re-reading it and trying again.'); return 'recover'; }
    run.steps.push({ type: action.type, description: action.description || '', ok: false, changed: false, code: error.code || 'ERROR', note: error.message, page: current.url });
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
  if (result?.notice) pushMessage('note', result.notice);
  const verified = result?.effect?.verified;
  const changed = verified !== false;
  if (changed) { run.evidence = (run.evidence || 0) + 1; run.stalled = 0; run.recovered = 0; run.retries = 0; run.lastHash = ''; run.apiRetries = 0; }
  else run.stalled = (run.stalled || 0) + 1;
  const note = action.type === 'read' && result?.text ? `page excerpt: ${String(result.text).slice(0, 1500)}` : '';
  run.steps.push({ type: action.type, description: action.description || '', ok: true, changed, page: current.url, note, code: result?.code || '', ref: action.ref, x: current.action.x, y: current.action.y, url: action.url, direction: action.direction, text: action.type === 'type' ? action.text : undefined });
  recordActivity(action, current.url, result, 0, null, { changed, fallback: !!result?.fallback });
  currentAction(null);
  return 'ok';
}
async function startWorkflow(goal) {
  await listTabs().catch(() => {});
  const acting = tabCache.find(t => t.id === actingTabId) || tabCache.find(t => t.active) || tabCache[0];
  if (!acting) throw new Error('Open a webpage first.');
  await permission(acting.url);
  if (!chat) { chat = newChatRecord(); chats.unshift(chat); }
  chat.goal = goal; chat.title = goal.slice(0, 60);
  workflow = { goal, steps: [], mode, actingTabId: acting.id, contextIds: [...contextIds], stalled: 0, lastHash: '', queue: [], evidence: 0, unproven: 0, recovered: 0, retries: 0, apiRetries: 0, keepGoing: 0, allow: [new URL(acting.url).origin], memory: null, wantShot: false };
  const run = workflow;
  plan = [];
  pushMessage('user', goal);
  $('goal').value = ''; grow();
  $('suggest').hidden = true;
  $('start').hidden = true; $('stop').hidden = false; $('goal').disabled = true; $('mode').disabled = true;
  loading('Reading the page', 'eye');
  send('group', { tabId: acting.id }).catch(() => {});
  try {
    const observed = send('observe', { tabId: acting.id, activate: true });
    if (planMode === 'never') {
      const shot = await observed;
      if (workflow !== run) return;
      pushMessage('note', 'No checklist for this one — running it directly.');
      await next(run, shot);
      return;
    }
    const [planned, shot] = await Promise.allSettled([api('/plan', { goal, url: acting.url, title: acting.title }), observed]);
    if (workflow !== run) return;
    if (shot.status === 'rejected') throw shot.reason;
    if (planned.status === 'fulfilled' && planned.value.todos?.length) plan = planned.value.todos;
    else if (planMode === 'always') plan = [{ id: '1', title: goal.slice(0, 140), done: false }];
    else pushMessage('note', 'This task is short enough to run without a checklist.');
    renderPlan();
    persist().catch(() => {});
    await next(run, shot.value);
  } catch (e) {
    if (workflow !== run) return;
    $('loading').hidden = true; setStatus('');
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
  { cmd: '/stop', hint: 'Stop the running workflow', run: () => { stop(); notify('Workflow stopped.'); } }
];
function setPlanMode(value) { planMode = value; chrome.storage.local.set({ planMode }); notify(value === 'always' ? 'Every task will get a checklist.' : value === 'never' ? 'Tasks will run without a checklist.' : 'The agent decides whether a checklist helps.'); }
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
    ...skills.filter(skill => ('/' + skill.name).toLowerCase().replace(/[^a-z0-9/]+/g, '-').startsWith('/' + slash[1].toLowerCase())).map(skill => ({ label: '/' + skill.name, hint: skill.description || 'Run a saved skill', apply: () => { $('goal').value = skill.prompt || (skill.steps || []).join(' → '); hideSuggest(); notify('Skill loaded — send the message to run it.'); } }))
  ];
  else if (at) items = tabCache.filter(tab => tab.supported && tab.id !== actingTabId && shortTitle(tab).toLowerCase().includes(at[1].toLowerCase())).slice(0, 6).map(tab => ({ label: `@${shortTitle(tab)}`, hint: 'Add as read-only context', apply: () => { contextIds = [...new Set([...contextIds, tab.id])].slice(0, 5); renderTabs(); $('goal').value = value.replace(/(?:^|\s)@([^\s@]*)$/i, '').trim(); notify(`Added ${shortTitle(tab)} as context.`); hideSuggest(); } }));
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
$('mode').addEventListener('change', () => { mode = $('mode').value; chrome.storage.local.set({ mode }); notify(mode === 'autopilot' ? 'Autopilot: actions run without asking.' : mode === 'auto' ? 'Auto: runs freely but pauses before risky steps.' : 'Approve each round before it runs.'); });
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

(async () => {
  const saved = await chrome.storage.local.get(['worker', 'chats', 'activeChat', 'mode', 'planMode', 'lastShot', 'skills', 'bridge']);
  $('worker').value = saved.worker || 'https://webagent.amos-donn.workers.dev';
  skills = Array.isArray(saved.skills) ? saved.skills : [];
  $('bridge-toggle').checked = saved.bridge === true;
  mode = ['manual', 'auto', 'autopilot'].includes(saved.mode) ? saved.mode : 'autopilot';
  planMode = ['auto', 'always', 'never'].includes(saved.planMode) ? saved.planMode : 'auto';
  $('mode').value = mode;
  lastShot = saved.lastShot || '';
  $('saw-btn').hidden = !lastShot;
  chats = Array.isArray(saved.chats) ? saved.chats : [];
  chat = chats.find(item => item.id === saved.activeChat) || chats[0] || newChatRecord();
  if (!chats.includes(chat)) chats.unshift(chat);
  plan = chat.plan || [];
  renderChat(); renderPlan();
  if (chat.messages?.length) notify('Restored your last chat. Send a message to keep going, or start a new one.');
  listTabs().catch(() => { $('tabs-label').textContent = 'Could not list tabs.'; });
})();
