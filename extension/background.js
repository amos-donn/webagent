chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
function permitted(url) { try { const u = new URL(url); return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)); } catch { return false; } }
async function debug(tabId, fn) { const target = { tabId }; await chrome.debugger.attach(target, '1.3'); try { return await fn(target); } finally { await chrome.debugger.detach(target).catch(() => {}); } }
async function getTab(tabId) { const tab = await chrome.tabs.get(tabId); if (!tab?.id || !tab.url) throw new Error('That tab is no longer available. Refresh the tab list.'); return tab; }
// Runs inside the page. Chrome serialises this function, so it must not reference anything outside its own body.
function extractPageData() {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO', 'OBJECT', 'EMBED']);
  const textOf = el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  const visible = el => {
    if (!el || SKIP.has(el.tagName)) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) >= 0.1;
  };
  // Readability-style score: lots of text, little of it inside links.
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
  for (const el of candidates) {
    const score = scoreOf(el);
    if (score > 0 && (!best || score > best.score * 1.05)) best = { el, score };
  }
  let container = best?.el;
  if (!container || (container.innerText || '').trim().length < 400) container = document.body;

  const lines = [];
  const seen = new Set();
  const push = value => {
    const line = String(value || '').replace(/[ \t]+/g, ' ').trim();
    if (line.length < 2 || line.length > 1200 || seen.has(line)) return;
    seen.add(line);
    lines.push(line);
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
  // Text that innerText drops: icon-only controls and image descriptions.
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

  // Interactive elements: on-screen ones get click coordinates, near-off-screen ones are listed so the model knows to scroll.
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
  return debug(tabId, async target => {
    const metrics = await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics');
    const viewport = metrics.cssVisualViewport || metrics.visualViewport;
    const image = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', { format: 'jpeg', quality: 65, fromSurface: true });
    return { image: image.data, width: viewport.clientWidth, height: viewport.clientHeight };
  });
}
// The viewport legitimately changes between observing and acting (side panel opening, scrollbars, reflow),
// so map the proposed point into the live viewport instead of refusing. Only a large resize needs a fresh look.
async function viewportAfter(target, width, height) {
  const metrics = await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics');
  const view = metrics.cssVisualViewport || metrics.visualViewport;
  const currentWidth = Math.round(view.clientWidth), currentHeight = Math.round(view.clientHeight);
  const scaleX = currentWidth / width, scaleY = currentHeight / height;
  if (Math.abs(scaleX - 1) > 0.25 || Math.abs(scaleY - 1) > 0.25) throw new Error('The page resized a lot since the screenshot. Observe it again.');
  return { scaleX, scaleY, currentWidth, currentHeight };
}
function scalePoint(action, view) {
  const x = Math.min(Math.max(Math.round(action.x * view.scaleX), 0), view.currentWidth - 1);
  const y = Math.min(Math.max(Math.round(action.y * view.scaleY), 0), view.currentHeight - 1);
  return { x, y };
}
async function clickType(tab, action, width, height) {
  return debug(tab.id, async target => {
    const view = await viewportAfter(target, width, height);
    const point = scalePoint(action, view);
    if (action.type === 'type') {
      const check = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (x,y) => { const e = document.elementFromPoint(x,y); return !!e && (e.tagName === 'TEXTAREA' || (e.tagName === 'INPUT' && ['text','search','email','url','tel'].includes(e.type)) || e.isContentEditable || e.getAttribute('role') === 'textbox') && !e.closest('form')?.querySelector('input[type=password]'); }, args: [point.x, point.y] });
      if (!check[0].result) throw new Error('This is not an allowed text field. Password and login forms are blocked.');
    }
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    if (action.type === 'type') {
      const focused = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (x,y) => { const e = document.elementFromPoint(x,y); return !!e && (document.activeElement === e || e.contains(document.activeElement)) && (e.tagName === 'TEXTAREA' || (e.tagName === 'INPUT' && ['text','search','email','url','tel'].includes(e.type)) || e.isContentEditable || e.getAttribute('role') === 'textbox') && !e.closest('form')?.querySelector('input[type=password]'); }, args: [point.x, point.y] });
      if (!focused[0].result) throw new Error('The text field changed or could not be focused.');
      await chrome.debugger.sendCommand(target, 'Input.insertText', { text: action.text });
      if (action.submit) {
        await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 13, key: 'Enter', text: '\r' });
        await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter' });
      }
    }
    return {};
  });
}
async function handle(message) {
  if (message.type === 'tabs') {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    return { tabs: tabs.filter(t => t.id && t.url).map(t => ({ id: t.id, title: t.title || t.url, url: t.url, active: !!t.active, audible: !!t.audible, supported: permitted(t.url) })) };
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
    if (message.activate) { await chrome.tabs.update(tab.id, { active: true }); await new Promise(resolve => setTimeout(resolve, 350)); }
    const fresh = await getTab(tab.id);
    const [page, shot] = await Promise.all([readPage(fresh.id), shoot(fresh.id)]);
    return { tabId: fresh.id, url: fresh.url, title: page.title, text: page.text, elements: page.elements, ...shot };
  }
  if (message.type === 'act') {
    const tab = message.tabId ? await getTab(message.tabId) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!tab?.id || !tab.url) throw new Error('Select a webpage first.');
    if (!permitted(tab.url)) throw new Error('Select an HTTPS page (or a local development page). Chrome internal pages are not supported.');
    if (tab.url !== message.url) throw new Error('That page changed. Observe it again.');
    const action = message.action;
    if (action?.type === 'think') return {};
    await chrome.tabs.update(tab.id, { active: true });
    await new Promise(resolve => setTimeout(resolve, 250));
    const fresh = await getTab(tab.id);
    if (fresh.url !== message.url) throw new Error('That page changed. Observe it again.');
    if (action.type === 'navigate') { const url = new URL(action.url); if (!permitted(url.href) || url.username || url.password) throw new Error('Only HTTPS or local URLs are allowed.'); await chrome.tabs.update(fresh.id, { url: url.href }); return {}; }
    if (action.type === 'read') { const page = await readPage(fresh.id); return { title: page.title, text: page.text }; }
    if (action.type === 'key') {
      const keys = { Enter: [13, 'Enter', '\r'], Escape: [27, 'Escape', 'Escape'], Tab: [9, 'Tab', '\t'], ArrowUp: [38, 'ArrowUp', ''], ArrowDown: [40, 'ArrowDown', ''], ArrowLeft: [37, 'ArrowLeft', ''], ArrowRight: [39, 'ArrowRight', ''], PageUp: [33, 'PageUp', ''], PageDown: [34, 'PageDown', ''], Home: [36, 'Home', ''], End: [35, 'End', ''], Backspace: [8, 'Backspace', ''] };
      const key = keys[action.key];
      if (!key) throw new Error('Unsupported key.');
      const [code, name, text] = key;
      await debug(fresh.id, async target => {
        await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: code, key: name, ...(text ? { text } : {}) });
        await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: code, key: name });
      });
      return {};
    }
    if (action.type === 'wait') { const seconds = Number(action.seconds); if (!Number.isFinite(seconds) || seconds < 1 || seconds > 10) throw new Error('Invalid wait duration.'); await new Promise(resolve => setTimeout(resolve, Math.round(seconds * 1000))); return {}; }
    if (action.type === 'scroll') { if (!['up', 'down'].includes(action.direction)) throw new Error('Invalid scroll direction.'); await chrome.scripting.executeScript({ target: { tabId: fresh.id }, func: direction => window.scrollBy({ top: direction === 'up' ? -Math.round(innerHeight * .75) : Math.round(innerHeight * .75), behavior: 'instant' }), args: [action.direction] }); return {}; }
    if (!['click', 'type'].includes(action.type) || ![action.x, action.y, message.width, message.height].every(Number.isFinite) || action.x < 0 || action.y < 0 || action.x >= message.width || action.y >= message.height) throw new Error('Invalid action coordinates.');
    if (action.type === 'type' && (typeof action.text !== 'string' || action.text.length > 5000)) throw new Error('Invalid text.');
    return clickType(fresh, action, message.width, message.height);
  }
  throw new Error('Unknown action.');
}
chrome.runtime.onMessage.addListener((message, sender, respond) => { if (sender.id !== chrome.runtime.id) return; handle(message).then(data => respond({ data }), e => respond({ error: e.message })); return true; });
