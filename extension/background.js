chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
async function activeTab() { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (!tab?.id || !tab.url) throw new Error('Select a webpage first.'); return tab; }
function permitted(url) { const u = new URL(url); return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)); }
async function debug(tabId, fn) { const target = { tabId }; await chrome.debugger.attach(target, '1.3'); try { return await fn(target); } finally { await chrome.debugger.detach(target).catch(() => {}); } }
async function handle(message) {
  const tab = await activeTab();
  if (!permitted(tab.url)) throw new Error('Select an HTTPS page (or a local development page). Chrome internal pages are not supported.');
  if (message.type === 'observe') {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => ({ text: document.body?.innerText.slice(0, 40000) || '', title: document.title }) });
    return debug(tab.id, async target => { const metrics = await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics'); const viewport = metrics.cssVisualViewport || metrics.visualViewport; const image = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', { format: 'jpeg', quality: 65, fromSurface: true }); return { tabId: tab.id, url: tab.url, title: result.title, text: result.text, image: image.data, width: viewport.clientWidth, height: viewport.clientHeight }; });
  }
  if (message.type === 'act') {
    if (tab.id !== message.tabId || tab.url !== message.url) throw new Error('The active page changed. Observe it again.');
    const action = message.action;
    if (action.type === 'navigate') { const url = new URL(action.url); if (!permitted(url.href) || url.username || url.password) throw new Error('Only HTTPS or local URLs are allowed.'); await chrome.tabs.update(tab.id, { url: url.href }); return {}; }
    if (action.type === 'scroll') { if (!['up', 'down'].includes(action.direction)) throw new Error('Invalid scroll direction.'); await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: direction => window.scrollBy({ top: direction === 'up' ? -Math.round(innerHeight * .75) : Math.round(innerHeight * .75), behavior: 'instant' }), args: [action.direction] }); return {}; }
    if (!['click', 'type'].includes(action.type) || ![action.x, action.y, message.width, message.height].every(Number.isFinite) || action.x < 0 || action.y < 0 || action.x >= message.width || action.y >= message.height) throw new Error('Invalid action coordinates.');
    if (action.type === 'type' && (typeof action.text !== 'string' || action.text.length > 5000)) throw new Error('Invalid text.');
    return debug(tab.id, async target => {
      const metrics = await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics'); const view = metrics.cssVisualViewport || metrics.visualViewport;
      if (Math.abs(view.clientWidth - message.width) > 1 || Math.abs(view.clientHeight - message.height) > 1) throw new Error('The page viewport changed. Observe it again.');
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
      }
      return {};
    });
  }
  throw new Error('Unknown action.');
}
chrome.runtime.onMessage.addListener((message, sender, respond) => { if (sender.id !== chrome.runtime.id) return; handle(message).then(data => respond({ data }), e => respond({ error: e.message })); return true; });
