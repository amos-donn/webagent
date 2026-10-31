const $ = id => document.getElementById(id);
let token = '', email = '', workflow = null, proposal = null;
function notify(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); $('notice').hidden = false; }
function baseUrl() { const url = new URL($('worker').value.trim()); if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname)))) throw new Error('Use an HTTPS Worker URL or localhost.'); return url.origin + url.pathname.replace(/\/$/, ''); }
async function permission(value) { const u = new URL(value); if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost','127.0.0.1'].includes(u.hostname))) throw new Error('Only HTTPS and local pages are supported.'); const origins = [`${u.origin}/*`]; if (!await chrome.permissions.contains({ origins }) && !await chrome.permissions.request({ origins })) throw new Error('Site access was not granted.'); }
async function activeUrl() { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (!tab?.url) throw new Error('Select a webpage first.'); return tab.url; }
async function api(path, data) { const res = await fetch(baseUrl() + path, { method: 'POST', headers: { 'Content-Type':'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(data) }); const out = await res.json().catch(() => ({})); if (!res.ok) throw new Error(out.error || `Request failed (${res.status}).`); return out; }
async function send(type, data = {}) { const out = await chrome.runtime.sendMessage({ type, ...data }); if (out.error) throw new Error(out.error); return out.data; }
function authView() { $('auth-form').hidden = !!token; $('signed-in').hidden = !token; $('account-email').textContent = email; $('connection-status').textContent = token ? 'Connected ●' : 'Not connected'; }
function task(id, fn) { $(id).addEventListener('click', async () => { $(id).disabled = true; try { await fn(); } catch (e) { notify(e.message || 'Something went wrong.', true); } finally { $(id).disabled = false; } }); }
async function auth(path) { const base = baseUrl(); await permission(base); const result = await api(path, { email:$('email').value, password:$('password').value, invite:$('invite').value }); token = result.token; email = result.email; $('password').value = ''; $('invite').value = ''; await chrome.storage.local.set({ worker:base, token, email }); authView(); notify('Connected. Your account is ready.'); }
task('login', () => auth('/login')); task('signup', () => auth('/signup'));
task('logout', async () => { await api('/logout', {}); token = ''; email = ''; await chrome.storage.local.remove(['token','email']); authView(); stop(); notify('Signed out.'); });
function stop() { workflow = null; proposal = null; $('approval').hidden = true; $('continue').hidden = true; $('stop').hidden = true; $('start').hidden = false; $('full-access').disabled = false; $('loading').hidden = true; }
function loading(label, icon) { $('loading-label').textContent = label; $('loading-icon').textContent = icon; $('loading').hidden = false; }
function addMessage(text, kind = 'agent') { const el = document.createElement('div'); el.className = `message ${kind}`; el.textContent = text; $('steps').append(el); el.scrollIntoView({ behavior:'smooth', block:'nearest' }); }
function addStep(action, url) { const details = document.createElement('details'); details.className = 'activity'; const summary = document.createElement('summary'); summary.textContent = `${({ click:'⌖', type:'⌨', scroll:'↕', navigate:'↗' })[action.type] || '✳'}  ${action.type.charAt(0).toUpperCase() + action.type.slice(1)}`; const thought = document.createElement('p'); thought.textContent = action.description || 'Action completed.'; const page = document.createElement('p'); page.className = 'page-url'; page.textContent = `Webpage: ${url}`; details.append(summary, thought, page); if (action.type === 'type') { const text = document.createElement('p'); text.textContent = `Text: ${action.text}`; details.append(text); } if (action.type === 'navigate') { const dest = document.createElement('p'); dest.textContent = `Destination: ${action.url}`; details.append(dest); } $('steps').append(details); details.scrollIntoView({ behavior:'smooth', block:'nearest' }); }
async function next(run) {
  if (workflow !== run) return;
  if (run.steps.length >= 30) { addMessage('Stopped at the 30-step limit.'); stop(); return; }
  const url = await activeUrl();
  // Automatic mode cannot request new origins without a user gesture. Pause rather than acting without permission.
  if (run.auto && !await chrome.permissions.contains({ origins:[`${new URL(url).origin}/*`] })) { $('continue').hidden = false; $('loading').hidden = true; notify('This page needs site access. Select Continue to grant permission.'); return; }
  await permission(url); if (workflow !== run) return;
  loading('Reading the webpage', '◉'); const shot = await send('observe'); if (workflow !== run) return;
  const image = $('screenshot'); image.src = `data:image/jpeg;base64,${shot.image}`; await image.decode();
  loading('Thinking about the next step', '✳');
  const { action } = await api('/agent', { goal:run.goal, steps:run.steps, url:shot.url, text:shot.text, image:shot.image, width:image.naturalWidth, height:image.naturalHeight, automatic:run.auto });
  if (workflow !== run) return;
  if (action.type === 'done') { addMessage(action.summary || 'Workflow complete.'); stop(); notify('Workflow complete.'); return; }
  proposal = { tabId:shot.tabId, url:shot.url, width:shot.width, height:shot.height, action:{ ...action } };
  const coordinate = ['click','type'].includes(action.type); $('marker').hidden = !coordinate;
  if (coordinate) { $('marker').style.left = `${action.x / image.naturalWidth * 100}%`; $('marker').style.top = `${action.y / image.naturalHeight * 100}%`; proposal.action.x = action.x / image.naturalWidth * shot.width; proposal.action.y = action.y / image.naturalHeight * shot.height; }
  $('proposal').textContent = `${action.type.toUpperCase()}: ${action.description || 'Review the proposed action.'}${action.type === 'type' ? '\nText: ' + action.text : ''}${action.type === 'navigate' ? '\nDestination: ' + action.url : ''}${action.type === 'scroll' ? '\nDirection: ' + action.direction : ''}`;
  if (run.auto) {
    if (action.type === 'navigate' && !await chrome.permissions.contains({ origins:[`${new URL(action.url).origin}/*`] })) { $('loading').hidden = true; $('approval').hidden = false; notify('The destination needs site access. Approve to grant it.'); return; }
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
task('start', async () => { if (!token) throw new Error('Sign in first.'); const goal = $('goal').value.trim(); if (!goal || goal.length > 4000) throw new Error('Enter an objective of up to 4,000 characters.'); const auto = $('full-access').checked; if (auto && !confirm('Full access will let the agent click, type, navigate, and submit actions without asking each time. Website changes may be irreversible. Continue?')) return; await permission(await activeUrl()); workflow = { goal, steps:[], auto }; const run = workflow; $('steps').textContent = ''; addMessage(goal, 'user'); $('start').hidden = true; $('stop').hidden = false; $('full-access').disabled = true; try { await next(run); } catch (e) { if (workflow === run) stop(); throw e; } });
task('approve', async () => { const run = workflow; if (!proposal || !run) throw new Error('Start a workflow first.'); if (proposal.action.type === 'navigate') await permission(proposal.action.url); try { await execute(run); } catch (e) { if (workflow === run) { $('loading').hidden = true; $('continue').hidden = false; } throw e; } });
task('continue', async () => { const run = workflow; if (!run) return; await permission(await activeUrl()); $('continue').hidden = true; try { await next(run); } catch (e) { if (workflow === run) { $('loading').hidden = true; $('continue').hidden = false; } throw e; } });
$('reject').addEventListener('click', () => { stop(); notify('Workflow stopped without taking the proposed action.'); }); $('stop').addEventListener('click', () => { stop(); notify('Workflow stopped. An action already in progress may still finish.'); });
$('worker').addEventListener('change', async () => { const saved = await chrome.storage.local.get('worker'); if (saved.worker && $('worker').value.trim().replace(/\/$/, '') !== saved.worker) { token = ''; email = ''; await chrome.storage.local.remove(['token','email']); authView(); stop(); notify('Worker changed. Sign in to the new server.'); } });
(async () => { const saved = await chrome.storage.local.get(['worker','token','email']); $('worker').value = saved.worker || 'https://webagent.amos-donn.workers.dev'; token = saved.token || ''; email = saved.email || ''; authView(); })();
