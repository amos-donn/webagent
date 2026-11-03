importScripts('schedule.js', 'effect.js', 'pointer.js');
const POINTER = Pointer.geometry();

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
const clip = (value, max) => String(value ?? '').slice(0, max);
class AgentError extends Error { constructor(code, message) { super(message); this.code = code; } }
const fail = (code, message) => { throw new AgentError(code, message); };
// Consequential-looking labels, each with the words a user would use to ask for that outcome.
// A goal is intent, not a list of allowed button words: "clean up my inbox" covers Delete.
const INTENTS = [
  { label: /\b(delete|remove|trash|discard|erase|purge|clear|dismiss|get rid of)\b/i, goal: /\b(delete|remove|trash|discard|erase|purge|clear|clean|empty|dismiss|get rid of|organi[sz]e|tidy)\b/i },
  { label: /\b(pay|buy|purchase|checkout|place order|order now|add to cart|add to bag|donate|subscribe|upgrade)\b/i, goal: /\b(pay|buy|purchase|checkout|order|cart|bag|donate|subscribe|subscription|upgrade|plan|book|reserve|shop|price|cost|deal)\b/i },
  { label: /\b(send|submit|post|publish|share|upload|invite|reply|comment|apply|register|sign up|log in|sign in)\b/i, goal: /\b(send|submit|post|publish|share|upload|invite|reply|comment|apply|register|sign ?up|log ?in|sign ?in|message|email|contact|fill|form|account|profile)\b/i },
  { label: /\b(unsubscribe|deactivate|close account|delete account|cancel|sign out|log out|withdraw|transfer|refund|archive)\b/i, goal: /\b(unsubscribe|deactivate|close|cancel|delete|remove|sign ?out|log ?out|withdraw|transfer|refund|archive|account|subscription|membership)\b/i }
];
const MONEY = /\b(pay|buy|purchase|checkout|place order|transfer|withdraw|delete account|close account)\b/i;
const AX_ROLES = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'slider', 'spinbutton', 'listbox']);
const originOf = value => { try { return new URL(value).origin; } catch { return ''; } };
function permitted(url) { try { const u = new URL(url); return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)); } catch { return false; } }
async function debug(tabId, fn) { const target = { tabId }; await chrome.debugger.attach(target, '1.3'); try { return await fn(target); } finally { await chrome.debugger.detach(target).catch(() => {}); } }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// SPA routing, tracking parameters and trailing slashes change the URL without changing the page.
function samePage(a, b) {
  if (a === b) return true;
  try {
    const x = new URL(a), y = new URL(b);
    if (x.origin !== y.origin || x.pathname.replace(/\/$/, '') !== y.pathname.replace(/\/$/, '')) return false;
    const clean = search => new URLSearchParams([...new URLSearchParams(search)].filter(([key]) => !/^(utm_|fbclid|gclid|ref$|source$)/i.test(key))).toString();
    return clean(x.search) === clean(y.search);
  } catch { return false; }
}
async function getTab(tabId) { const tab = await chrome.tabs.get(tabId); if (!tab?.id || !tab.url) throw new Error('That tab is no longer available. Refresh the tab list.'); return tab; }
// Runs inside the page. Chrome serialises this function, so it must not reference anything outside its own body.
function extractPageData() {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO', 'OBJECT', 'EMBED']);
  const textOf = el => (el.innerText || el.textContent || '').replace(/[\u200b-\u200d\u2060]/g, '').replace(/\s+/g, ' ').trim();
  // Text hidden by CSS is the most common prompt-injection carrier, so it is dropped before the model sees it.
  const visible = el => {
    if (!el || SKIP.has(el.tagName)) return false;
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 6; node = node.parentElement, depth++) {
      if (node.getAttribute?.('aria-hidden') === 'true') return false;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      if (Number(style.opacity) < 0.1) return false;
      if (style.clip === 'rect(0px, 0px, 0px, 0px)' || style.clipPath === 'inset(50%)') return false;
      if (parseFloat(style.fontSize) < 1) return false;
      if (/(^|\s)rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*0\s*\)/.test(style.color)) return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    if (rect.right < -2000 || rect.bottom < -2000) return false;
    return true;
  };
  const scoreOf = node => {
    if (!node || !visible(node)) return 0;
    const total = (node.innerText || '').trim().length;
    if (total < 200) return 0;
    let linkLength = 0;
    for (const link of node.querySelectorAll('a')) linkLength += (link.innerText || '').length;
    const density = linkLength / total;
    if (density > 0.6) return 0;
    return total * (1 - density) + node.querySelectorAll('p,li,td,h1,h2,h3').length * 25;
  };
  let best = null;
  const candidates = [...document.querySelectorAll('main, article, [role=main]'), ...document.body.children];
  for (const el of candidates) { const score = scoreOf(el); if (score > 0 && (!best || score > best.score * 1.05)) best = { el, score }; }
  let container = best?.el;
  if (!container || (container.innerText || '').trim().length < 400) container = document.body;
  const lines = [];
  const seen = new Set();
  const push = value => {
    const line = String(value || '').replace(/[ \t]+/g, ' ').trim();
    if (line.length < 2 || line.length > 1200 || seen.has(line)) return;
    seen.add(line); lines.push(line);
  };
  for (const table of [...container.querySelectorAll('table')].slice(0, 8)) {
    const rows = [...table.querySelectorAll('tr')].slice(0, 40);
    if (!rows.length) continue;
    push(`TABLE: ${textOf(table.querySelector('caption')) || 'table'}`);
    for (const row of rows) {
      const cells = [...row.children].map(cell => textOf(cell).slice(0, 120)).filter(Boolean);
      if (cells.length > 1) push(cells.join(' | '));
    }
  }
  for (const block of container.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading],p,li,dt,dd,blockquote,pre,figcaption,summary')) {
    if (block.closest('table') || !visible(block)) continue;
    const own = textOf(block);
    if (!own) continue;
    if (/^H[1-6]$/.test(block.tagName) || block.getAttribute('role') === 'heading') push(`${'#'.repeat(Math.min(Number(block.tagName?.[1]) || 2, 4))} ${own.slice(0, 300)}`);
    else if (block.tagName === 'LI') push(`- ${own.slice(0, 400)}`);
    else if (block.tagName === 'PRE') push(own.slice(0, 800));
    else push(own.slice(0, 600));
  }
  for (const el of container.querySelectorAll('a[aria-label],button[aria-label],[role=button][aria-label],[role=link][aria-label]')) {
    if (textOf(el)) continue;
    const label = (el.getAttribute('aria-label') || '').trim();
    if (label.length > 1 && label.length < 120) push(`link: ${label}`);
  }
  for (const img of [...container.querySelectorAll('img[alt]')].slice(0, 20)) {
    const alt = (img.getAttribute('alt') || '').trim();
    const rect = img.getBoundingClientRect();
    if (alt.length > 2 && alt.length < 120 && rect.width >= 24 && rect.height >= 24) push(`image: ${alt}`);
  }
  let text = lines.join('\n');
  if (text.length < 400) text = (document.body.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
  const selector = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=menuitem],[role=combobox],[role=switch],[aria-disabled="true"],[contenteditable=""],[contenteditable="true"]';
  const margin = Math.round(innerHeight * 0.9);
  const elements = [];
  let onscreen = 0, offscreen = 0;
  for (const el of document.querySelectorAll(selector)) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 6 || rect.height < 6) continue;
    if (rect.bottom < -margin || rect.top > innerHeight + margin || rect.right < 0 || rect.left > innerWidth) continue;
    if (!visible(el)) continue;
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    const off = y < 4 ? 'above' : y > innerHeight - 4 ? 'below' : '';
    if (off) { if (offscreen >= 30) continue; offscreen += 1; }
    else { if (onscreen >= 70) continue; onscreen += 1; }
    const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!name) continue;
    const role = el.getAttribute('role') || (el.tagName === 'A' ? 'link' : el.tagName === 'INPUT' ? (['submit', 'button'].includes(el.type) ? 'button' : 'input') : el.tagName.toLowerCase());
    const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
    const checked = el.checked === true || el.getAttribute('aria-checked') === 'true';
    elements.push({ role, name, x, y, off, state: disabled ? 'disabled' : checked ? 'checked' : '' });
  }
  return { title: document.title, text: text.slice(0, 40000), elements, width: innerWidth, height: innerHeight };
}
async function readPage(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: extractPageData });
    if (result && typeof result.text === 'string') return result;
  } catch { /* pages that block injection fall back to the simple reader */ }
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: () => ({ title: document.title, text: (document.body?.innerText || '').slice(0, 40000), elements: [], width: innerWidth, height: innerHeight }) });
  return result;
}
async function shoot(tabId) {
  if (await scriptedInput()) {
    // Without the debugger the only capture available is the visible tab, so a run that stays on its
    // own background tab photographs whatever the user is looking at. The setting says so.
    const size = (await pageRun(tabId, () => ({ width: innerWidth, height: innerHeight }))) || { width: 1280, height: 800 };
    const tab = await chrome.tabs.get(tabId);
    const data = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 65 });
    return { image: String(data).replace(/^data:image\/[a-z]+;base64,/, ''), width: size.width, height: size.height };
  }
  return debug(tabId, async target => {
    const metrics = await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics');
    const viewport = metrics.cssVisualViewport || metrics.visualViewport;
    const image = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', { format: 'jpeg', quality: 65, fromSurface: true });
    return { image: image.data, width: viewport.clientWidth, height: viewport.clientHeight };
  });
}
// Accessibility tree: the primary grounding channel. Refs are stable handles for semantic nodes.
async function axSnapshot(tabId) {
  // The accessibility tree is a CDP call, so scripted mode works from the element map and the page text
  // alone: no refs, and therefore no off-screen or shadow-DOM targeting.
  if (await scriptedInput()) return { refs: [], text: '' };
  return debug(tabId, async target => {
    let nodes = [];
    try {
      await chrome.debugger.sendCommand(target, 'Accessibility.enable');
      const tree = await chrome.debugger.sendCommand(target, 'Accessibility.getFullAXTree');
      nodes = tree.nodes || [];
    } catch { return { refs: [], text: '' }; }
    const refs = [], lines = [];
    let index = 0;
    for (const node of nodes) {
      if (node.ignored) continue;
      const role = node.role?.value;
      const backend = node.backendDOMNodeId;
      if (!role || !AX_ROLES.has(role) || !backend) continue;
      const name = String(node.name?.value || '').replace(/\s+/g, ' ').trim();
      if (!name && !['textbox', 'searchbox', 'combobox'].includes(role)) continue;
      const props = Object.fromEntries((node.properties || []).map(p => [p.name, p.value?.value]));
      index += 1;
      const ref = `e${index}`;
      const value = typeof node.value?.value === 'string' ? node.value.value : '';
      const entry = { ref, role, name: name.slice(0, 80), value: value.slice(0, 60), disabled: props.disabled === true, checked: props.checked === true || props.checked === 'true', backend };
      refs.push(entry);
      lines.push(`${role} "${entry.name}" [ref=${ref}]${entry.value ? ` value="${entry.value}"` : ''}${entry.disabled ? ' [disabled]' : ''}${entry.checked ? ' [checked]' : ''}`);
    }
    return { refs: refs.slice(0, 220), text: lines.slice(0, 220).join('\n') };
  });
}
async function saveRefs(tabId, url, refs) {
  const map = {}, names = {};
  for (const ref of refs) { map[ref.ref] = ref.backend; names[ref.ref] = `${ref.role} ${ref.name}`.trim(); }
  await chrome.storage.session.set({ ['ax:' + tabId]: { url, refs: map, names, at: Date.now() } }).catch(() => {});
}
async function loadRefs(tabId) { const key = 'ax:' + tabId; return (await chrome.storage.session.get(key).catch(() => ({})))[key]; }
async function measureNode(target, backend) {
  await chrome.debugger.sendCommand(target, 'DOM.enable').catch(() => {});
  const resolved = await chrome.debugger.sendCommand(target, 'DOM.resolveNode', { backendNodeId: backend }).catch(() => null);
  if (!resolved?.object?.objectId) return null;
  const { result } = await chrome.debugger.sendCommand(target, 'Runtime.callFunctionOn', {
    objectId: resolved.object.objectId,
    functionDeclaration: 'function(){ this.scrollIntoView({block:"center",inline:"center"}); const r=this.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height}; }',
    returnByValue: true
  }).catch(() => ({ result: null }));
  return result?.value || null;
}
// A re-render replaces the node behind a ref, which used to cost a whole round of re-observation.
// The role and name usually survive the re-render, so the same control is found again and used now.
async function healRef(tabId, ref) {
  const stored = await loadRefs(tabId);
  const name = stored?.names?.[ref];
  if (!name) return null;
  const ax = await axSnapshot(tabId).catch(() => ({ refs: [] }));
  const list = Array.isArray(ax?.refs) ? ax.refs : [];
  const match = list.find(entry => `${entry.role} ${entry.name}`.trim() === name)
    || list.find(entry => entry.name.length > 2 && name.endsWith(entry.name));
  // Deliberately not saved: rewriting the ref map mid-action would renumber every other ref.
  return match?.backend || null;
}
async function refBox(tabId, ref, expectedUrl) {
  if (await scriptedInput()) fail('NO_DEBUGGER', 'Element refs need the debugger. Use the element map’s coordinates, or switch Input to Debugger in Settings.');
  const stored = await loadRefs(tabId);
  if (!stored || !stored.refs?.[ref]) fail('STALE_REF', 'That element reference is stale. Read the page again.');
  if (expectedUrl && !samePage(stored.url, expectedUrl)) fail('PAGE_CHANGED', 'That page changed. Observe it again.');
  const live = (await liveViewportSafe(tabId)) || { width: 1280, height: 800 };
  let box = await debug(tabId, target => measureNode(target, stored.refs[ref]));
  if (!box || box.w < 2 || box.h < 2) {
    const healed = await healRef(tabId, ref);
    if (healed) box = await debug(tabId, target => measureNode(target, healed));
  }
  if (!box) fail('STALE_REF', 'That element is no longer on the page.');
  if (box.w < 2 || box.h < 2) fail('NOT_ACTIONABLE', 'That element is not visible right now.');
  return { x: box.x, y: box.y, width: live.width, height: live.height };
}
async function refLabel(tabId, ref) { const stored = await loadRefs(tabId); return stored?.names?.[ref] || ''; }
// The viewport legitimately changes between observing and acting; map the point instead of refusing.
async function liveViewport(target) {
  try {
    const metrics = await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics');
    const view = metrics.cssVisualViewport || metrics.visualViewport || metrics.cssLayoutViewport || metrics.layoutViewport;
    if (view && view.clientWidth > 0 && view.clientHeight > 0) return { width: Math.round(view.clientWidth), height: Math.round(view.clientHeight) };
  } catch { /* fall back to the observed size */ }
  return null;
}
async function liveViewportSafe(tabId) { try { return await debug(tabId, target => liveViewport(target)); } catch { return null; } }
function scalePoint(action, observedWidth, observedHeight, live) {
  const scaleX = live && observedWidth > 0 ? live.width / observedWidth : 1;
  const scaleY = live && observedHeight > 0 ? live.height / observedHeight : 1;
  const maxX = (live?.width ?? observedWidth) - 1, maxY = (live?.height ?? observedHeight) - 1;
  const x = Math.min(Math.max(Math.round(action.x * scaleX), 0), Math.max(maxX, 0));
  const y = Math.min(Math.max(Math.round(action.y * scaleY), 0), Math.max(maxY, 0));
  return { x, y };
}
// Runs inside the page and keeps a mutation counter between calls, so "nothing has changed yet" can
// be told apart from "the page is still busy". The signature itself never includes the counter.
function pageWatched() {
  const text = document.body ? (document.body.innerText || '') : '';
  let hash = 0;
  for (let i = 0; i < text.length; i += 7) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  const active = document.activeElement;
  // The agent's own overlays (cursor, write box) are not page content: counting them would make a
  // click look like it changed the page when only the overlay moved.
  const sig = `${location.href}|${text.length}|${hash}|${document.querySelectorAll('*:not([id^="webagent-"])').length}|${Math.round(scrollY)}|${active ? active.tagName : ''}`;
  const box = window.__webagentWatch || (window.__webagentWatch = { mutations: 0 });
  if (!box.observer) {
    box.mutations = 0;
    box.observer = new MutationObserver(list => { box.mutations += list.length; });
    box.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  return { sig, mutations: box.mutations, resources: (performance.getEntriesByType('resource') || []).length, live: (document.querySelector('[role="status"],[aria-live="polite"],[aria-live="assertive"]')?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200), dialogs: document.querySelectorAll('[role="dialog"],[aria-modal="true"]').length };
}
async function watched(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: pageWatched });
    return result && typeof result === 'object' ? result : null;
  } catch { return null; }
}
// Resource entries and open dialogs join the signature: a click that saves through an API call, or opens
// a dialog with no new text, used to read as "no change". They are appended here rather than inside the
// page so the page keeps its cheap text hash.
function sigOf(state) { return state ? state.sig + '|r' + (Number(state.resources) || 0) + '|d' + (Number(state.dialogs) || 0) : ''; }
async function signature(tabId) { return sigOf(await watched(tabId)); }
// App pages open menus and dialogs a second or two after the click, and a check made after 1.2 seconds
// reads that as a dead click. Wait for the page to go quiet instead: quiet plus a change is a finished
// action, quiet plus no change is a real NO_EFFECT, and a busy page is given the time it needs.
const SETTLE_MAX = 4000;
// A fast run cannot spend four seconds per action waiting for a menu, so the panel sends a budget
// with each action. The module keeps the current one rather than threading it through every call.
let settleBudget = SETTLE_MAX;
async function settle(tabId, before) {
  const span = Math.min(Math.max(Number(settleBudget) || SETTLE_MAX, 400), SETTLE_MAX);
  let latest = before, lastMutations = -1, quiet = 0, changedAt = 0;
  const deadline = Date.now() + span;
  for (let attempt = 0; attempt < 40 && Date.now() < deadline; attempt++) {
    await sleep(attempt < 2 ? 120 : 180);
    const state = await watched(tabId);
    // The tab was navigating or refused injection: the effect is unknown, not disproved.
    if (!state) return '';
    if (state.mutations !== lastMutations) { lastMutations = state.mutations; quiet = 0; } else quiet += 1;
    latest = state.sig || latest;
    const changed = !!before && !!state.sig && state.sig !== before;
    if (changed && !changedAt) changedAt = Date.now();
    // A live page (ticker, feed, animation) never goes fully quiet: report the change once it has
    // settled for a moment instead of waiting out the whole window.
    if (changed && (quiet >= 1 || Date.now() - changedAt > 1200)) return state.sig;
    if (!changed && quiet >= 2 && attempt >= 2) return state.sig || latest;
  }
  return latest;
}
async function readEditable(tabId) {
  try {
    const frames = await chrome.scripting.executeScript({
      target: { tabId }, allFrames: true, func: () => {
        const el = document.activeElement;
        if (!el || el === document.body) return { kind: 'none', value: null, password: false };
        if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') return { kind: 'frame', value: null, password: false };
        const editable = el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'submit', 'button', 'file', 'range', 'color'].includes(el.type)) || el.getAttribute?.('role') === 'textbox';
        if (!editable) return { kind: 'other', value: null, password: false };
        const value = typeof el.value === 'string' ? el.value : (el.innerText || '');
        return { kind: 'editable', value, password: el.type === 'password' };
      }
    });
    const list = frames.map(frame => frame.result).filter(Boolean);
    return list.find(item => item.password) || list.find(item => item.kind === 'editable') || list.find(item => item.kind === 'frame') || list[0] || { kind: 'none', value: null, password: false };
  } catch { return { kind: 'none', value: null, password: false }; }
}
// The purple outline the panel draws over a field while Gemini writes into it. These run inside the
// page, so each one is self-contained and touches no outer variable.
function writeBoxShow(x, y) {
  const id = 'webagent-write-box', styleId = 'webagent-write-box-style';
  document.getElementById(id)?.remove();
  document.getElementById(styleId)?.remove();
  const hit = document.elementFromPoint(x, y);
  const target = hit?.closest('input,textarea,[contenteditable=""],[contenteditable="true"],[role="textbox"]') || hit;
  const rect = target?.getBoundingClientRect();
  if (!rect || rect.width < 2 || rect.height < 2) return false;
  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `#${id}{position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #a855f7;border-radius:10px;box-shadow:0 0 0 4px rgba(168,85,247,.16),0 10px 30px rgba(76,29,149,.22);background:rgba(168,85,247,.05);transition:opacity .16s ease}`
    + `#${id} .wa-chip{position:absolute;top:-29px;left:-2px;display:flex;align-items:center;gap:6px;background:#6d28d9;color:#fff;font:600 11px/1 -apple-system,Arial,sans-serif;padding:7px 9px;border-radius:8px;white-space:nowrap;box-shadow:0 4px 14px rgba(76,29,149,.3)}`
    + `#${id} .wa-chip::before{content:"";width:6px;height:6px;border-radius:50%;background:#d8b4fe;box-shadow:0 0 8px #d8b4fe}`
    + `#${id} .wa-skel{display:flex;flex-direction:column;gap:8px;padding:12px 10px}`
    + `#${id} .wa-skel i{display:block;height:8px;border-radius:5px;background:linear-gradient(90deg,rgba(168,85,247,.16) 25%,rgba(168,85,247,.4) 50%,rgba(168,85,247,.16) 75%);background-size:200% 100%;animation:wa-shimmer 1.2s linear infinite}`
    + `#${id} .wa-skel i:nth-child(2){width:92%}#${id} .wa-skel i:nth-child(3){width:64%}@keyframes wa-shimmer{to{background-position:-200% 0}}`;
  document.head.appendChild(style);
  const box = document.createElement('div');
  box.id = id;
  box.style.left = `${Math.max(Math.round(rect.left) - 6, 0)}px`;
  box.style.top = `${Math.max(Math.round(rect.top) - 6, 0)}px`;
  box.style.width = `${Math.round(rect.width) + 12}px`;
  box.style.height = `${Math.round(rect.height) + 12}px`;
  const chip = document.createElement('span'); chip.className = 'wa-chip'; chip.textContent = 'Gemini is writing…';
  const skeleton = document.createElement('div'); skeleton.className = 'wa-skel';
  for (let i = 0; i < 3; i++) skeleton.append(document.createElement('i'));
  box.append(chip, skeleton);
  document.documentElement.appendChild(box);
  return true;
}
function writeBoxProgress(chars) {
  const box = document.getElementById('webagent-write-box');
  if (!box) return false;
  const chip = box.querySelector('.wa-chip');
  if (chip) chip.textContent = chars ? `Writing · ${chars.toLocaleString()} characters` : 'Gemini is writing…';
  if (chars) box.querySelector('.wa-skel')?.remove();
  return true;
}
function writeBoxHide() {
  document.getElementById('webagent-write-box')?.remove();
  document.getElementById('webagent-write-box-style')?.remove();
  return true;
}
const KEY_MAP = {
  Enter: { code: 'Enter', vk: 13, text: '\r' }, Escape: { code: 'Escape', vk: 27, text: 'Escape' }, Tab: { code: 'Tab', vk: 9, text: '\t' },
  Backspace: { code: 'Backspace', vk: 8 }, Delete: { code: 'Delete', vk: 46 }, Insert: { code: 'Insert', vk: 45 }, Space: { code: 'Space', vk: 32, text: ' ' },
  ArrowUp: { code: 'ArrowUp', vk: 38 }, ArrowDown: { code: 'ArrowDown', vk: 40 }, ArrowLeft: { code: 'ArrowLeft', vk: 37 }, ArrowRight: { code: 'ArrowRight', vk: 39 },
  PageUp: { code: 'PageUp', vk: 33 }, PageDown: { code: 'PageDown', vk: 34 }, Home: { code: 'Home', vk: 36 }, End: { code: 'End', vk: 35 }
};
const KEY_ALIASES = { esc: 'Escape', return: 'Enter', space: 'Space', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', pgup: 'PageUp', pgdn: 'PageDown', pageup: 'PageUp', pagedown: 'PageDown', del: 'Delete', backspace: 'Backspace', insert: 'Insert', home: 'Home', end: 'End', tab: 'Tab', enter: 'Enter' };
const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const MODIFIER_ALIASES = { ctrl: 'Control', control: 'Control', shift: 'Shift', alt: 'Alt', option: 'Alt', meta: 'Meta', cmd: 'Meta', command: 'Meta' };
// A character typed as a real key event has to carry the code and the virtual key a keyboard sends.
// The ASCII value is not those: "." went out as virtual key 46, which is Delete, and "@" went out with
// no Shift and no code, so a page that filters on key codes dropped exactly the characters an email
// address is made of while the field still looked filled in.
const CODE_VK = { Backquote: 192, Minus: 189, Equal: 187, BracketLeft: 219, BracketRight: 221, Backslash: 220, Semicolon: 186, Quote: 222, Comma: 188, Period: 190, Slash: 191, Space: 32, Digit0: 48, Digit1: 49, Digit2: 50, Digit3: 51, Digit4: 52, Digit5: 53, Digit6: 54, Digit7: 55, Digit8: 56, Digit9: 57 };
const UNSHIFTED = { ' ': 'Space', '.': 'Period', ',': 'Comma', '/': 'Slash', ';': 'Semicolon', "'": 'Quote', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash', '-': 'Minus', '=': 'Equal' };
const SHIFTED = { '~': 'Backquote', '!': 'Digit1', '@': 'Digit2', '#': 'Digit3', '$': 'Digit4', '%': 'Digit5', '^': 'Digit6', '&': 'Digit7', '*': 'Digit8', '(': 'Digit9', ')': 'Digit0', '_': 'Minus', '+': 'Equal', '{': 'BracketLeft', '}': 'BracketRight', '|': 'Backslash', ':': 'Semicolon', '"': 'Quote', '<': 'Comma', '>': 'Period', '?': 'Slash' };
UNSHIFTED[String.fromCharCode(96)] = 'Backquote';
const SHIFT_BIT = 8;
function charEvent(char) {
  const plain = UNSHIFTED[char], shifted = SHIFTED[char];
  if (plain) return { key: char, code: plain, windowsVirtualKeyCode: CODE_VK[plain], nativeVirtualKeyCode: CODE_VK[plain], modifiers: 0 };
  if (shifted) return { key: char, code: shifted, windowsVirtualKeyCode: CODE_VK[shifted], nativeVirtualKeyCode: CODE_VK[shifted], modifiers: SHIFT_BIT };
  if (/^[a-z]$/i.test(char)) { const up = char.toUpperCase(); return { key: char, code: 'Key' + up, windowsVirtualKeyCode: up.charCodeAt(0), nativeVirtualKeyCode: up.charCodeAt(0), modifiers: /[A-Z]/.test(char) ? SHIFT_BIT : 0 }; }
  if (/^[0-9]$/.test(char)) return { key: char, code: 'Digit' + char, windowsVirtualKeyCode: char.charCodeAt(0), nativeVirtualKeyCode: char.charCodeAt(0), modifiers: 0 };
  return null;
}
// People navigate with shortcuts (/ for search, Shift+Tab, Control+K), so keys go out as real events.
async function pressKey(target, spec) {
  const parts = String(spec ?? '').split('+').map(part => part.trim()).filter(Boolean);
  if (!parts.length || parts.length > 3) fail('UNSUPPORTED_KEY', 'Unsupported key.');
  let modifiers = 0;
  for (const part of parts.slice(0, -1)) {
    const name = MODIFIER_ALIASES[part.toLowerCase()];
    if (!name) fail('UNSUPPORTED_KEY', `Unsupported modifier: ${clip(part, 20)}.`);
    modifiers |= MODIFIER_BITS[name];
  }
  const raw = parts[parts.length - 1];
  const named = KEY_MAP[raw] || KEY_MAP[KEY_ALIASES[raw.toLowerCase()]];
  const printable = !named && raw.length === 1 && raw >= ' ' && raw <= '~' ? raw : null;
  if (!named && !printable) fail('UNSUPPORTED_KEY', `Unsupported key: ${clip(raw, 20)}.`);
  const shifted = printable && ((modifiers & MODIFIER_BITS.Shift) !== 0 || /[A-Z]/.test(printable));
  const key = named ? (named.code === 'Space' ? ' ' : named.code) : (shifted ? printable.toUpperCase() : printable);
  const text = named ? named.text : ((modifiers & ~MODIFIER_BITS.Shift) !== 0 ? undefined : key);
  const typed = named ? null : charEvent(printable);
  const code = named ? named.code : (typed?.code || '');
  const vk = named ? named.vk : (typed?.windowsVirtualKeyCode || printable.toUpperCase().charCodeAt(0));
  const event = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: (modifiers | (typed?.modifiers || 0)) };
  await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...event, ...(text ? { text, unmodifiedText: printable || text } : {}) });
  await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', ...event });
}
// Canvas editors ignore paste-style inserts, so every character is delivered as a real key event instead.
async function typeKeys(target, text) {
  for (const char of text.slice(0, 5000)) {
    if (char === '\n') {
      await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
      await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      continue;
    }
    const known = charEvent(char) || { key: char, code: '', windowsVirtualKeyCode: char.toUpperCase().charCodeAt(0), nativeVirtualKeyCode: 0, modifiers: 0 };
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyDown', ...known, text: char, unmodifiedText: char });
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', ...known });
  }
}
// A person watching the tab cannot tell where the agent is clicking: CDP input moves no real
// pointer. So the agent draws one — a rounded arrow with no stem, its tip sitting on the click point.
// The shape is a kite rather than a triangle because a triangle reads as "play"; the corners are
// rounded by stroking the same path, so no hand-tuned bezier can drift. Presentation only; every call
// degrades silently and none of it changes the input.
function pointerMove(x, y, geo) {
  const id = 'webagent-pointer';
  let host = document.getElementById(id);
  if (!host) {
    host = document.createElement('div');
    host.id = id;
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147483647';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = geo.wrap + geo.ringCss + geo.arrow;
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    const ring = document.createElement('span');
    ring.className = 'ring';
    // Shape, offsets and pivot come from pointer.js, which the tests read too: the box is offset so the
    // painted tip sits on the click point, and the press animation squashes around that same point.
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'arrow');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    for (const [paint, width] of geo.strokes) {
      const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      shape.setAttribute('d', geo.path);
      shape.setAttribute('fill', paint);
      shape.setAttribute('stroke', paint);
      shape.setAttribute('stroke-width', String(width));
      shape.setAttribute('stroke-linejoin', 'round');
      svg.append(shape);
    }
    wrap.append(ring, svg);
    root.append(style, wrap);
    document.documentElement.appendChild(host);
  }
  const root = host.shadowRoot, wrap = root.querySelector('.wrap'), arrow = root.querySelector('.arrow');
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const from = host.dataset.x ? { x: Number(host.dataset.x), y: Number(host.dataset.y) } : null;
  host.dataset.x = String(Math.round(x));
  host.dataset.y = String(Math.round(y));
  const to = `translate3d(${Math.round(x)}px,${Math.round(y)}px,0)`;
  if (!from) {
    arrow.style.opacity = '1';
    // First appearance: glide in from the nearest edge, so the cursor looks like it entered the page
    // rather than materialising on top of the thing it is about to click.
    const width = (typeof innerWidth === 'number' && innerWidth) || document.documentElement.clientWidth || 1024;
    const offscreen = still ? 26 : 72;
    const startX = Math.round(x) < width / 2 ? -offscreen : width + offscreen;
    const ms = still ? 120 : 380;
    wrap.style.transform = to;
    wrap.animate([{ transform: `translate3d(${startX}px,${Math.round(y)}px,0)` }, { transform: to }], { duration: ms, easing: 'cubic-bezier(.22,.61,.36,1)', fill: 'forwards' }).finished.catch(() => {});
    return ms;
  }
  // Reduced motion shortens the journey instead of removing it: a zero-length slide reads as "no
  // cursor at all", which defeats the whole point of drawing one.
  const distance = Math.hypot(x - from.x, y - from.y);
  const ms = still ? Math.min(110, Math.max(60, Math.round(distance * 0.25))) : Math.min(360, Math.max(140, Math.round(distance * 0.9)));
  arrow.style.opacity = '1';
  wrap.animate([{ transform: `translate3d(${from.x}px,${from.y}px,0)` }, { transform: to }], { duration: ms, easing: 'cubic-bezier(.22,.61,.36,1)', fill: 'forwards' }).finished.catch(() => {});
  return ms;
}
function pointerPress() {
  const host = document.getElementById('webagent-pointer');
  const root = host && host.shadowRoot;
  if (!root) return false;
  const ring = root.querySelector('.ring'), arrow = root.querySelector('.arrow');
  if (!ring || !arrow) return false;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    ring.animate([{ transform: 'scale(.35)', opacity: .9 }, { transform: 'scale(.85)', opacity: 0 }], { duration: 260, easing: 'ease-out' });
    return true;
  }
  ring.animate([{ transform: 'scale(.2)', opacity: .9 }, { transform: 'scale(1)', opacity: 0 }], { duration: 420, easing: 'cubic-bezier(.16,.8,.32,1)' });
  arrow.animate([{ transform: 'scale(1)' }, { transform: 'scale(.87)' }, { transform: 'scale(1)' }], { duration: 190, easing: 'ease-out' });
  return true;
}
async function pointerEnabled() {
  const saved = await chrome.storage.local.get('pointer').catch(() => ({}));
  return saved.pointer !== false;
}
let pointerTold = false;
async function pointerTo(tabId, point) {
  try {
    const [{ result: ms }] = await chrome.scripting.executeScript({ target: { tabId }, func: pointerMove, args: [point.x, point.y, POINTER] });
    if (Number.isFinite(ms) && ms > 0) await sleep(Math.min(ms, 400));
  } catch {
    // Failing silently is why "I see no cursor" has no explanation. Say it once, then keep working.
    if (!pointerTold) {
      pointerTold = true;
      chrome.runtime.sendMessage({ type: 'pointerBlocked' }).catch(() => {});
    }
  }
}
function pointerClick(tabId) {
  chrome.scripting.executeScript({ target: { tabId }, func: pointerPress }).catch(() => {});
}
async function clickPoint(target, point) {
  await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
  await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}
async function clickElement(tabId, point) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId }, func: (x, y) => {
        const el = document.elementFromPoint(x, y);
        if (!el) return false;
        el.scrollIntoView?.({ block: 'nearest' });
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        el.click?.();
        return true;
      }, args: [point.x, point.y]
    });
    return !!result;
  } catch { return false; }
}
// Runs in the page, in the isolated world, and pretends to be a mouse. Every listener the page has on
// the element sees these, which is why it works on ordinary sites; a site that checks isTrusted does
// not, and that is the honest limit of this engine.
function pageScriptClick(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return false;
  el.scrollIntoView?.({ block: 'center', inline: 'center' });
  const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, view: window };
  const pointer = window.PointerEvent ? { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true } : base;
  el.dispatchEvent(new MouseEvent('pointerdown', pointer));
  el.dispatchEvent(new MouseEvent('mousedown', base));
  el.focus?.({ preventScroll: true });
  el.dispatchEvent(new MouseEvent('pointerup', pointer));
  el.dispatchEvent(new MouseEvent('mouseup', base));
  el.dispatchEvent(new MouseEvent('click', base));
  return true;
}
// A framework field ignores a plain value assignment unless the native setter runs and the events
// follow, so the value is set the way React and Vue both expect to see it.
function pageScriptType(text) {
  const el = document.activeElement;
  if (!el || el === document.body) return { ok: false, kind: 'none' };
  if (el.type === 'password') return { ok: false, kind: 'password' };
  if (el.isContentEditable) {
    el.focus();
    const inserted = document.execCommand ? document.execCommand('insertText', false, text) : false;
    if (!inserted) el.textContent = (el.textContent || '') + text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    return { ok: true, kind: 'editable', value: el.textContent || '' };
  }
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    const next = String(el.value || '') + text;
    if (setter) setter.call(el, next); else el.value = next;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, kind: 'editable', value: el.value };
  }
  return { ok: false, kind: 'other' };
}
// Keys a person would press: Enter submits, Escape closes, and a shortcut carries its modifiers.
function pageScriptKey(spec) {
  const parts = String(spec || '').split('+').map(part => part.trim()).filter(Boolean);
  if (!parts.length) return false;
  const names = { ctrl: 'Control', control: 'Control', shift: 'Shift', alt: 'Alt', option: 'Alt', meta: 'Meta', cmd: 'Meta', command: 'Meta' };
  const flags = { Control: false, Shift: false, Alt: false, Meta: false };
  for (const part of parts.slice(0, -1)) { const name = names[part.toLowerCase()]; if (name) flags[name] = true; }
  const raw = parts[parts.length - 1];
  const named = { enter: 'Enter', escape: 'Escape', esc: 'Escape', tab: 'Tab', space: ' ', backspace: 'Backspace', delete: 'Delete', insert: 'Insert', home: 'Home', end: 'End', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', pageup: 'PageUp', pagedown: 'PageDown' };
  const key = named[raw.toLowerCase()] || raw;
  const code = key === ' ' ? 'Space' : (/^[a-z]$/i.test(key) ? 'Key' + key.toUpperCase() : key);
  const init = { key, code, bubbles: true, cancelable: true, composed: true, ...flags };
  const target = document.activeElement || document.body;
  target.dispatchEvent(new KeyboardEvent('keydown', init));
  const commands = flags.Control || flags.Meta || flags.Alt;
  if (key.length === 1 && !commands) {
    const field = document.activeElement;
    if (field && (field.isContentEditable || field.tagName === 'INPUT' || field.tagName === 'TEXTAREA') && document.execCommand) document.execCommand('insertText', false, key);
  }
  target.dispatchEvent(new KeyboardEvent('keyup', init));
  return true;
}
/* ---------- macros: recording and locator replay ---------- */
// A recorded step names its target by meaning — a role and a name, a label, a test id — with the
// structural CSS path kept as a last resort. Everything below runs inside the page, so each function
// is self-contained: Chrome serialises it, so it may not reference anything outside its own body.
const RECORD_KEY = 'macro:rec';
// One page-side DOM toolkit, installed per page and shared by replay, recording and the agent's own
// lookups. It used to be two almost identical copies — a locator, and another inside the recorder — so
// a fix to how a control is named only reached one of them. Chrome serialises an injected function, so
// this stays self-contained and publishes its helpers on the page for the recorder to reuse.
function pageDom(op, payload) {
  const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=radio],[role=menuitem],[role=combobox],[role=switch],[contenteditable=""],[contenteditable="true"]';
  const text = el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  const nameOf = el => {
    const attr = name => (el.getAttribute ? (el.getAttribute(name) || '') : '');
    const aria = attr('aria-label').replace(/\s+/g, ' ').trim();
    if (aria) return aria.slice(0, 120);
    const by = attr('aria-labelledby');
    if (by) {
      const joined = by.split(/\s+/).map(id => document.getElementById(id)).filter(Boolean).map(text).join(' ').trim();
      if (joined) return joined.slice(0, 120);
    }
    const wrap = el.closest ? el.closest('label') : null;
    if (wrap && text(wrap)) return text(wrap).slice(0, 120);
    if (el.id) { const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (label && text(label)) return text(label).slice(0, 120); }
    const placeholder = attr('placeholder');
    if (placeholder) return placeholder.slice(0, 120);
    const own = text(el);
    if (own) return own.slice(0, 120);
    return String(attr('name') || attr('title') || '').slice(0, 120);
  };
  const roleOf = el => {
    const explicit = el.getAttribute ? el.getAttribute('role') : '';
    if (explicit) return explicit.split(/\s+/)[0];
    const tag = el.tagName;
    if (tag === 'A') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'INPUT') {
      const type = (el.type || 'text').toLowerCase();
      if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    return el.isContentEditable ? 'textbox' : 'generic';
  };
  // The agent's own overlays are not page content, so they are never a target.
  const visible = el => {
    if (!el || el.nodeType !== 1 || el.closest?.('[id^="webagent-"]')) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0.05;
  };
  const matches = candidate => {
    try {
      if (candidate.k === 'testid') return [...document.querySelectorAll(`[data-testid="${CSS.escape(candidate.value)}"],[data-test="${CSS.escape(candidate.value)}"],[data-qa="${CSS.escape(candidate.value)}"],[data-cy="${CSS.escape(candidate.value)}"],[data-test-id="${CSS.escape(candidate.value)}"]`)].filter(visible);
      if (candidate.k === 'id') return [...document.querySelectorAll(`#${CSS.escape(candidate.value)}`)].filter(visible);
      if (candidate.k === 'name') return [...document.querySelectorAll(`[name="${CSS.escape(candidate.value)}"]`)].filter(visible);
      if (candidate.k === 'css') return [...document.querySelectorAll(candidate.value)].filter(visible).slice(0, 60);
      if (candidate.k === 'role') return [...document.querySelectorAll(INTERACTIVE)].filter(el => roleOf(el) === candidate.value && nameOf(el) === candidate.name && visible(el));
      if (candidate.k === 'label' || candidate.k === 'text') return [...document.querySelectorAll(INTERACTIVE)].filter(el => nameOf(el) === candidate.value && visible(el)).slice(0, 60);
    } catch { /* a selector the page has since made invalid is skipped, not fatal */ }
    return [];
  };
  const cssPath = el => {
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && parts.length < 6; node = node.parentElement) {
      if (node.id && node.id.length < 50 && !/[0-9a-f]{8}|[0-9]{4,}/i.test(node.id)) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
      let part = node.tagName.toLowerCase();
      const stable = [...(node.classList || [])].filter(name => name.length < 30 && !/\d{3,}|^(_|css-|sc-|jsx-|ng-)/.test(name)).slice(0, 2);
      if (stable.length) part += `.${stable.map(name => CSS.escape(name)).join('.')}`;
      const siblings = node.parentElement ? [...node.parentElement.children].filter(sibling => sibling.tagName === node.tagName) : [];
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      parts.unshift(part);
    }
    return parts.join(' > ');
  };
  // Count the matches now, so replay can tell "the only Save button" from "the third one".
  const candidatesFor = el => {
    const out = [];
    const add = (k, value, extra = {}) => {
      const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
      if (!clean || clean.length > 200) return;
      out.push({ k, value: clean, ...extra });
    };
    for (const attr of ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-test-id']) {
      const value = el.getAttribute?.(attr);
      if (value) { add('testid', value); break; }
    }
    const role = roleOf(el), name = nameOf(el);
    if (role && role !== 'generic' && name) add('role', role, { name });
    if (name) add('label', name);
    const fieldName = el.getAttribute?.('name');
    if (fieldName) add('name', fieldName);
    const id = el.id;
    if (id && id.length < 60 && !/[0-9a-f]{8}-|[0-9]{4,}/i.test(id) && document.querySelectorAll(`#${CSS.escape(id)}`).length === 1) add('id', id);
    const own = text(el);
    if (own && own.length <= 80) add('text', own);
    add('css', cssPath(el));
    return out.map(candidate => {
      const list = matches(candidate);
      return { ...candidate, count: list.length, nth: Math.max(0, list.indexOf(el)) };
    });
  };
  const locate = target => {
    if (!Array.isArray(target) || !target.length) return null;
    for (const candidate of target) {
      const list = matches(candidate);
      if (!list.length) continue;
      const el = list[Math.min(candidate.nth || 0, list.length - 1)];
      if (!el) continue;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), via: candidate.k, count: list.length };
    }
    return null;
  };
  window.__mezzeDom = { INTERACTIVE, text, nameOf, roleOf, visible, matches, cssPath, candidatesFor, locate };
  return op === 'locate' ? locate(payload) : { installed: true };
}
// The recorder runs later, on the page's own events, so the toolkit is installed before it is injected.
async function armDom(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, func: pageDom, args: ['install'] }).catch(() => {});
}
// A step is a condition, not a sleep: wait for the target to exist, up to a budget, so a menu that
// paints 800 ms late still plays back.
async function targetBox(tabId, target, waitMs = 6000) {
  const deadline = Date.now() + Math.min(Math.max(Number(waitMs) || 6000, 500), 15000);
  for (;;) {
    const frames = await chrome.scripting.executeScript({ target: { tabId }, func: pageDom, args: ['locate', target] }).catch(() => []);
    const result = frames?.[0]?.result;
    if (result && Number.isFinite(result.x) && Number.isFinite(result.y)) {
      const live = (await liveViewportSafe(tabId)) || { width: 1280, height: 800 };
      return { x: result.x, y: result.y, width: live.width, height: live.height, via: result.via, count: result.count };
    }
    if (Date.now() >= deadline) return null;
    await sleep(220);
  }
}
// A native select opens an OS-level menu that synthetic input cannot walk, so the value is set the
// way the page's own framework expects: assign, then fire input and change.
function selectOption(x, y, value) {
  const hit = document.elementFromPoint(x, y);
  const select = hit?.closest?.('select') || (hit?.tagName === 'SELECT' ? hit : null);
  if (!select) return { ok: false };
  const wanted = String(value ?? '');
  const option = [...select.options].find(item => item.value === wanted) || [...select.options].find(item => (item.text || '').replace(/\s+/g, ' ').trim() === wanted);
  if (!option) return { ok: false, value: select.value };
  select.value = option.value;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, value: select.value };
}
// What the person actually did. Capture-phase listeners on window, in the isolated world, so a page
// that patches addEventListener cannot blind it. The step is a meaning, and a field that looks like a
// credential is recorded as a placeholder — its value is never sent, never stored.
function installRecorder(session) {
  const KEY = '__mezzeRecorder';
  const previous = window[KEY];
  if (previous?.session === session) return true;
  try { previous?.stop?.(); } catch { /* an old recorder whose page is already gone */ }

  const send = event => { try { chrome.runtime.sendMessage({ type: 'macro-event', session, event }); } catch { /* extension reloaded */ } };
  // The shared toolkit (armDom installs it before injection): recording and replay agree on how a
  // control is named, matched and counted, because there is only one implementation of each.
  const D = window.__mezzeDom;
  if (!D) return false;
  const { text, INTERACTIVE, nameOf, roleOf, visible, matches, cssPath, candidatesFor } = D;
  const harmless = el => !el || !el.closest?.('[id^="webagent-"]');
  const SECRET = /(pass(word|code)?|passwd|otp|one[-_ ]?time|security[-_ ]?code|cvv|cvc|cc[-_ ]?(num|number|exp|csc|name)|card[-_ ]?number|ssn|social[-_ ]?security|iban|routing|\bpin\b)/i;
  const isEditable = el => {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT') return false;
    return !['checkbox', 'radio', 'submit', 'button', 'reset', 'file', 'image', 'range', 'color'].includes((el.type || 'text').toLowerCase());
  };
  // Reveal-password toggles rewrite type=password to text, so the field is judged once, when it is
  // focused, and the verdict is remembered for that element rather than re-read at every keystroke.
  const secrets = new WeakMap();
  const secretOf = el => {
    if (!el) return false;
    if (secrets.has(el)) return secrets.get(el);
    let verdict = false;
    if (el.type === 'password') verdict = true;
    else {
      const auto = el.getAttribute?.('autocomplete') || '';
      if (/(current|new)-password|one-time-code|^cc-/i.test(auto)) verdict = true;
      else verdict = SECRET.test(`${el.getAttribute?.('name') || ''} ${el.id || ''} ${el.getAttribute?.('aria-label') || ''} ${el.getAttribute?.('placeholder') || ''}`);
    }
    secrets.set(el, verdict);
    return verdict;
  };

  const state = { field: null, timer: 0, last: null };
  const flush = () => {
    if (state.timer) { clearTimeout(state.timer); state.timer = 0; }
    const el = state.field;
    state.field = null;
    if (!el || !el.isConnected) return;
    const value = typeof el.value === 'string' ? el.value : text(el);
    if (state.last && state.last.el === el && state.last.value === value) return;
    state.last = { el, value };
    const secret = secretOf(el);
    send({ type: secret ? 'secret' : 'fill', target: candidatesFor(el), label: nameOf(el), text: secret ? undefined : String(value).slice(0, 2000) });
  };
  const expire = () => { if (state.timer) { clearTimeout(state.timer); state.timer = 0; } };

  const onClick = event => {
    if (!event.isTrusted) return;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const el = path.find(node => node && node.nodeType === 1 && harmless(node)) || event.target;
    if (!el || el.nodeType !== 1 || el === document.body || el === document.documentElement) return;
    // A click that only focuses a field is not a step: the fill that follows says what happened.
    if (isEditable(el) || el.tagName === 'SELECT' || el.tagName === 'OPTION') { state.field = isEditable(el) ? el : null; return; }
    // Someone who types and immediately clicks Save is inside the debounce window: the pending text
    // is a step too, and dropping it here would lose what they wrote.
    flush();
    send({ type: 'click', target: candidatesFor(el), label: nameOf(el) });
  };
  const onInput = event => {
    if (!event.isTrusted) return;
    const el = event.target;
    if (!isEditable(el)) return;
    state.field = el;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(flush, 500);
  };
  const onChange = event => {
    if (!event.isTrusted) return;
    const el = event.target;
    if (el?.tagName === 'SELECT') { flush(); send({ type: 'select', target: candidatesFor(el), label: nameOf(el), value: String(el.value ?? '') }); return; }
    if (isEditable(el)) flush();
  };
  const onFocus = event => { const el = event.target; if (isEditable(el)) state.field = el; };
  // A keystroke is a step when replaying it does the same thing again: submitting a field, closing a
  // dialog, or a command aimed at the page rather than at a caret. Inside a field, typing, pasting,
  // undoing and selecting all end up in that field's recorded value, and replaying the shortcut would
  // depend on a selection the macro never captured and on whatever is on the clipboard at the time.
  const SHORTCUT_KEYS = ['a', 'c', 'v', 'x', 'z', 'y'];
  const shortcut = event => {
    if (!/^[a-z]$/i.test(event.key) || !SHORTCUT_KEYS.includes(event.key.toLowerCase())) return '';
    if (event.altKey || (!event.ctrlKey && !event.metaKey)) return '';
    // Spelled as this platform spells it, so a replay presses the modifier the person actually used.
    return `${event.metaKey ? 'Meta' : 'Control'}${event.shiftKey ? '+Shift' : ''}+${event.key.toUpperCase()}`;
  };
  const onKey = event => {
    if (!event.isTrusted || event.repeat) return;
    const el = event.target;
    const field = isEditable(el) || el?.tagName === 'SELECT';
    if (event.key === 'Enter') {
      if (!field) return;
      // Enter in a field submits its form; recording the key keeps that behaviour instead of guessing.
      flush();
      send({ type: 'key', key: 'Enter' });
      return;
    }
    // Escape closes a dialog or cancels a drag wherever the focus sits, and what was typed before it is
    // already a step of its own.
    if (event.key === 'Escape') { flush(); send({ type: 'key', key: 'Escape' }); return; }
    if (field) return;
    const key = shortcut(event);
    if (key) send({ type: 'key', key });
  };
  const onHide = () => { if (document.hidden) flush(); };
  const onPageHide = () => flush();

  const listeners = [['click', onClick, true], ['input', onInput, true], ['change', onChange, true], ['focusin', onFocus, true], ['keydown', onKey, true], ['pagehide', onPageHide, true]];
  for (const [type, fn, capture] of listeners) window.addEventListener(type, fn, capture);
  document.addEventListener('visibilitychange', onHide, true);

  // Client-side routing creates no new document, so a route change has to be noticed here; that is
  // what tells the panel a step navigated, or that the user went somewhere by hand.
  let href = location.href;
  const poll = setInterval(() => {
    if (location.href === href) return;
    href = location.href;
    send({ type: 'page', href, title: document.title });
  }, 500);

  window[KEY] = {
    session,
    stop() {
      clearInterval(poll);
      expire();
      for (const [type, fn, capture] of listeners) window.removeEventListener(type, fn, capture);
      document.removeEventListener('visibilitychange', onHide, true);
      if (window[KEY]?.session === session) delete window[KEY];
    }
  };
  send({ type: 'page', href: location.href, title: document.title });
  return true;
}
function uninstallRecorder(session) {
  const recorder = window.__mezzeRecorder;
  if (recorder && (!session || recorder.session === session)) recorder.stop();
  return true;
}
// /transcribe records the audio the page is already playing. The element's own track is captured in
// the page rather than downloading the media: a streaming player exposes no file at all, and the
// browser is already decoding the audio, so this is the one path that works both for a plain
// <video src="…"> and for a player that feeds the element through MediaSource.
async function captureMediaAudio(session) {
  if (window.__mezzeCapture?.session === session) return { state: 'running', duration: window.__mezzeCapture.duration, paused: window.__mezzeCapture.paused };
  window.__mezzeCapture?.stop();
  const media = [...document.querySelectorAll('video,audio')]
    .filter(el => el.currentSrc || el.duration > 0.5)
    .sort((a, b) => (b.duration || 0) - (a.duration || 0))[0];
  if (!media) return { state: 'none', error: 'No video or audio was found on this page.' };
  if (media.mediaKeys) return { state: 'blocked', error: 'This video is protected (DRM), so its audio cannot be captured.' };
  if (!window.MezzeAudio) return { state: 'blocked', error: 'The audio helpers did not load on this page.' };
  const audio = window.MezzeAudio;
  const send = payload => { try { chrome.runtime.sendMessage({ type: 'transcribe-event', session, ...payload }); } catch { /* panel closed */ } };
  if (media.paused) await media.play().catch(() => {});
  let stream = null;
  try { stream = typeof media.captureStream === 'function' ? media.captureStream() : media.mozCaptureStream?.(); } catch { stream = null; }
  if (!stream?.getAudioTracks?.().length) return { state: 'silent', error: 'That player exposes no audio track to transcribe.' };
  const context = new AudioContext({ sampleRate: audio.RATE });
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const mute = context.createGain();
  mute.gain.value = 0;
  const chunk = new Float32Array(audio.RATE * (audio.SLICE + 3));
  let filled = 0, part = 0, samples = 0, stopped = false, runStart = 0, runSamples = 0;
  const duration = Number(media.duration) || 0;
  // Rendered seconds and media seconds differ once the playback speed is not 1, so the media time of a
  // sample is measured against the element instead of assumed from the sample count.
  const mediaTime = index => {
    const span = (Number(media.currentTime) || 0) - runStart;
    const rendered = runSamples / audio.RATE;
    const per = rendered > 0.3 && span > 0 ? span / rendered : 1;
    return runStart + (index / audio.RATE) * per;
  };
  const flush = (cut = filled, restart = false) => {
    if (stopped || !filled) return;
    const index = Math.max(1, Math.min(Math.round(cut), filled));
    const to = restart ? (Number(media.currentTime) || 0) : mediaTime(index);
    const bytes = audio.wavBytes(chunk.subarray(0, index), audio.RATE);
    part += 1;
    send({
      event: 'chunk', part, audio: audio.base64(bytes), mimeType: 'audio/wav', seconds: Math.round(samples / audio.RATE),
      from: Math.round(runStart * 100) / 100, to: Math.round(to * 100) / 100
    });
    // The samples after the cut are not thrown away: they start the next slice, which is what lets a
    // cut sit on a pause instead of at a fixed ten seconds.
    chunk.copyWithin(0, index, filled);
    filled -= index;
    runSamples = Math.max(0, runSamples - index);
    runStart = to;
    if (!filled) { runSamples = 0; runStart = Number(media.currentTime) || 0; }
  };
  const onAudio = event => {
    if (stopped) return;
    // A paused video produces silence, and silence is a wasted request: nothing is collected until it
    // plays again.
    if (media.paused || media.ended) return;
    if (!filled) { runStart = Number(media.currentTime) || 0; runSamples = 0; }
    const input = event.inputBuffer.getChannelData(0);
    for (let i = 0; i < input.length; i++) chunk[filled++] = input[i];
    samples += input.length;
    runSamples += input.length;
    if (filled >= audio.RATE * audio.SLICE) {
      const cut = audio.quietCut ? audio.quietCut(chunk.subarray(0, filled), audio.RATE, 0.7, 1) : -1;
      flush(cut > 0 ? cut : Math.min(filled, audio.RATE * (audio.SLICE + 2)));
    }
  };
  const finish = reason => {
    if (stopped) return;
    stopped = true;
    clearInterval(ticker);
    flush();
    media.removeEventListener?.('ended', onEnded);
    media.removeEventListener?.('pause', onCut);
    media.removeEventListener?.('seeked', onCut);
    media.removeEventListener?.('ratechange', onCut);
    try { processor.disconnect(); source.disconnect(); mute.disconnect(); context.close(); } catch { /* already closed */ }
    send({ event: 'done', reason, seconds: Math.round(samples / audio.RATE), parts: part });
    delete window.__mezzeCapture;
  };
  const onEnded = () => finish('ended');
  processor.onaudioprocess = onAudio;
  source.connect(processor);
  processor.connect(mute);
  mute.connect(context.destination);
  media.addEventListener('ended', onEnded);
  // A pause, a seek or a speed change ends the line where it is rather than smearing media time across
  // audio that was never rendered.
  const onCut = () => flush(filled, true);
  media.addEventListener('pause', onCut);
  media.addEventListener('seeked', onCut);
  media.addEventListener('ratechange', onCut);
  const ticker = setInterval(() => send({ event: 'progress', seconds: Math.round(samples / audio.RATE), duration }), 5000);
  window.__mezzeCapture = { session, duration, paused: !!media.paused, stop: () => finish('stopped') };
  send({ event: 'start', duration, title: document.title, url: location.href });
  return { state: 'running', duration, paused: !!media.paused, title: document.title, url: location.href };
}
// Chrome can share a whole tab's audio, which covers the players the page path cannot: sound inside
// an <iframe>, a player built on Web Audio, and the many streaming <video> elements whose
// captureStream exposes no audio track at all. The capture needs an AudioContext, which a service
// worker does not have, so it runs in an offscreen document and reports back through the same
// transcribe-event channel the page uses.
async function pageMediaTime(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const media = [...document.querySelectorAll('video,audio')]
        .filter(el => el.currentSrc || el.duration > 0.5)
        .sort((a, b) => (b.duration || 0) - (a.duration || 0))[0];
      return Number(media?.currentTime) || 0;
    }
  }).catch(() => []);
  return Number(result?.result) || 0;
}

async function offscreenReady() {
  if (await chrome.offscreen.hasDocument?.()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Capture the audio this tab is playing so it can be transcribed.'
  });
}

async function tabAudioStart(tab, session) {
  if (!chrome.tabCapture?.getMediaStreamId) throw new Error('This Chrome does not offer tab audio capture.');
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  await offscreenReady();
  // The transcript lines are timed against the media element, so the capture counts from the
  // element's own clock rather than from zero.
  const started = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'tab-capture-start', session, streamId, startTime: await pageMediaTime(tab.id) });
  if (!started?.ok) throw new Error(started?.error || "Chrome did not share this tab's audio.");
  return { state: 'running', duration: 0, paused: false, title: tab.title || '', url: tab.url || '', via: 'tab' };
}

function stopCapture(session) {
  const capture = window.__mezzeCapture;
  if (capture && (!session || capture.session === session)) capture.stop();
  return true;
}
// The island is its own injected file; these three thin functions are what the panel talks to, so the
// service worker never holds transcript state and a page reload only loses its own island.
function openPlayer(input) {
  if (!window.MezzeScript) return { open: false };
  window.MezzeScript.open(input || {});
  return { open: true };
}
function appendPlayerLine(line) {
  if (!window.MezzeScript) return { open: false };
  window.MezzeScript.line(line || {});
  return { open: true };
}
function closePlayer() {
  if (!window.MezzeScript) return { open: false };
  window.MezzeScript.close();
  return { open: true };
}
function idlePlayer() {
  if (!window.MezzeScript) return { open: false };
  window.MezzeScript.idle();
  return { open: true };
}
// The session lives in session storage rather than a global, so it survives a service worker restart
// and every navigation re-arms the recorder on the new document.
async function armRecorder(tabId) {
  const saved = (await chrome.storage.session.get(RECORD_KEY).catch(() => ({})))[RECORD_KEY];
  const tabIds = saved?.tabIds || (saved?.tabId ? [saved.tabId] : []);
  if (!tabIds.includes(tabId)) return false;
  await armDom(tabId);
  await chrome.scripting.executeScript({ target: { tabId }, func: installRecorder, args: [saved.session] }).catch(() => {});
  return true;
}

async function clickType(tab, action, width, height) {
  if (await scriptedInput()) return scriptedClickType(tab, action, width, height);
  return debug(tab.id, async target => {
    const live = await liveViewport(target);
    const point = scalePoint(action, width, height, live);
    if (await pointerEnabled()) await pointerTo(tab.id, point);
    await clickPoint(target, point);
    pointerClick(tab.id);
    await sleep(120);
    if (action.type !== 'type') return {};
    const focused = await readEditable(tab.id);
    if (focused.password) fail('PASSWORD_FIELD', 'Password and login fields are blocked.');
    if (focused.kind !== 'editable') {
      await typeKeys(target, action.text);
      if (action.submit) { await sleep(150); await pressKey(target, 'Enter'); }
      return { typed: 'keys', verified: null };
    }
    await chrome.debugger.sendCommand(target, 'Input.insertText', { text: action.text });
    await sleep(150);
    const after = await readEditable(tab.id);
    if (after.password) fail('PASSWORD_FIELD', 'Password and login fields are blocked.');
    if (after.kind === 'editable' && after.value === focused.value) {
      await typeKeys(target, action.text);
      if (action.submit) { await sleep(150); await pressKey(target, 'Enter'); }
      return { typed: 'keys-after-insert', verified: null };
    }
    if (action.submit) { await sleep(150); await pressKey(target, 'Enter'); }
    // The field reports exactly the text that was sent: proof the step worked, whatever the page hash says.
    return { typed: 'insertText', typedOk: after.kind === 'editable' ? String(after.value).slice(-action.text.length) === action.text : null };
  });
}
// Input has two engines. The debugger sends real, trusted events, exposes the accessibility tree and
// takes screenshots — and Chrome shows its "started debugging this browser" bar for as long as a run
// holds it. The scripted engine asks the page to click and type instead: no bar, nothing to grant, at
// the cost of synthetic events, which some sites ignore. Opt-in, and refs and generated writing stay
// debugger-only, because both are built on CDP.
async function scriptedInput() {
  const saved = await chrome.storage.local.get('inputMode').catch(() => ({}));
  return saved.inputMode === 'scripted';
}
async function pageRun(tabId, func, args) {
  const frames = await chrome.scripting.executeScript({ target: { tabId }, func, args }).catch(() => []);
  return frames?.[0]?.result;
}
async function scriptedClickType(tab, action, width, height) {
  const point = scalePoint(action, width, height, null);
  if (await pointerEnabled()) await pointerTo(tab.id, point);
  const hit = await pageRun(tab.id, pageScriptClick, [point.x, point.y]);
  pointerClick(tab.id);
  await sleep(120);
  if (!hit) fail('NOT_ACTIONABLE', 'There is nothing clickable at that point any more. Read the page again.');
  if (action.type !== 'type') return { via: 'script' };
  const focused = await readEditable(tab.id);
  if (focused.password) fail('PASSWORD_FIELD', 'Password and login fields are blocked.');
  const typed = await pageRun(tab.id, pageScriptType, [action.text]);
  if (!typed?.ok) {
    if (typed?.kind === 'password') fail('PASSWORD_FIELD', 'Password and login fields are blocked.');
    fail('NO_DEBUGGER', 'That field ignored synthetic typing. Switch Input to Debugger in Settings for this site.');
  }
  await sleep(150);
  if (action.submit) { await sleep(150); await keyOn(tab.id, 'Enter'); }
  return { via: 'script', typed: 'script', typedOk: typeof typed.value === 'string' ? typed.value.slice(-action.text.length) === action.text : null };
}
// One way to press a key, whichever engine is running.
async function keyOn(tabId, spec) {
  if (!(await scriptedInput())) { await debug(tabId, target => pressKey(target, spec)); return; }
  const done = await pageRun(tabId, pageScriptKey, [spec]);
  if (!done) fail('UNSUPPORTED_KEY', `Unsupported key: ${clip(spec, 20)}.`);
}
async function workerBase() {
  const saved = await chrome.storage.local.get('worker').catch(() => ({}));
  return String(saved.worker || 'https://webagent.amos-donn.workers.dev').replace(/\/+$/, '');
}
// Gemini writes the text into the field: one request, streamed in as it arrives, with a purple
// outline and skeleton over the target so the user can see which field is being written.
async function writeInto(fresh, action, message) {
  if (await scriptedInput()) fail('NO_DEBUGGER', 'Generated writing streams into the field through the debugger. Switch Input to Debugger in Settings, or ask the agent to type the text instead.');
  const beforeState = await watched(fresh.id);
  const before = sigOf(beforeState);
  const live = await liveViewportSafe(fresh.id);
  let point;
  if (action.ref) point = await refBox(fresh.id, action.ref, message.url);
  else {
    if (![action.x, action.y, message.width, message.height].every(Number.isFinite)) fail('INVALID_COORDINATES', 'The coordinates for that action are missing.');
    point = scalePoint(action, message.width, message.height, live);
  }
  const label = (action.ref ? await refLabel(fresh.id, action.ref) : '') || 'the field';
  const page = await readPage(fresh.id).catch(() => ({ text: '' }));
  if (await pointerEnabled()) await pointerTo(fresh.id, point);
  await chrome.scripting.executeScript({ target: { tabId: fresh.id }, func: writeBoxShow, args: [point.x, point.y] }).catch(() => {});
  let produced = 0, failure = '';
  try {
    const outcome = await debug(fresh.id, async target => {
      await clickPoint(target, point);
      pointerClick(fresh.id);
      await sleep(160);
      const focused = await readEditable(fresh.id);
      if (focused.password) fail('PASSWORD_FIELD', 'Password and login fields are blocked.');
      if (action.replace) await pressKey(target, 'Control+A').catch(() => {});
      const response = await fetch(`${await workerBase()}/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goal: message.goal || '', brief: action.brief, field: label,
          existing: focused.kind === 'editable' ? String(focused.value || '').slice(0, 12000) : '',
          context: String(page.text || '').slice(0, 12000), url: fresh.url
        })
      });
      if (!response.ok || !response.body) {
        const detail = await response.json().catch(() => ({}));
        fail('WRITE_FAILED', detail.error || `Gemini could not write that (${response.status}).`);
      }
      const insert = async piece => {
        if (!piece) return;
        await chrome.debugger.sendCommand(target, 'Input.insertText', { text: piece });
        produced += piece.length;
        await chrome.scripting.executeScript({ target: { tabId: fresh.id }, func: writeBoxProgress, args: [produced] }).catch(() => {});
        await sleep(45);
      };
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '', pending = '';
      const flush = async force => {
        while (pending.length) {
          if (!force && pending.length < 90) return;
          let cut = force ? Math.min(pending.length, 400) : 90;
          if (!force) { const space = pending.lastIndexOf(' ', cut); if (space > 40) cut = space + 1; }
          const piece = pending.slice(0, cut);
          pending = pending.slice(cut);
          await insert(piece);
        }
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';
        for (const raw of events) {
          const line = raw.split('\n').find(part => part.startsWith('data:'));
          if (!line) continue;
          let payload;
          try { payload = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (payload.error) failure = String(payload.error);
          if (typeof payload.text === 'string') { pending += payload.text; await flush(false); }
        }
      }
      await flush(true);
      return { editable: focused.kind === 'editable' };
    });
    if (!produced) fail('WRITE_FAILED', failure || 'Gemini returned no text for that field.');
    const after = await settle(fresh.id, before);
    const effect = Effect.of(before, after);
    return { generated: produced, via: 'stream', typed: outcome.editable ? 'generated' : 'keys', effect, code: Effect.code(effect) };
  } finally {
    await chrome.scripting.executeScript({ target: { tabId: fresh.id }, func: writeBoxHide }).catch(() => {});
  }
}
async function guardAction(tabId, action, message) {
  const allow = Array.isArray(message.allow) ? message.allow.filter(value => /^https?:\/\//.test(value)) : [];
  if (action.type === 'navigate' && allow.length && !allow.includes(originOf(action.url))) return { notice: `This task now includes ${originOf(action.url)}.` };
  if (!['click', 'type', 'write', 'fill'].includes(action.type)) return;
  const labels = [];
  if (action.ref) labels.push(await refLabel(tabId, action.ref));
  else if (action.label) labels.push(String(action.label));
  if (action.type === 'fill' && Array.isArray(action.fields)) for (const field of action.fields) if (field.ref) labels.push(await refLabel(tabId, field.ref));
  const text = `${labels.join(' ')} ${action.description || ''} ${action.text || ''} ${action.brief || ''} ${action.submit ? 'submit' : ''}`;
  // Match the goal, the plan titles and the chat so far, by meaning rather than by exact wording.
  const intent = `${message.goal || ''} ${message.intent || ''}`;
  const groups = INTENTS.filter(group => group.label.test(text));
  if (!groups.length) return;
  const unmatched = groups.filter(group => !group.goal.test(intent));
  if (!unmatched.length) return;
  const words = unmatched.map(group => text.match(group.label)?.[0]).filter(Boolean);
  if (message.automatic === true && unmatched.some(group => MONEY.test(text))) fail('BLOCKED_ACTION', `Blocked “${words[0]}”: spending money or closing an account is not something this goal implies. Do it explicitly, or finish the rest of the task and say what was skipped.`);
  return { notice: `“${clip(labels.join(' / ') || words[0] || action.type, 50)}” can be hard to undo, but it matches what you asked for — going ahead.` };
}
async function actOnTab(fresh, action, message) {
  settleBudget = Number(message?.settleMs) || SETTLE_MAX;
  // Shadow mode describes the step instead of firing it: a plan can be inspected on a sensitive page
  // before anything is clicked.
  if (message?.shadow === true && !['read', 'wait', 'waitFor', 'remember', 'ask'].includes(action.type)) {
    return {
      shadow: true,
      planned: { type: action.type, ref: action.ref || '', x: action.x, y: action.y, text: action.text, url: action.url, tab: action.tab, description: action.description || '' },
      effect: { verified: null }
    };
  }
  if (action.type === 'navigate') {
    const url = new URL(action.url);
    if (!permitted(url.href) || url.username || url.password) throw new Error('Only HTTPS or local URLs are allowed.');
    const gate = await guardAction(fresh.id, action, message);
    await chrome.tabs.update(fresh.id, { url: url.href });
    return { effect: { verified: null }, notice: gate?.notice };
  }
  if (action.type === 'read') { const page = await readPage(fresh.id); return { title: page.title, text: page.text, effect: { verified: true } }; }
  if (action.type === 'wait') { const seconds = Number(action.seconds); if (!Number.isFinite(seconds) || seconds < 1 || seconds > 10) throw new Error('Invalid wait duration.'); await sleep(Math.round(seconds * 1000)); return { effect: { verified: null } }; }
  if (action.type === 'waitFor') {
    const wantText = String(action.text || '').toLowerCase();
    const wantUrl = String(action.url || '').toLowerCase();
    const seconds = Math.min(Math.max(Number(action.seconds) || 20, 1), 30);
    const deadline = Date.now() + seconds * 1000;
    let last = '';
    while (Date.now() < deadline) {
      const tab = await getTab(fresh.id).catch(() => null);
      const page = await readPage(fresh.id).catch(() => ({ text: '' }));
      last = String(page?.text || '');
      const textHit = !wantText || last.toLowerCase().includes(wantText);
      const urlHit = !wantUrl || String(tab?.url || '').toLowerCase().includes(wantUrl);
      if (textHit && urlHit) return { found: true, waited: seconds - Math.max(0, Math.round((deadline - Date.now()) / 1000)), effect: { verified: true } };
      await sleep(300);
    }
    return { found: false, effect: { verified: false }, note: 'That text never appeared within ' + seconds + 's.', page: last.slice(0, 1200) };
  }
  const gate = await guardAction(fresh.id, action, message);
  if (action.type === 'fill') {
    const before = await signature(fresh.id);
    const results = [];
    for (const field of action.fields.slice(0, 12)) {
      const point = field.ref ? await refBox(fresh.id, field.ref, message.url) : scalePoint(field, message.width, message.height, await liveViewportSafe(fresh.id));
      const extra = await clickType(fresh, { type: 'type', x: point.x, y: point.y, text: field.text }, point.width, point.height);
      results.push({ ref: field.ref || '', typed: extra.typed || 'insertText' });
      await sleep(120);
    }
    const after = await settle(fresh.id, before);
    return { fields: results, effect: Effect.of(before, after), notice: gate?.notice };
  }
  if (action.type === 'write') {
    const outcome = await writeInto(fresh, action, message);
    return { ...outcome, notice: gate?.notice };
  }
  const before = await signature(fresh.id);
  if (action.type === 'select') {
    const point = action.target ? await targetBox(fresh.id, action.target, message.waitMs) : null;
    if (!point) fail('STALE_REF', 'That list is no longer on the page, so the recorded option could not be chosen.');
    const frames = await chrome.scripting.executeScript({ target: { tabId: fresh.id }, func: selectOption, args: [point.x, point.y, String(action.value ?? '')] });
    const chosen = frames?.[0]?.result;
    if (!chosen?.ok) fail('NO_EFFECT', `That list no longer offers “${clip(action.value, 40)}”.`);
    const after = await settle(fresh.id, before);
    const effect = Effect.of(before, after, true);
    return { selected: chosen.value, effect, code: Effect.code(effect), notice: gate?.notice };
  }
  if (action.type === 'scroll') {
    if (!['up', 'down'].includes(action.direction)) throw new Error('Invalid scroll direction.');
    await chrome.scripting.executeScript({ target: { tabId: fresh.id }, func: direction => window.scrollBy({ top: direction === 'up' ? -Math.round(innerHeight * .75) : Math.round(innerHeight * .75), behavior: 'instant' }), args: [action.direction] });
    let after = await settle(fresh.id, before);
    let via = 'pointer';
    if (before && after && before === after) {
      // Nested scrollers and keyboard-first pages ignore window.scrollBy, so fall back to the Space bar.
      await keyOn(fresh.id, action.direction === 'up' ? 'Shift+Space' : 'Space');
      const keyed = await settle(fresh.id, before);
      if (before && keyed && before !== keyed) { after = keyed; via = 'keyboard'; }
    }
    const effect = Effect.of(before, after);
    return { via, effect, code: Effect.code(effect), notice: gate?.notice };
  }
  if (action.type === 'key') await keyOn(fresh.id, action.key);
  else if (['click', 'type'].includes(action.type)) {
    let point;
    if (action.target) {
      // A recorded step waits for its target instead of failing on the first look.
      point = await targetBox(fresh.id, action.target, message.waitMs);
      if (!point) fail('STALE_REF', 'That element is not on the page any more, so the recorded step could not find it.');
    } else if (action.ref) point = await refBox(fresh.id, action.ref, message.url);
    else {
      if (![action.x, action.y, message.width, message.height].every(Number.isFinite)) fail('INVALID_COORDINATES', 'The coordinates for that action are missing.');
      point = { x: action.x, y: action.y, width: message.width, height: message.height };
    }
    if (action.type === 'type' && (typeof action.text !== 'string' || action.text.length > 5000)) throw new Error('Invalid text.');
    const extra = await clickType(fresh, { ...action, x: point.x, y: point.y }, point.width, point.height);
    let after = await settle(fresh.id, before);
    let verified = extra.verified !== undefined && extra.verified !== null ? extra.verified : Effect.of(before, after).verified;
    if (extra.typedOk === true) verified = true;
    let fallback = false;
    if (action.type === 'click' && verified === false) {
      fallback = await clickElement(fresh.id, { x: point.x, y: point.y });
      after = await settle(fresh.id, before);
      verified = Effect.of(before, after).verified;
    }
    const live = beforeState?.live ? (await watched(fresh.id))?.live : '';
    const receipt = live && live !== beforeState.live ? live.slice(0, 160) : '';
    return { ...extra, fallback, receipt, effect: { verified }, code: Effect.code({ verified }), notice: gate?.notice };
  } else throw new Error('Unknown action.');
  const after = await settle(fresh.id, before);
  const effect = Effect.of(before, after);
  return { effect, code: Effect.code(effect), notice: gate?.notice };
}
let bridgeSocket = null;
// The service worker dials a loopback bridge when the user enables it, so other agents can drive the tab.
async function ensureBridge() {
  if (bridgeSocket) return;
  const { bridge } = await chrome.storage.local.get('bridge').catch(() => ({}));
  if (bridge !== true) return;
  try {
    const socket = new WebSocket('ws://127.0.0.1:8787');
    bridgeSocket = socket;
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'hello', version: chrome.runtime.getManifest().version })));
    socket.addEventListener('message', async event => {
      let request;
      try { request = JSON.parse(event.data); } catch { return; }
      try { const data = await handle({ ...(request.payload || {}), type: request.type }); socket.send(JSON.stringify({ id: request.id, data })); }
      catch (e) { socket.send(JSON.stringify({ id: request.id, error: e.message, code: e.code || 'ERROR' })); }
    });
    socket.addEventListener('close', () => { if (bridgeSocket === socket) bridgeSocket = null; });
    socket.addEventListener('error', () => { if (bridgeSocket === socket) bridgeSocket = null; });
  } catch { bridgeSocket = null; }
}
async function handle(message) {
  if (message.type === 'notify') { await notifyDone(message.title, message.message); return { shown: true }; }
  if (message.type === 'pending') {
    const saved = (await chrome.storage.session.get('pendingPrompt').catch(() => ({}))).pendingPrompt || null;
    if (saved) await chrome.storage.session.remove('pendingPrompt').catch(() => {});
    return { pending: saved && Date.now() - saved.at < 120000 ? saved : null };
  }
  if (message.type === 'schedule-add') {
    const list = await schedules();
    const entry = Schedule.add(list, message.prompt, message.every, Date.now());
    await saveSchedules([...list, entry]);
    await ensureAlarm();
    return { schedule: entry, count: list.length + 1 };
  }
  if (message.type === 'schedule-list') return { schedules: await schedules() };
  if (message.type === 'schedule-remove') {
    const list = (await schedules()).filter(item => item.id !== message.id);
    await saveSchedules(list);
    return { schedules: list };
  }
  if (message.type === 'schedule-done') {
    const list = await schedules();
    const found = list.find(item => item.id === message.id);
    if (found) {
      found.runs = (found.runs || 0) + 1;
      found.lastRun = Date.now();
      found.nextRun = Schedule.nextAt(Date.now(), found.every);
      await saveSchedules(list);
    }
    return { done: !!found };
  }
  if (message.type === 'group-tab') { await groupTab(message.tabId); return { grouped: true }; }
  if (message.type === 'bridge') {
    await chrome.storage.local.set({ bridge: message.on === true });
    if (message.on === true) await ensureBridge();
    else { bridgeSocket?.close(); bridgeSocket = null; }
    return { on: message.on === true, connected: !!bridgeSocket };
  }
  if (message.type === 'record-start') {
    const tab = await getTab(message.tabId);
    if (!permitted(tab.url)) throw new Error('Recording needs an HTTPS page (or a local development page). Chrome internal pages are blocked.');
    const session = String(message.session || '');
    if (!session) throw new Error('Missing recording session.');
    await chrome.storage.session.set({ [RECORD_KEY]: { session, tabId: tab.id, tabIds: [tab.id], startUrl: tab.url, at: Date.now() } });
    await armDom(tab.id);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: installRecorder, args: [session] });
    return { session, tabId: tab.id, url: tab.url };
  }
  // A recording is not tied to one tab: a click that opens a tab, or a person who moves on to another
  // one, continues the same recording. Every tab that is worked in gets the recorder, and is kept in
  // the list so a navigation there re-arms it too.
  if (message.type === 'record-target') {
    const tab = await getTab(message.tabId);
    const saved = (await chrome.storage.session.get(RECORD_KEY).catch(() => ({})))[RECORD_KEY];
    if (!saved?.session) return { armed: false };
    if (!permitted(tab.url)) throw new Error('That page cannot be recorded.');
    const tabIds = [...new Set([...(saved.tabIds || [saved.tabId]).filter(Boolean), tab.id])].slice(-12);
    await chrome.storage.session.set({ [RECORD_KEY]: { ...saved, tabIds } });
    await armDom(tab.id);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: installRecorder, args: [saved.session] });
    return { tabId: tab.id, armed: tabIds.length };
  }
  if (message.type === 'record-stop') {
    const saved = (await chrome.storage.session.get(RECORD_KEY).catch(() => ({})))[RECORD_KEY];
    const tabIds = [...new Set([...(saved?.tabIds || []), saved?.tabId, message.tabId].filter(Boolean))];
    for (const tabId of tabIds) await chrome.scripting.executeScript({ target: { tabId }, func: uninstallRecorder, args: [message.session || saved?.session || ''] }).catch(() => {});
    await chrome.storage.session.remove(RECORD_KEY).catch(() => {});
    return { stopped: true };
  }
  if (message.type === 'capture-start') {
    const tab = await getTab(message.tabId);
    if (!permitted(tab.url)) throw new Error('Transcribing needs an HTTPS page (or a local development page). Chrome internal pages are blocked.');
    const session = String(message.session || '');
    if (!session) throw new Error('Missing transcription session.');
    // The helpers go in as a file so the capture function can use them; the capture itself stays one
    // self-contained function because it runs inside the page.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['audio.js'] });
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: captureMediaAudio, args: [session] });
    const page = result?.result || { state: 'none', error: 'The page did not answer.' };
    if (page.state === 'running') return page;
    // A page with no media element, or one whose element exposes no audio track, is not a dead end:
    // Chrome can hand over the tab's own audio instead.
    try {
      return await tabAudioStart(tab, session);
    } catch (error) {
      throw new Error([page.error, error?.message].filter(Boolean).join(' '));
    }
  }
  if (message.type === 'capture-stop') {
    const tab = await getTab(message.tabId);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: stopCapture, args: [String(message.session || '')] }).catch(() => {});
    // The tab capture, if it is the one running, lives in the offscreen document.
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'tab-capture-stop' }).catch(() => {});
    return { stopped: true };
  }
  if (message.type === 'player-open') {
    const tab = await getTab(message.tabId);
    if (!permitted(tab.url)) throw new Error('Script mode needs an HTTPS page (or a local development page). Chrome internal pages are blocked.');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['audio.js', 'player.js'] });
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: openPlayer, args: [{ title: String(message.title || ''), lines: Array.isArray(message.lines) ? message.lines.slice(-400) : [], live: message.live === true }] });
    return result?.result || { open: false };
  }
  if (message.type === 'player-line') {
    const tab = await getTab(message.tabId);
    const line = message.line && typeof message.line === 'object' ? message.line : {};
    const [first] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: appendPlayerLine, args: [line] }).catch(() => []);
    if (first?.result?.open) return { open: true };
    // The page navigated, or the panel reopened: put the island back and seed it with this line.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['audio.js', 'player.js'] }).catch(() => {});
    const [second] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: openPlayer, args: [{ title: String(message.title || ''), lines: [line] }] }).catch(() => []);
    return { open: !!second?.result?.open };
  }
  if (message.type === 'player-close') {
    await chrome.scripting.executeScript({ target: { tabId: message.tabId }, func: closePlayer }).catch(() => {});
    return { closed: true };
  }
  if (message.type === 'player-idle') {
    await chrome.scripting.executeScript({ target: { tabId: message.tabId }, func: idlePlayer }).catch(() => {});
    return { idle: true };
  }
  // The panel receives these directly from the page; answering here only stops the content script
  // from seeing "Unknown action" as a rejection.
  if (message.type === 'macro-event') return { ok: true };
  // The audio slices travel from the page to the panel, which owns the Worker call and the transcript.
  if (message.type === 'transcribe-event') return { ok: true };
  if (message.type === 'player-closed') return { ok: true };
  if (message.type === 'rail-sync') {
    // The rail is icons only, so the list is shaped in the panel and painted here. Nothing is cached:
    // a stale icon that runs the wrong macro is worse than no icon.
    const entries = (Array.isArray(message.entries) ? message.entries : []).slice(0, 8);
    const targets = message.tabId ? [message.tabId] : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => [])).map(tab => tab.id).filter(Boolean);
    let painted = 0;
    for (const tabId of targets) {
      const tab = await getTab(tabId).catch(() => null);
      if (!tab || !permitted(tab.url)) continue;
      await chrome.scripting.executeScript({ target: { tabId }, files: ['rail.js'] }).catch(() => {});
      const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: paintRail, args: [entries] }).catch(() => []);
      if (result?.result) painted += 1;
    }
    return { painted, entries: entries.length };
  }
  if (message.type === 'rail-run') {
    // Replay drives the page, and the panel is where replay lives, so an open panel is asked first.
    const answer = await chrome.runtime.sendMessage({ type: 'macro-run-request', id: String(message.id || '') }).catch(() => null);
    if (answer?.started) return { started: true };
    await notifyDone('Mezze', 'Open the Mezze panel once, then the rail can run this macro.').catch(() => {});
    return { started: false };
  }
  if (message.type === 'tabs') {
    // Every window, not just this one: the page you reference with @ is often in another window.
    const tabs = await chrome.tabs.query({});
    const [current] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
    const here = current?.windowId;
    const ordered = [...tabs].sort((a, b) => Number(b.windowId === here) - Number(a.windowId === here));
    return { tabs: ordered.filter(t => t.id && t.url).map(t => ({ id: t.id, title: t.title || t.url, url: t.url, active: !!t.active && t.windowId === here, windowId: t.windowId, audible: !!t.audible, supported: permitted(t.url) })) };
  }
  if (message.type === 'context') {
    const tab = await getTab(message.tabId);
    if (!permitted(tab.url)) throw new Error('That page is not supported. Chrome internal pages are not supported.');
    let page;
    try { page = await readPage(tab.id); }
    catch {
      // A sleeping or long-backgrounded tab can refuse injection; waking it once usually fixes that.
      await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
      await sleep(400);
      page = await readPage(tab.id);
    }
    return { tabId: tab.id, url: tab.url, title: page.title, text: page.text };
  }
  if (message.type === 'observe') {
    const tab = message.tabId ? await getTab(message.tabId) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!tab?.id || !tab.url) throw new Error('Select a webpage first.');
    if (!permitted(tab.url)) throw new Error('Select an HTTPS page (or a local development page). Chrome internal pages are not supported.');
    if (message.stayPut === false && !tab.discarded) { await chrome.tabs.update(tab.id, { active: true }); await sleep(350); }
    const fresh = await getTab(tab.id);
    // DOM first. The tree and the element map are this round's ground truth, so the default
    // observation captures no image at all: no paint, no encode, no image tokens. A screenshot is
    // taken only when the panel asks for one (canvas, maps, icon-only controls the tree cannot name).
    const page = await readPage(fresh.id);
    const ax = await axSnapshot(fresh.id).catch(() => ({ refs: [], text: '' }));
    await saveRefs(fresh.id, fresh.url, ax.refs);
    const shot = message.shot === true ? await shoot(fresh.id).catch(() => ({})) : {};
    return { tabId: fresh.id, url: fresh.url, title: page.title, text: page.text, elements: page.elements, refs: ax.refs.map(({ backend, ...rest }) => rest), width: page.width || 0, height: page.height || 0, ...shot };
  }
  if (message.type === 'act') {
    const tab = message.tabId ? await getTab(message.tabId) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!tab?.id || !tab.url) throw new Error('Select a webpage first.');
    if (!permitted(tab.url)) fail('UNSUPPORTED_PAGE', 'Select an HTTPS page (or a local development page). Chrome internal pages are not supported.');
    if (!samePage(tab.url, message.url)) fail('PAGE_CHANGED', 'That page changed. Observe it again.');
    const action = message.action;
    if (action?.type === 'think') return {};
    if (!action || !['click', 'type', 'write', 'read', 'scroll', 'wait', 'navigate', 'key', 'fill', 'select'].includes(action.type)) throw new Error('Unknown action.');
    // Do not steal focus. Once the debugger is attached Chrome delivers input events and
    // screenshots to a tab nobody is looking at, so the run can continue while you work elsewhere.
    // A discarded tab has to be loaded before it can be driven, and that needs the tab shown.
    if (message.stayPut === false || tab.discarded) { await chrome.tabs.update(tab.id, { active: true }); await sleep(250); }
    const fresh = await getTab(tab.id);
    if (!samePage(fresh.url, message.url)) fail('PAGE_CHANGED', 'That page changed. Observe it again.');
    const result = await actOnTab(fresh, action, message);
    // Tabs the agent navigates are gathered into one visible group, so a run never hides its work.
    if (action.type === 'navigate') await groupTab(fresh.id);
    return result;
  }
  throw new Error('Unknown action.');
}
// Painted by a serialised function, so this wrapper may only touch the page it runs in.
// A notification reaches the user when there is no panel to write into: a scheduled run, or a
// rail click with the side panel closed.
async function notifyDone(title, message) {
  if (!chrome.notifications?.create) return { shown: false };
  await chrome.notifications.create('mezze-' + Date.now(), {
    type: 'basic',
    iconUrl: 'icon128.png',
    title: String(title || 'Mezze').slice(0, 60),
    message: String(message || '').slice(0, 200)
  }).catch(() => {});
  return { shown: true };
}

function paintRail(entries) {
  try { window.MezzeRail?.render(entries); return true; } catch { return false; }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  ensureBridge();
  handle(message).then(data => respond({ data }), e => respond({ error: e.message, code: e.code || 'ERROR' }));
  return true;
});
// A recording spans documents: the page is replaced on every navigation, so the recorder has to be
// re-armed on the new one. The session itself lives in session storage, so this survives the service
// worker being shut down between two clicks.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.url && !['loading', 'complete'].includes(info.status)) return;
  armRecorder(tabId).catch(() => {});
});
