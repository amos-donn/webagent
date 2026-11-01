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
  return { title: document.title, text: text.slice(0, 40000), elements };
}
async function readPage(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: extractPageData });
    if (result && typeof result.text === 'string') return result;
  } catch { /* pages that block injection fall back to the simple reader */ }
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: () => ({ title: document.title, text: (document.body?.innerText || '').slice(0, 40000), elements: [] }) });
  return result;
}
async function shoot(tabId) {
  // The agent must never see its own cursor in a decision screenshot.
  await chrome.scripting.executeScript({ target: { tabId }, func: pointerVisibility, args: [true] }).catch(() => {});
  await sleep(50);
  try {
    return await debug(tabId, async target => {
      const metrics = await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics');
      const viewport = metrics.cssVisualViewport || metrics.visualViewport;
      const image = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', { format: 'jpeg', quality: 65, fromSurface: true });
      return { image: image.data, width: viewport.clientWidth, height: viewport.clientHeight };
    });
  } finally {
    await chrome.scripting.executeScript({ target: { tabId }, func: pointerVisibility, args: [false] }).catch(() => {});
  }
}
// Accessibility tree: the primary grounding channel. Refs are stable handles for semantic nodes.
async function axSnapshot(tabId) {
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
async function refBox(tabId, ref, expectedUrl) {
  const stored = await loadRefs(tabId);
  if (!stored || !stored.refs?.[ref]) fail('STALE_REF', 'That element reference is stale. Read the page again.');
  if (expectedUrl && !samePage(stored.url, expectedUrl)) fail('PAGE_CHANGED', 'That page changed. Observe it again.');
  const live = (await liveViewportSafe(tabId)) || { width: 1280, height: 800 };
  const box = await debug(tabId, async target => {
    await chrome.debugger.sendCommand(target, 'DOM.enable').catch(() => {});
    const resolved = await chrome.debugger.sendCommand(target, 'DOM.resolveNode', { backendNodeId: stored.refs[ref] }).catch(() => null);
    if (!resolved?.object?.objectId) fail('STALE_REF', 'That element is no longer on the page.');
    const { result } = await chrome.debugger.sendCommand(target, 'Runtime.callFunctionOn', {
      objectId: resolved.object.objectId,
      functionDeclaration: 'function(){ this.scrollIntoView({block:"center",inline:"center"}); const r=this.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height}; }',
      returnByValue: true
    }).catch(() => ({ result: null }));
    if (!result?.value) fail('NOT_ACTIONABLE', 'That element could not be measured.');
    return result.value;
  });
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
function pageSignature() {
  const text = document.body ? (document.body.innerText || '') : '';
  let hash = 0;
  for (let i = 0; i < text.length; i += 7) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  const active = document.activeElement;
  // The agent's own overlays (cursor, write box) are not page content: counting them would make a
  // click look like it changed the page when only the overlay moved.
  return `${location.href}|${text.length}|${hash}|${document.querySelectorAll('*:not([id^="webagent-"])').length}|${Math.round(scrollY)}|${active ? active.tagName : ''}`;
}
async function signature(tabId) {
  try { const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: pageSignature }); return typeof result === 'string' ? result : ''; } catch { return ''; }
}
async function settle(tabId, before) {
  let latest = before;
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(200);
    latest = await signature(tabId);
    if (latest && before && latest !== before) return latest;
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
const PUNCTUATION = { '/': 'Slash', '?': 'Slash', '.': 'Period', ',': 'Comma', '-': 'Minus', '=': 'Equal', ';': 'Semicolon', "'": 'Quote', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash', '`': 'Backquote' };
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
  const code = named ? named.code : (PUNCTUATION[printable] || (/[a-z]/i.test(printable) ? `Key${printable.toUpperCase()}` : (/[0-9]/.test(printable) ? `Digit${printable}` : '')));
  const vk = named ? named.vk : printable.toUpperCase().charCodeAt(0);
  const event = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
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
    const virtual = char.toUpperCase().charCodeAt(0);
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyDown', key: char, text: char, unmodifiedText: char, windowsVirtualKeyCode: virtual });
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', key: char, windowsVirtualKeyCode: virtual });
  }
}
// A person watching the tab cannot tell where the agent is clicking: CDP input moves no real
// pointer. So the cursor is drawn — a purple arrow that slides to the target and ripples where the
// click lands. Presentation only; every call degrades silently and none of it changes the input.
function pointerMove(x, y) {
  const id = 'webagent-pointer';
  let host = document.getElementById(id);
  if (!host) {
    host = document.createElement('div');
    host.id = id;
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147483647';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = '.wrap{position:fixed;left:0;top:0;width:0;height:0;will-change:transform}'
      + '.arrow{position:absolute;left:-5px;top:-3px;width:24px;height:24px;transform-origin:5px 3px;filter:drop-shadow(0 2px 6px rgba(76,29,149,.55));opacity:0}'
      + '.ring{position:absolute;left:-32px;top:-32px;width:64px;height:64px;border-radius:50%;border:2px solid rgba(168,85,247,.85);background:radial-gradient(circle,rgba(168,85,247,.3),rgba(168,85,247,0) 70%);opacity:0}';
    const svg = 'http://www.w3.org/2000/svg';
    const wrap = document.createElement('div'); wrap.className = 'wrap';
    const ring = document.createElement('span'); ring.className = 'ring';
    const arrow = document.createElementNS(svg, 'svg');
    arrow.setAttribute('class', 'arrow'); arrow.setAttribute('viewBox', '0 0 24 24'); arrow.setAttribute('aria-hidden', 'true');
    const shape = document.createElementNS(svg, 'path');
    shape.setAttribute('d', 'M5 3 5 19.6 9.4 15.4 12.3 21.6 15.2 20.2 12.3 14.1 18.8 13.6 Z');
    shape.setAttribute('fill', '#a855f7'); shape.setAttribute('stroke', '#fff');
    shape.setAttribute('stroke-width', '1.4'); shape.setAttribute('stroke-linejoin', 'round');
    arrow.append(shape);
    wrap.append(ring, arrow);
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
    // First appearance: no journey to animate, so fade in where the click will land.
    wrap.style.transform = to;
    arrow.style.opacity = '1';
    if (!still) arrow.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
    return 0;
  }
  // Reduced motion shortens the journey instead of removing it: a zero-length slide reads as "no
  // cursor at all", which defeats the whole point of drawing one.
  const distance = Math.hypot(x - from.x, y - from.y);
  const ms = still
    ? Math.min(110, Math.max(60, Math.round(distance * 0.25)))
    : Math.min(360, Math.max(140, Math.round(distance * 0.9)));
  arrow.style.opacity = '1';
  wrap.animate(
    [{ transform: `translate3d(${from.x}px,${from.y}px,0)` }, { transform: to }],
    { duration: ms, easing: 'cubic-bezier(.22,.61,.36,1)', fill: 'forwards' }
  ).finished.catch(() => {});
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
  ring.animate(
    [{ transform: 'scale(.2)', opacity: .9 }, { transform: 'scale(1)', opacity: 0 }],
    { duration: 420, easing: 'cubic-bezier(.16,.8,.32,1)' }
  );
  arrow.animate(
    [{ transform: 'scale(1)' }, { transform: 'scale(.86)' }, { transform: 'scale(1)' }],
    { duration: 190, easing: 'ease-out' }
  );
  return true;
}
function pointerVisibility(hidden) {
  const host = document.getElementById('webagent-pointer');
  if (!host) return false;
  host.style.visibility = hidden ? 'hidden' : 'visible';
  return true;
}
async function pointerEnabled() {
  const saved = await chrome.storage.local.get('pointer').catch(() => ({}));
  return saved.pointer !== false;
}
let pointerTold = false;
async function pointerTo(tabId, point) {
  try {
    const [{ result: ms }] = await chrome.scripting.executeScript({ target: { tabId }, func: pointerMove, args: [point.x, point.y] });
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
async function clickType(tab, action, width, height) {
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
    return { typed: 'insertText' };
  });
}
async function workerBase() {
  const saved = await chrome.storage.local.get('worker').catch(() => ({}));
  return String(saved.worker || 'https://webagent.amos-donn.workers.dev').replace(/\/+$/, '');
}
// Gemini writes the text into the field: one request, streamed in as it arrives, with a purple
// outline and skeleton over the target so the user can see which field is being written.
async function writeInto(fresh, action, message) {
  const before = await signature(fresh.id);
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
    const verified = before && after ? before !== after : null;
    return { generated: produced, via: 'stream', typed: outcome.editable ? 'generated' : 'keys', effect: { verified }, code: verified === false ? 'NO_EFFECT' : undefined };
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
  if (action.type === 'navigate') {
    const url = new URL(action.url);
    if (!permitted(url.href) || url.username || url.password) throw new Error('Only HTTPS or local URLs are allowed.');
    const gate = await guardAction(fresh.id, action, message);
    await chrome.tabs.update(fresh.id, { url: url.href });
    return { effect: { verified: null }, notice: gate?.notice };
  }
  if (action.type === 'read') { const page = await readPage(fresh.id); return { title: page.title, text: page.text, effect: { verified: true } }; }
  if (action.type === 'wait') { const seconds = Number(action.seconds); if (!Number.isFinite(seconds) || seconds < 1 || seconds > 10) throw new Error('Invalid wait duration.'); await sleep(Math.round(seconds * 1000)); return { effect: { verified: null } }; }
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
    return { fields: results, effect: { verified: before && after ? before !== after : null }, notice: gate?.notice };
  }
  if (action.type === 'write') {
    const outcome = await writeInto(fresh, action, message);
    return { ...outcome, notice: gate?.notice };
  }
  const before = await signature(fresh.id);
  if (action.type === 'scroll') {
    if (!['up', 'down'].includes(action.direction)) throw new Error('Invalid scroll direction.');
    await chrome.scripting.executeScript({ target: { tabId: fresh.id }, func: direction => window.scrollBy({ top: direction === 'up' ? -Math.round(innerHeight * .75) : Math.round(innerHeight * .75), behavior: 'instant' }), args: [action.direction] });
    let after = await settle(fresh.id, before);
    let via = 'pointer';
    if (before && after && before === after) {
      // Nested scrollers and keyboard-first pages ignore window.scrollBy, so fall back to the Space bar.
      await debug(fresh.id, target => pressKey(target, action.direction === 'up' ? 'Shift+Space' : 'Space'));
      const keyed = await settle(fresh.id, before);
      if (before && keyed && before !== keyed) { after = keyed; via = 'keyboard'; }
    }
    return { via, effect: { verified: before && after ? before !== after : null }, code: before && after && before === after ? 'NO_EFFECT' : undefined, notice: gate?.notice };
  }
  if (action.type === 'key') await debug(fresh.id, target => pressKey(target, action.key));
  else if (['click', 'type'].includes(action.type)) {
    let point;
    if (action.ref) point = await refBox(fresh.id, action.ref, message.url);
    else {
      if (![action.x, action.y, message.width, message.height].every(Number.isFinite)) fail('INVALID_COORDINATES', 'The coordinates for that action are missing.');
      point = { x: action.x, y: action.y, width: message.width, height: message.height };
    }
    if (action.type === 'type' && (typeof action.text !== 'string' || action.text.length > 5000)) throw new Error('Invalid text.');
    const extra = await clickType(fresh, { ...action, x: point.x, y: point.y }, point.width, point.height);
    let after = await settle(fresh.id, before);
    let verified = extra.verified !== undefined && extra.verified !== null ? extra.verified : (before && after ? before !== after : null);
    let fallback = false;
    if (action.type === 'click' && verified === false) {
      fallback = await clickElement(fresh.id, { x: point.x, y: point.y });
      after = await settle(fresh.id, before);
      verified = before && after ? before !== after : null;
    }
    return { ...extra, fallback, effect: { verified }, code: verified === false ? 'NO_EFFECT' : undefined, notice: gate?.notice };
  } else throw new Error('Unknown action.');
  const after = await settle(fresh.id, before);
  return { effect: { verified: before && after ? before !== after : null }, code: before && after && before === after ? 'NO_EFFECT' : undefined, notice: gate?.notice };
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
  if (message.type === 'bridge') {
    await chrome.storage.local.set({ bridge: message.on === true });
    if (message.on === true) await ensureBridge();
    else { bridgeSocket?.close(); bridgeSocket = null; }
    return { on: message.on === true, connected: !!bridgeSocket };
  }
  if (message.type === 'tabs') {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    return { tabs: tabs.filter(t => t.id && t.url).map(t => ({ id: t.id, title: t.title || t.url, url: t.url, active: !!t.active, audible: !!t.audible, supported: permitted(t.url) })) };
  }
  if (message.type === 'group') {
    try {
      const existing = await chrome.tabs.get(message.tabId);
      if (existing.groupId > 0) return { groupId: existing.groupId };
      const groupId = await chrome.tabs.group({ tabIds: [message.tabId] });
      await chrome.tabGroups.update(groupId, { title: 'webagent', color: 'blue' }).catch(() => {});
      return { groupId };
    } catch { return {}; }
  }
  if (message.type === 'context') {
    const tab = await getTab(message.tabId);
    if (!permitted(tab.url)) throw new Error('That page is not supported. Chrome internal pages are not supported.');
    const page = await readPage(tab.id);
    return { tabId: tab.id, url: tab.url, title: page.title, text: page.text };
  }
  if (message.type === 'observe') {
    const tab = message.tabId ? await getTab(message.tabId) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!tab?.id || !tab.url) throw new Error('Select a webpage first.');
    if (!permitted(tab.url)) throw new Error('Select an HTTPS page (or a local development page). Chrome internal pages are not supported.');
    if (message.activate) { await chrome.tabs.update(tab.id, { active: true }); await sleep(350); }
    const fresh = await getTab(tab.id);
    // Only one debugger session per tab at a time, so the screenshot and the tree are captured in series.
    const page = await readPage(fresh.id);
    const shot = await shoot(fresh.id);
    const ax = await axSnapshot(fresh.id).catch(() => ({ refs: [], text: '' }));
    await saveRefs(fresh.id, fresh.url, ax.refs);
    return { tabId: fresh.id, url: fresh.url, title: page.title, text: page.text, elements: page.elements, refs: ax.refs.map(({ backend, ...rest }) => rest), ...shot };
  }
  if (message.type === 'act') {
    const tab = message.tabId ? await getTab(message.tabId) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!tab?.id || !tab.url) throw new Error('Select a webpage first.');
    if (!permitted(tab.url)) fail('UNSUPPORTED_PAGE', 'Select an HTTPS page (or a local development page). Chrome internal pages are not supported.');
    if (!samePage(tab.url, message.url)) fail('PAGE_CHANGED', 'That page changed. Observe it again.');
    const action = message.action;
    if (action?.type === 'think') return {};
    if (!action || !['click', 'type', 'write', 'read', 'scroll', 'wait', 'navigate', 'key', 'fill'].includes(action.type)) throw new Error('Unknown action.');
    await chrome.tabs.update(tab.id, { active: true });
    await sleep(250);
    const fresh = await getTab(tab.id);
    if (!samePage(fresh.url, message.url)) fail('PAGE_CHANGED', 'That page changed. Observe it again.');
    return actOnTab(fresh, action, message);
  }
  throw new Error('Unknown action.');
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  ensureBridge();
  handle(message).then(data => respond({ data }), e => respond({ error: e.message, code: e.code || 'ERROR' }));
  return true;
});
