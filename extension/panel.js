const $ = id => document.getElementById(id);
let workflow = null, proposal = null, plan = [];
const ICONS = { think:'💭', click:'⌖', type:'⌨', read:'📖', scroll:'↕', wait:'⏳', navigate:'↗', key:'⏎' };
const LABELS = { think:'Thinking through', click:'Clicking', type:'Typing', read:'Reading page', scroll:'Scrolling', wait:'Waiting', navigate:'Navigating', key:'Pressing key' };
const CONTINUE = 'Continue to next step ↗';
const STEP_LIMIT = 40;
function notify(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); $('notice').hidden = false; }
function baseUrl() { const url = new URL($('worker').value.trim()); if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname)))) throw new Error('Use an HTTPS Worker URL or localhost.'); return url.origin + url.pathname.replace(/\/$/, ''); }
function originPattern(value) { const u = new URL(value); if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost','127.0.0.1'].includes(u.hostname))) throw new Error('Only HTTPS and local pages are supported.'); return `${u.protocol}//${u.hostname}/*`; }
async function permission(value) { const origins = [originPattern(value)]; if (!await chrome.permissions.contains({ origins }) && !await chrome.permissions.request({ origins })) throw new Error('Site access was not granted.'); }
async function activeUrl() { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (!tab?.url) throw new Error('Select a webpage first.'); return tab.url; }
let tabCache = [], actingTabId = null, contextIds = [];
async function listTabs() { const { tabs } = await send('tabs'); tabCache = tabs; const ids = new Set(tabs.map(t => t.id)); if (!ids.has(actingTabId)) actingTabId = (tabs.find(t => t.active) || tabs[0])?.id ?? null; contextIds = contextIds.filter(id => ids.has(id) && id !== actingTabId); renderTabs(); return tabs; }
function shortTitle(t) { const s = (t.title || t.url).trim(); return s.length > 60 ? s.slice(0, 60) + '…' : s; }
function renderTabs() {
  const box = $('tab-list'); box.textContent = '';
  if (!tabCache.length) { box.textContent = 'No tabs found.'; }
  for (const t of tabCache) {
    const row = document.createElement('div'); row.className = 'tab-row' + (t.id === actingTabId ? ' acting' : '');
    const act = document.createElement('button'); act.type = 'button'; act.className = 'tab-btn' + (t.id === actingTabId ? ' on' : ''); act.textContent = '★'; act.title = 'Act in this tab'; act.setAttribute('aria-label', `Act in ${shortTitle(t)}`);
    act.addEventListener('click', async () => { actingTabId = t.id; contextIds = contextIds.filter(id => id !== t.id); renderTabs(); try { await permission(t.url); } catch (e) { notify(e.message || 'Site access was not granted.', true); } });
    const ctx = document.createElement('button'); ctx.type = 'button'; ctx.className = 'tab-btn' + (contextIds.includes(t.id) ? ' on' : ''); ctx.textContent = '+'; ctx.title = 'Include as read-only context'; ctx.setAttribute('aria-label', `Include ${shortTitle(t)} as context`);
    ctx.addEventListener('click', async () => {
      if (t.id === actingTabId) return;
      contextIds = contextIds.includes(t.id) ? contextIds.filter(id => id !== t.id) : [...contextIds, t.id].slice(0, 5);
      renderTabs();
      if (contextIds.includes(t.id)) { try { await permission(t.url); } catch (e) { notify(e.message || 'Site access was not granted.', true); } }
    });
    const label = document.createElement('span'); label.className = 'tab-label'; label.textContent = shortTitle(t); label.title = t.url;
    if (!t.supported) { const tag = document.createElement('span'); tag.className = 'tab-tag'; tag.textContent = 'unsupported'; label.append(' ', tag); }
    row.append(act, ctx, label); box.append(row);
  }
  const acting = tabCache.find(t => t.id === actingTabId);
  $('tabs-label').textContent = acting ? `★ ${shortTitle(acting)}${contextIds.length ? ` · +${contextIds.length} context` : ''}` : 'No tab selected';
}
function renderPlan() {
  const box = $('plan-box'), list = $('plan-list');
  if (!plan.length) { box.hidden = true; return; }
  box.hidden = false;
  list.textContent = '';
  const done = plan.filter(t => t.done).length;
  $('plan-label').textContent = workflow ? 'PLAN' : 'PREVIOUS PLAN';
  $('plan-progress').textContent = `${done}/${plan.length} done`;
  $('plan-clear').hidden = !!workflow;
  for (const item of plan) {
    const li = document.createElement('li'); li.className = 'plan-item' + (item.done ? ' done' : '');
    const mark = document.createElement('span'); mark.className = 'plan-mark'; mark.textContent = item.done ? '✓' : '○';
    const text = document.createElement('span'); text.textContent = item.title;
    li.append(mark, text); list.append(li);
  }
}
function saveSession(run) { chrome.storage.local.set({ session: { goal: run.goal, plan, steps: run.steps, at: Date.now() } }).catch(() => {}); }
function completeTodos(ids = []) {
  let changed = false;
  for (const item of plan) if (!item.done && ids.includes(item.id)) { item.done = true; changed = true; }
  if (changed) renderPlan();
  return changed;
}
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
    if (attempt < retries) await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
  }
  throw lastError;
}
async function send(type, data = {}) { const out = await chrome.runtime.sendMessage({ type, ...data }); if (out.error) throw new Error(out.error); return out.data; }
function task(id, fn) { $(id).addEventListener('click', async () => { $(id).disabled = true; try { await fn(); } catch (e) { notify(e.message || 'Something went wrong.', true); } finally { $(id).disabled = false; } }); }
function stop() { workflow = null; proposal = null; currentAction(null); $('approval').hidden = true; $('continue').hidden = true; $('stop').hidden = true; $('start').hidden = false; $('goal').disabled = false; $('full-access').disabled = false; $('loading').hidden = true; $('continue').textContent = CONTINUE; renderPlan(); }
function loading(label, icon) { $('loading-label').textContent = label; $('loading-icon').textContent = icon; $('loading').hidden = false; }
function addMessage(text, kind = 'agent') { const el = document.createElement('div'); el.className = `message ${kind}`; el.textContent = text; $('steps').append(el); el.scrollIntoView({ behavior:'smooth', block:'nearest' }); }
function currentAction(label) { const el = $('current-action'); if (!label) { if (el) el.remove(); return; } if (el) { el.textContent = `● ${label}`; } else { const row = document.createElement('div'); row.id = 'current-action'; row.className = 'message current'; row.textContent = `● ${label}`; $('steps').append(row); } $('current-action').scrollIntoView({ behavior:'smooth', block:'nearest' }); }
function addStep(action, url, result, elapsed, failure) {
  const details = document.createElement('details'); details.className = 'activity' + (failure ? ' failed' : '');
  const summary = document.createElement('summary');
  summary.textContent = `${ICONS[action.type] || '✳'}  ${action.type.charAt(0).toUpperCase() + action.type.slice(1)}${elapsed ? ` · ${(elapsed / 1000).toFixed(1)}s` : ''}${failure ? ' · failed' : ''}`;
  const thought = document.createElement('p'); thought.textContent = action.description || 'Action completed.';
  const page = document.createElement('p'); page.className = 'page-url'; page.textContent = `Webpage: ${url}`;
  details.append(summary, thought, page);
  if (failure) { const error = document.createElement('p'); error.className = 'step-error'; error.textContent = failure; details.append(error); details.open = true; }
  if (action.type === 'type') { const text = document.createElement('p'); text.textContent = `Text: ${action.text}${action.submit ? ' (then Enter)' : ''}`; details.append(text); }
  if (action.type === 'navigate') { const dest = document.createElement('p'); dest.textContent = `Destination: ${action.url}`; details.append(dest); }
  if (action.type === 'key') { const key = document.createElement('p'); key.textContent = `Key: ${action.key}`; details.append(key); }
  if (action.type === 'wait') { const wait = document.createElement('p'); wait.textContent = `Wait: ${action.seconds}s`; details.append(wait); }
  if (action.type === 'read' && result?.text) { const excerpt = document.createElement('p'); excerpt.textContent = `Read ${result.title || 'page'}: ${String(result.text).slice(0, 500)}`; details.append(excerpt); }
  $('steps').append(details); details.scrollIntoView({ behavior:'smooth', block:'nearest' });
}
function textHash(text) { const value = String(text || ''); let hash = 0; for (let i = 0; i < value.length; i += 5) hash = (hash * 31 + value.charCodeAt(i)) | 0; return `${value.length}:${hash}`; }
async function next(run, prefetched) {
  if (workflow !== run) return;
  if (run.steps.length >= STEP_LIMIT) { addMessage(`Stopped at the ${STEP_LIMIT}-step limit. Start a new task or continue from where it left off.`); stop(); return; }
  $('continue').textContent = CONTINUE;
  await listTabs().catch(() => {});
  const acting = tabCache.find(t => t.id === run.actingTabId) || tabCache.find(t => t.active) || tabCache[0];
  if (!acting) throw new Error('No open tab found. Open a webpage first.');
  if (!acting.supported) throw new Error('The acting tab is not supported. Pick an HTTPS page — Chrome internal pages are blocked.');
  run.actingTabId = acting.id;
  const contexts = tabCache.filter(t => run.contextIds.includes(t.id) && t.id !== acting.id && t.supported).slice(0, 5);
  for (const t of [acting, ...contexts]) {
    if (!await chrome.permissions.contains({ origins:[originPattern(t.url)] })) {
      if (run.auto) { $('continue').hidden = false; $('loading').hidden = true; notify(`“${shortTitle(t)}” needs site access. Select Continue to grant permission.`); return; }
      await permission(t.url); if (workflow !== run) return;
    }
  }
  let shot = prefetched;
  if (!shot) { loading(`Reading ${shortTitle(acting)}`, '◉'); shot = await send('observe', { tabId: acting.id, activate: true }); if (workflow !== run) return; }
  const hash = textHash(shot.text);
  run.stalled = hash === run.lastHash ? (run.stalled || 0) + 1 : 0;
  run.lastHash = hash;
  // Context tabs are independent reads, so fetch them together instead of one after another.
  const extra = (await Promise.all(contexts.map(t => send('context', { tabId: t.id }).then(c => c.text ? { url: c.url, title: c.title, text: c.text.slice(0, 4000) } : null).catch(() => null)))).filter(Boolean);
  const image = $('screenshot'); image.src = `data:image/jpeg;base64,${shot.image}`; await image.decode();
  const scale = image.naturalWidth / shot.width;
  const elements = (shot.elements || []).map(el => ({ role: el.role, name: el.name, x: Math.round(el.x * scale), y: Math.round(el.y * scale) }));
  const done = plan.filter(t => t.done).length;
  loading(plan.length ? `Thinking · ${done}/${plan.length} plan steps done` : 'Thinking about the next step', '✳');
  const started = performance.now();
  const { action, completed, incomplete, ms } = await api('/agent', { goal:run.goal, todos:plan, steps:run.steps, url:shot.url, title:shot.title, text:shot.text, image:shot.image, width:image.naturalWidth, height:image.naturalHeight, elements, stalled:run.stalled, automatic:run.auto, contexts:extra });
  const elapsed = ms ?? Math.round(performance.now() - started);
  if (workflow !== run) return;
  if (completeTodos(completed)) saveSession(run);
  if (action.type === 'done') {
    addMessage(action.summary || 'Workflow complete.');
    saveSession(run);
    if (incomplete?.length) {
      const titles = plan.filter(t => incomplete.includes(t.id)).map(t => t.title);
      $('loading').hidden = true; $('approval').hidden = true;
      $('continue').hidden = false; $('stop').hidden = false; $('continue').textContent = 'Keep working on the plan ↗';
      notify(`Proposed finishing with ${titles.length} unchecked plan step${titles.length === 1 ? '' : 's'}: ${titles.join(' · ')}. Keep working, or Stop.`);
      return;
    }
    stop(); notify('Workflow complete.'); return;
  }
  proposal = { tabId:shot.tabId, url:shot.url, width:shot.width, height:shot.height, action:{ ...action } };
  currentAction(`Proposed ${action.type.toUpperCase()}: ${action.description || ''}`);
  const coordinate = ['click','type'].includes(action.type); $('marker').hidden = !coordinate;
  if (coordinate) { $('marker').style.left = `${action.x / image.naturalWidth * 100}%`; $('marker').style.top = `${action.y / image.naturalHeight * 100}%`; proposal.action.x = action.x / image.naturalWidth * shot.width; proposal.action.y = action.y / image.naturalHeight * shot.height; }
  $('proposal').textContent = `${action.type.toUpperCase()}: ${action.description || 'Review the proposed action.'}${action.type === 'type' ? '\nText: ' + action.text + (action.submit ? ' (then Enter)' : '') : ''}${action.type === 'navigate' ? '\nDestination: ' + action.url : ''}${action.type === 'scroll' ? '\nDirection: ' + action.direction : ''}${action.type === 'wait' ? '\nWait: ' + action.seconds + 's' : ''}${action.type === 'key' ? '\nKey: ' + action.key : ''}`;
  if (run.auto) {
    if (action.type === 'navigate' && !await chrome.permissions.contains({ origins:[originPattern(action.url)] })) { $('loading').hidden = true; $('approval').hidden = false; notify('The destination needs site access. Approve to grant it.'); return; }
    await execute(run, elapsed);
  } else { $('loading').hidden = true; $('approval').hidden = false; notify('Review the proposed action before continuing.'); }
}
async function execute(run, elapsed) {
  if (!proposal || workflow !== run) return;
  const current = proposal; proposal = null; $('approval').hidden = true;
  loading(LABELS[current.action.type] || 'Working', ICONS[current.action.type] || '✳');
  currentAction(`Doing ${current.action.type.toUpperCase()}: ${current.action.description || ''}`);
  let result = {};
  try {
    result = await send('act', current);
  } catch (error) {
    if (workflow !== run) return;
    run.steps.push({ type: current.action.type, description: current.action.description || '', ok: false, note: error.message, page: current.url });
    addStep(current.action, current.url, {}, 0, error.message);
    saveSession(run); currentAction(null);
    $('loading').hidden = true; $('continue').hidden = false;
    notify(`${error.message} Continue to let the agent try a different approach.`, true);
    return;
  }
  if (workflow !== run) return;
  const a = current.action;
  const note = a.type === 'read' && result?.text ? `page excerpt: ${String(result.text).slice(0, 1500)}` : '';
  run.steps.push({ type: a.type, description: a.description || '', ok: true, page: current.url, note, x: current.action.x, y: current.action.y, url: a.url, direction: a.direction, text: a.type === 'type' ? a.text : undefined });
  run.lastHash = ''; run.stalled = 0;
  addStep(a, current.url, result, elapsed); currentAction(null); saveSession(run);
  if (run.auto) { loading('Waiting for the page', '◌'); await new Promise(resolve => setTimeout(resolve, 900)); if (workflow === run) await next(run); }
  else { $('loading').hidden = true; $('continue').hidden = false; notify('Action completed. Continue when the page has settled.'); }
}
async function startWorkflow(goal, auto) {
  await listTabs().catch(() => {});
  const acting = tabCache.find(t => t.id === actingTabId) || tabCache.find(t => t.active) || tabCache[0];
  if (!acting) throw new Error('Open a webpage first.');
  await permission(acting.url);
  workflow = { goal, steps:[], auto, actingTabId: acting.id, contextIds: [...contextIds], stalled:0, lastHash:'' };
  const run = workflow;
  plan = [];
  $('steps').textContent = '';
  $('plan-box').hidden = true;
  addMessage(goal, 'user');
  $('goal').value = ''; $('goal').style.height = '';
  $('start').hidden = true; $('stop').hidden = false; $('goal').disabled = true; $('full-access').disabled = true;
  $('continue').hidden = true; $('continue').textContent = CONTINUE;
  loading('Planning the workflow', '✳');
  try {
    // The plan only needs the goal and starting URL, so it runs while the page is being captured.
    const [planned, observed] = await Promise.allSettled([
      api('/plan', { goal, url: acting.url, title: acting.title }),
      send('observe', { tabId: acting.id, activate: true })
    ]);
    if (workflow !== run) return;
    if (observed.status === 'rejected') throw observed.reason;
    plan = planned.status === 'fulfilled' && planned.value.todos?.length ? planned.value.todos : [{ id:'1', title: goal.slice(0, 140), done:false }];
    renderPlan();
    saveSession(run);
    await next(run, observed.value);
  } catch (e) {
    if (workflow !== run) return;
    $('loading').hidden = true;
    $('continue').hidden = false;
    saveSession(run);
    throw e;
  }
}
$('composer').addEventListener('submit', async event => {
  event.preventDefault();
  if (workflow) return;
  const goal = $('goal').value.trim();
  if (!goal) return;
  if (goal.length > 4000) { notify('Keep your task under 4,000 characters.', true); return; }
  const auto = $('full-access').checked;
  if (auto && !confirm('Full access will let the agent click, type, navigate, and submit actions without asking each time. Website changes may be irreversible. Continue?')) return;
  $('goal').value = goal;
  try { await startWorkflow(goal, auto); } catch (e) { notify(e.message || 'Something went wrong.', true); }
});
$('goal').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('composer').requestSubmit(); } });
$('goal').addEventListener('input', () => { $('goal').style.height = 'auto'; $('goal').style.height = `${Math.min($('goal').scrollHeight, 160)}px`; });
$('settings-btn').addEventListener('click', () => { if (!$('settings-dialog').open) $('settings-dialog').showModal(); });
$('settings-close').addEventListener('click', event => { event.preventDefault(); $('settings-dialog').close(); });
$('settings-dialog').addEventListener('click', event => { if (event.target === $('settings-dialog')) $('settings-dialog').close(); });
$('plan-clear').addEventListener('click', async () => { if (workflow) return; plan = []; renderPlan(); await chrome.storage.local.remove('session'); });
task('approve', async () => { const run = workflow; if (!proposal || !run) throw new Error('Start a workflow first.'); if (proposal.action.type === 'navigate') await permission(proposal.action.url); if (workflow !== run) return; await execute(run); });
task('continue', async () => { const run = workflow; if (!run) return; await listTabs().catch(() => {}); const acting = tabCache.find(t => t.id === run.actingTabId) || tabCache.find(t => t.active); if (acting) await permission(acting.url); else await permission(await activeUrl()); if (workflow !== run) return; $('continue').hidden = true; try { await next(run); } catch (e) { if (workflow === run) { $('loading').hidden = true; $('continue').hidden = false; } throw e; } });
$('tabs-refresh').addEventListener('click', async () => { try { await listTabs(); } catch (e) { notify(e.message || 'Could not list tabs.', true); } });
$('tabs-current').addEventListener('click', async () => { try { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (!tab?.id) throw new Error('Select a webpage first.'); actingTabId = tab.id; contextIds = contextIds.filter(id => id !== tab.id); renderTabs(); await permission(tab.url); } catch (e) { notify(e.message || 'Something went wrong.', true); } });
listTabs().catch(() => { $('tabs-label').textContent = 'Could not list tabs.'; });
$('reject').addEventListener('click', () => { stop(); notify('Workflow stopped without taking the proposed action.'); }); $('stop').addEventListener('click', () => { stop(); notify('Workflow stopped. An action already in progress may still finish.'); });
$('worker').addEventListener('change', async () => { await chrome.storage.local.set({ worker: $('worker').value.trim().replace(/\/$/, '') }); });
(async () => {
  const saved = await chrome.storage.local.get(['worker', 'session']);
  $('worker').value = saved.worker || 'https://webagent.amos-donn.workers.dev';
  const session = saved.session;
  if (!session || !Array.isArray(session.plan) || !session.plan.length) return;
  plan = session.plan;
  $('steps').textContent = '';
  if (session.goal) addMessage(session.goal, 'user');
  for (const step of (session.steps || []).slice(-12)) { const row = document.createElement('p'); row.className = 'restored'; row.textContent = typeof step === 'string' ? step : `${step.type}${step.ok === false ? ' (failed)' : ''}: ${step.description || ''}`; $('steps').append(row); }
  renderPlan();
  if (plan.some(item => !item.done)) notify('Restored an earlier plan with unfinished steps. Clear it or send a new task.');
})();
