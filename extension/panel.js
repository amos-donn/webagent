const $ = id => document.getElementById(id);
let token = '', email = '', tokenBase = '', workflow = null, proposal = null, pending = null;
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
async function api(path, data) { const base = baseUrl(); if (token && base !== tokenBase) throw new Error('Worker changed. Sign out and sign in to the new server.'); const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type':'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(data) }); const out = await res.json().catch(() => ({})); if (!res.ok) throw new Error(out.error || `Request failed (${res.status}).`); return out; }
async function send(type, data = {}) { const out = await chrome.runtime.sendMessage({ type, ...data }); if (out.error) throw new Error(out.error); return out.data; }
function authView() { $('auth-form').hidden = !!token; $('signed-in').hidden = !token; $('account-email').textContent = email; $('account-btn').textContent = token ? (email.split('@')[0] || 'Account') : 'Sign in'; $('connection-status').textContent = token ? 'Connected ●' : 'Not connected'; }
function openAuth() { if (!$('auth-dialog').open) $('auth-dialog').showModal(); }
function closeAuth() { if ($('auth-dialog').open) $('auth-dialog').close(); }
function task(id, fn) { $(id).addEventListener('click', async () => { $(id).disabled = true; try { await fn(); } catch (e) { notify(e.message || 'Something went wrong.', true); } finally { $(id).disabled = false; } }); }
async function auth(path) { const base = baseUrl(); await permission(base); const result = await api(path, { email:$('email').value, password:$('password').value, invite:$('invite').value }); token = result.token; email = result.email; tokenBase = base; $('password').value = ''; $('invite').value = ''; await chrome.storage.local.set({ worker:base, token, email }); authView(); closeAuth(); notify('Signed in.'); const queued = pending; pending = null; if (queued) await startWorkflow(queued.goal, queued.auto); }
task('login', () => auth('/login')); task('signup', () => auth('/signup'));
task('logout', async () => { await api('/logout', {}); token = ''; email = ''; tokenBase = ''; await chrome.storage.local.remove(['token','email']); authView(); closeAuth(); stop(); notify('Signed out.'); });
function stop() { workflow = null; proposal = null; $('approval').hidden = true; $('continue').hidden = true; $('stop').hidden = true; $('start').hidden = false; $('goal').disabled = false; $('full-access').disabled = false; $('loading').hidden = true; }
function loading(label, icon) { $('loading-label').textContent = label; $('loading-icon').textContent = icon; $('loading').hidden = false; }
function addMessage(text, kind = 'agent') { const el = document.createElement('div'); el.className = `message ${kind}`; el.textContent = text; $('steps').append(el); el.scrollIntoView({ behavior:'smooth', block:'nearest' }); }
function addStep(action, url) { const details = document.createElement('details'); details.className = 'activity'; const summary = document.createElement('summary'); summary.textContent = `${({ click:'⌖', type:'⌨', scroll:'↕', navigate:'↗' })[action.type] || '✳'}  ${action.type.charAt(0).toUpperCase() + action.type.slice(1)}`; const thought = document.createElement('p'); thought.textContent = action.description || 'Action completed.'; const page = document.createElement('p'); page.className = 'page-url'; page.textContent = `Webpage: ${url}`; details.append(summary, thought, page); if (action.type === 'type') { const text = document.createElement('p'); text.textContent = `Text: ${action.text}`; details.append(text); } if (action.type === 'navigate') { const dest = document.createElement('p'); dest.textContent = `Destination: ${action.url}`; details.append(dest); } $('steps').append(details); details.scrollIntoView({ behavior:'smooth', block:'nearest' }); }
async function next(run) {
  if (workflow !== run) return;
  if (run.steps.length >= 30) { addMessage('Stopped at the 30-step limit.'); stop(); return; }
  await listTabs().catch(() => {});
  const acting = tabCache.find(t => t.id === run.actingTabId) || tabCache.find(t => t.active) || tabCache[0];
  if (!acting) throw new Error('No open tab found. Open a webpage first.');
  if (!acting.supported) throw new Error('The acting tab is not supported. Pick an HTTPS page — Chrome internal pages are blocked.');
  run.actingTabId = acting.id;
  const contexts = tabCache.filter(t => run.contextIds.includes(t.id) && t.id !== acting.id && t.supported).slice(0, 5);
  // Automatic mode cannot request new origins without a user gesture. Pause rather than acting without permission.
  const need = [acting, ...contexts].filter(t => true);
  for (const t of need) {
    if (!await chrome.permissions.contains({ origins:[originPattern(t.url)] })) {
      if (run.auto) { $('continue').hidden = false; $('loading').hidden = true; notify(`“${shortTitle(t)}” needs site access. Select Continue to grant permission.`); return; }
      await permission(t.url); if (workflow !== run) return;
    }
  }
  loading(`Reading ${shortTitle(acting)}`, '◉'); const shot = await send('observe', { tabId: acting.id, activate: true }); if (workflow !== run) return;
  const extra = [];
  for (const t of contexts) {
    try { const c = await send('context', { tabId: t.id }); if (c.text) extra.push({ url: c.url, title: c.title, text: c.text.slice(0, 8000) }); }
    catch { /* context is best-effort; the acting tab still works */ }
  }
  const image = $('screenshot'); image.src = `data:image/jpeg;base64,${shot.image}`; await image.decode();
  loading('Thinking about the next step', '✳');
  const { action } = await api('/agent', { goal:run.goal, steps:run.steps, url:shot.url, text:shot.text, image:shot.image, width:image.naturalWidth, height:image.naturalHeight, automatic:run.auto, contexts:extra });
  if (workflow !== run) return;
  if (action.type === 'done') { addMessage(action.summary || 'Workflow complete.'); stop(); notify('Workflow complete.'); return; }
  proposal = { tabId:shot.tabId, url:shot.url, width:shot.width, height:shot.height, action:{ ...action } };
  const coordinate = ['click','type'].includes(action.type); $('marker').hidden = !coordinate;
  if (coordinate) { $('marker').style.left = `${action.x / image.naturalWidth * 100}%`; $('marker').style.top = `${action.y / image.naturalHeight * 100}%`; proposal.action.x = action.x / image.naturalWidth * shot.width; proposal.action.y = action.y / image.naturalHeight * shot.height; }
  $('proposal').textContent = `${action.type.toUpperCase()}: ${action.description || 'Review the proposed action.'}${action.type === 'type' ? '\nText: ' + action.text : ''}${action.type === 'navigate' ? '\nDestination: ' + action.url : ''}${action.type === 'scroll' ? '\nDirection: ' + action.direction : ''}`;
  if (run.auto) {
    if (action.type === 'navigate' && !await chrome.permissions.contains({ origins:[originPattern(action.url)] })) { $('loading').hidden = true; $('approval').hidden = false; notify('The destination needs site access. Approve to grant it.'); return; }
    await execute(run);
  } else { $('loading').hidden = true; $('approval').hidden = false; notify('Review the proposed action before continuing.'); }
}
async function execute(run) {
  if (!proposal || workflow !== run) return;
  const current = proposal; proposal = null; $('approval').hidden = true;
  loading(({click:'Clicking',type:'Typing',scroll:'Scrolling',navigate:'Navigating'})[current.action.type] || 'Working', ({click:'⌖',type:'⌨',scroll:'↕',navigate:'↗'})[current.action.type] || '✳');
  try { await send('act', current); } catch (error) { if (workflow === run) { $('loading').hidden = true; $('continue').hidden = false; } throw error; }
  if (workflow !== run) return;
  const a = current.action; run.steps.push(`${a.type}: ${a.description}${a.type === 'type' ? ' (text: ' + a.text + ')' : ''}${a.type === 'navigate' ? ' (' + a.url + ')' : ''}`); addStep(a, current.url);
  if (run.auto) { loading('Waiting for the page', '◌'); await new Promise(resolve => setTimeout(resolve, 1500)); if (workflow === run) await next(run); }
  else { $('loading').hidden = true; $('continue').hidden = false; notify('Action completed. Continue when the page has settled.'); }
}
async function startWorkflow(goal, auto) {
  await listTabs().catch(() => {});
  const acting = tabCache.find(t => t.id === actingTabId) || tabCache.find(t => t.active) || tabCache[0];
  if (!acting) throw new Error('Open a webpage first.');
  await permission(acting.url);
  workflow = { goal, steps:[], auto, actingTabId: acting.id, contextIds: [...contextIds] };
  const run = workflow;
  if ($('steps').querySelector('.welcome')) $('steps').textContent = '';
  addMessage(goal, 'user');
  $('goal').value = ''; $('goal').style.height = '';
  $('start').hidden = true; $('stop').hidden = false; $('goal').disabled = true; $('full-access').disabled = true;
  try { await next(run); } catch (e) { if (workflow === run) stop(); throw e; }
}
$('composer').addEventListener('submit', async event => {
  event.preventDefault();
  if (workflow) return;
  const goal = $('goal').value.trim();
  if (!goal) return;
  if (goal.length > 4000) { notify('Keep your task under 4,000 characters.', true); return; }
  const auto = $('full-access').checked;
  if (!token) { pending = { goal, auto }; openAuth(); return; }
  if (auto && !confirm('Full access will let the agent click, type, navigate, and submit actions without asking each time. Website changes may be irreversible. Continue?')) return;
  $('goal').value = goal;
  try { await startWorkflow(goal, auto); } catch (e) { notify(e.message || 'Something went wrong.', true); }
});
$('goal').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('composer').requestSubmit(); } });
$('goal').addEventListener('input', () => { $('goal').style.height = 'auto'; $('goal').style.height = `${Math.min($('goal').scrollHeight, 160)}px`; });
$('account-btn').addEventListener('click', openAuth);
$('auth-close').addEventListener('click', event => { event.preventDefault(); closeAuth(); });
$('auth-dialog').addEventListener('click', event => { if (event.target === $('auth-dialog')) closeAuth(); });
task('approve', async () => { const run = workflow; if (!proposal || !run) throw new Error('Start a workflow first.'); if (proposal.action.type === 'navigate') await permission(proposal.action.url); if (workflow !== run) return; try { await execute(run); } catch (e) { if (workflow === run) { $('loading').hidden = true; $('continue').hidden = false; } throw e; } });
task('continue', async () => { const run = workflow; if (!run) return; await listTabs().catch(() => {}); const acting = tabCache.find(t => t.id === run.actingTabId) || tabCache.find(t => t.active); if (acting) await permission(acting.url); else await permission(await activeUrl()); if (workflow !== run) return; $('continue').hidden = true; try { await next(run); } catch (e) { if (workflow === run) { $('loading').hidden = true; $('continue').hidden = false; } throw e; } });
$('tabs-refresh').addEventListener('click', async () => { try { await listTabs(); } catch (e) { notify(e.message || 'Could not list tabs.', true); } });
$('tabs-current').addEventListener('click', async () => { try { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (!tab?.id) throw new Error('Select a webpage first.'); actingTabId = tab.id; contextIds = contextIds.filter(id => id !== tab.id); renderTabs(); await permission(tab.url); } catch (e) { notify(e.message || 'Something went wrong.', true); } });
listTabs().catch(() => { $('tabs-label').textContent = 'Could not list tabs.'; });
$('reject').addEventListener('click', () => { stop(); notify('Workflow stopped without taking the proposed action.'); }); $('stop').addEventListener('click', () => { stop(); notify('Workflow stopped. An action already in progress may still finish.'); });
$('worker').addEventListener('change', async () => { const saved = await chrome.storage.local.get('worker'); if (saved.worker && $('worker').value.trim().replace(/\/$/, '') !== saved.worker) { token = ''; email = ''; tokenBase = ''; await chrome.storage.local.remove(['token','email']); authView(); stop(); notify('Worker changed. Sign in to the new server.'); } });
(async () => { const saved = await chrome.storage.local.get(['worker','token','email']); $('worker').value = saved.worker || 'https://webagent.amos-donn.workers.dev'; token = saved.token || ''; email = saved.email || ''; tokenBase = saved.worker || ''; authView(); })();
