// Macro rail: the macros you pinned, as a strip of icons down the right edge of the page. A macro you
// run twenty times a day should not need the side panel opened first, so this is the launcher — one
// click, no model call, no panel. It is only as wide as the icons and folds to a tab, it lives in its
// own shadow root so no page stylesheet reaches it, and it paints nothing until the panel sends a
// list. Presentation only: a click asks the background to run the macro, and the panel owns replay.
(function () {
  if (window.MezzeRail) return;
  const CSS = `
  :host { all: initial; }
  #rail { position: fixed; top: 50%; right: 0; transform: translateY(-50%); z-index: 2147483646;
    display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 8px 6px;
    border: 1px solid rgba(120,120,130,.3); border-right: 0; border-radius: 14px 0 0 14px;
    background: rgba(250,250,250,.88); color: #18181b; box-shadow: 0 10px 30px rgba(0,0,0,.18);
    backdrop-filter: blur(12px); font: 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif; }
  @media (prefers-color-scheme: dark) {
    #rail { background: rgba(24,24,27,.88); color: #f4f4f5; border-color: rgba(160,160,170,.28); box-shadow: 0 10px 30px rgba(0,0,0,.5); }
  }
  .icon { all: unset; display: flex; align-items: center; justify-content: center; width: 28px; height: 28px;
    border-radius: 9px; border: 1px solid rgba(120,120,130,.32); cursor: pointer; font-weight: 600;
    font-size: 12px; color: inherit; background: transparent; box-sizing: border-box; }
  .icon:hover { background: rgba(16,185,129,.16); border-color: rgba(16,185,129,.5); }
  .icon:focus-visible { outline: 2px solid #10b981; outline-offset: 1px; }
  .icon.ran { background: rgba(16,185,129,.3); border-color: rgba(16,185,129,.6); }
  .tuck { all: unset; width: 18px; height: 14px; cursor: pointer; opacity: .5; text-align: center;
    font-size: 11px; line-height: 14px; color: inherit; }
  .tuck:hover { opacity: 1; }
  .tuck:focus-visible { outline: 2px solid #10b981; outline-offset: 1px; border-radius: 4px; }
  #rail[folded] .icon { display: none; }
  #rail[folded] { padding: 6px 4px; }
  @media (prefers-reduced-motion: reduce) { .icon { transition: none; } }
  `;
  const state = { host: null, root: null, rail: null, entries: [], folded: false };

  function build() {
    if (state.host?.isConnected) return;
    const host = document.createElement('div');
    host.setAttribute('data-mezze-rail', '');
    const root = host.attachShadow({ mode: 'open' });
    // A constructed sheet is not an inline <style>, so a strict page CSP cannot refuse it.
    try { const sheet = new CSSStyleSheet(); sheet.replaceSync(CSS); root.adoptedStyleSheets = [sheet]; }
    catch { const style = document.createElement('style'); style.textContent = CSS; root.append(style); }
    const rail = document.createElement('nav');
    rail.id = 'rail';
    rail.setAttribute('aria-label', 'Macros');
    root.append(rail);
    document.documentElement.append(host);
    state.host = host;
    state.root = root;
    state.rail = rail;
  }

  function paint() {
    const rail = state.rail;
    if (!rail) return;
    rail.textContent = '';
    rail.toggleAttribute('folded', state.folded);
    for (const entry of state.entries) {
      const icon = document.createElement('button');
      icon.type = 'button';
      icon.className = 'icon';
      icon.textContent = entry.letter || '?';
      icon.title = `${entry.name} — run this macro`;
      icon.setAttribute('aria-label', `Run macro ${entry.name}`);
      icon.addEventListener('click', () => run(entry, icon));
      rail.append(icon);
    }
    const tuck = document.createElement('button');
    tuck.type = 'button';
    tuck.className = 'tuck';
    tuck.textContent = state.folded ? '\u2039' : '\u203a';
    tuck.title = state.folded ? 'Show macros' : 'Hide macros';
    tuck.setAttribute('aria-label', tuck.title);
    tuck.setAttribute('aria-expanded', state.folded ? 'false' : 'true');
    tuck.addEventListener('click', () => { state.folded = !state.folded; paint(); });
    rail.append(tuck);
  }

  function run(entry, icon) {
    icon.classList.add('ran');
    setTimeout(() => icon.classList.remove('ran'), 700);
    try { chrome.runtime.sendMessage({ type: 'rail-run', id: entry.id }); } catch { /* the extension was reloaded */ }
  }

  function render(entries) {
    const list = (Array.isArray(entries) ? entries : []).filter(entry => entry && typeof entry.id === 'string' && entry.id);
    state.entries = list;
    if (!list.length) {
      state.host?.remove();
      state.host = null;
      state.root = null;
      state.rail = null;
      return false;
    }
    build();
    paint();
    return true;
  }

  window.MezzeRail = { render, state };
})();
