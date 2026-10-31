chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
function permitted(url) { try { const u = new URL(url); return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)); } catch { return false; } }
async function debug(tabId, fn) { const target = { tabId }; await chrome.debugger.attach(target, '1.3'); try { return await fn(target); } finally { await chrome.debugger.detach(target).catch(() => {}); } }
async function getTab(tabId) { const tab = await chrome.tabs.get(tabId); if (!tab?.id || !tab.url) throw new Error('That tab is no longer available. Refresh the tab list.'); return tab; }
async function readText(tabId) { const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: () => ({ text: document.body?.innerText.slice(0, 40000) || '', title: document.title }) }); return result; }
async function readElements(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: () => {
    const selector = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=menuitem],[role=combobox],[contenteditable=""],[contenteditable="true"]';
    const items = [];
    for (const el of document.querySelectorAll(selector)) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 6 || rect.height < 6) continue;
      if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) < 0.1) continue;
      const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (!name) continue;
      const role = el.getAttribute('role') || (el.tagName === 'A' ? 'link' : el.tagName === 'INPUT' ? (['submit','button'].includes(el.type) ? 'button' : 'input') : el.tagName.toLowerCase());
      items.push({ role, name, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) });
      if (items.length >= 80) break;
    }
    return items;
  } });
  return result || [];
}
async function shoot(tabId) {
  return debug(tabId, async target => {
    const metrics = await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics');
    const viewport = metrics.cssVisualViewport || metrics.visualViewport;
    const image = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', { format: 'jpeg', quality: 65, fromSurface: true });
    return { image: image.data, width: viewport.clientWidth, height: viewport.clientHeight };
  });
}
async function clickType(tab, action, width, height) {
  return debug(tab.id, async target => {
    const metrics = await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics'); const view = metrics.cssVisualViewport || metrics.visualViewport;
    if (Math.abs(view.clientWidth - width) > 1 || Math.abs(view.clientHeight - height) > 1) throw new Error('The page viewport changed. Observe it again.');
    if (action.type === 'type') {
      const check = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (x,y) => { const e = document.elementFromPoint(x,y); return !!e && (e.tagName === 'TEXTAREA' || (e.tagName === 'INPUT' && ['text','search','email','url','tel'].includes(e.type)) || e.isContentEditable || e.getAttribute('role') === 'textbox') && !e.closest('form')?.querySelector('input[type=password]'); }, args: [action.x, action.y] });
      if (!check[0].result) throw new Error('This is not an allowed text field. Password and login forms are blocked.');
    }
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: action.x, y: action.y, button: 'left', clickCount: 1 });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: action.x, y: action.y, button: 'left', clickCount: 1 });
    if (action.type === 'type') {
      const focused = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (x,y) => { const e = document.elementFromPoint(x,y); return !!e && (document.activeElement === e || e.contains(document.activeElement)) && (e.tagName === 'TEXTAREA' || (e.tagName === 'INPUT' && ['text','search','email','url','tel'].includes(e.type)) || e.isContentEditable || e.getAttribute('role') === 'textbox') && !e.closest('form')?.querySelector('input[type=password]'); }, args: [action.x, action.y] });
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
    const result = await readText(tab.id);
    return { tabId: tab.id, url: tab.url, title: result.title, text: result.text };
  }
  if (message.type === 'observe') {
    const tab = message.tabId ? await getTab(message.tabId) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!tab?.id || !tab.url) throw new Error('Select a webpage first.');
    if (!permitted(tab.url)) throw new Error('Select an HTTPS page (or a local development page). Chrome internal pages are not supported.');
    if (message.activate) { await chrome.tabs.update(tab.id, { active: true }); await new Promise(resolve => setTimeout(resolve, 350)); }
    const fresh = await getTab(tab.id);
    const [result, shot, elements] = await Promise.all([readText(fresh.id), shoot(fresh.id), readElements(fresh.id).catch(() => [])]);
    return { tabId: fresh.id, url: fresh.url, title: result.title, text: result.text, elements, ...shot };
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
    if (action.type === 'read') { const result = await readText(fresh.id); return { title: result.title, text: result.text }; }
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
