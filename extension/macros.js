// Macros: the pure half of recording and replay. Nothing here touches a page — the recorder and the
// locator resolver run inside the tab as self-contained injected functions in background.js. This
// file is shared by the panel and the tests, so it stays free of chrome.* too.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Macros = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Replay tries these in order. An accessible role and name outrank a generated id, and a
  // structural CSS path is the last thing to try rather than the first: a class hash changes on every
  // deploy, a button's label usually does not.
  const ORDER = ['testid', 'role', 'label', 'name', 'id', 'text', 'css'];
  const TYPES = ['click', 'fill', 'select', 'key', 'navigate', 'secret', 'switch'];
  // What a key step is allowed to be. A shortcut only belongs in a macro when replaying it does the
  // same thing again: Escape closes a dialog, and these commands act on the page rather than on a
  // caret. Typing, pasting, undoing and selecting inside a field are recorded as that field's value
  // instead, because replay would depend on a selection the macro never captured and on whatever is
  // on the clipboard at the time.
  const KEYS = ['Enter', 'Escape'];
  const SHORTCUTS = ['A', 'C', 'V', 'X', 'Z', 'Y'];
  const MODIFIERS = { control: 'Control', ctrl: 'Control', meta: 'Meta', cmd: 'Meta', command: 'Meta', alt: 'Alt', option: 'Alt', shift: 'Shift' };
  const MODIFIER_ORDER = ['Control', 'Meta', 'Alt', 'Shift'];

  // One spelling for every platform's idea of the same chord, so a stored step reads the same way it
  // will be pressed.
  function keySpec(value) {
    const parts = String(value ?? '').split('+').map(part => part.trim()).filter(Boolean);
    if (!parts.length || parts.length > 3) return '';
    const name = parts[parts.length - 1];
    if (parts.length === 1) return KEYS.includes(name) ? name : '';
    const modifiers = [];
    for (const part of parts.slice(0, -1)) {
      const canonical = MODIFIERS[part.toLowerCase()];
      if (!canonical || modifiers.includes(canonical)) return '';
      modifiers.push(canonical);
    }
    const letter = name.toUpperCase();
    if (letter.length !== 1 || !SHORTCUTS.includes(letter)) return '';
    if (!modifiers.includes('Control') && !modifiers.includes('Meta')) return '';
    return [...modifiers].sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b)).concat(letter).join('+');
  }

  const prettyKey = spec => String(spec ?? '').split('+').map(part => ({ Control: 'Ctrl', Meta: 'Cmd' }[part] || part)).join('+');
  const STEPS = 200;

  const clean = (value, max = 160) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const host = value => { try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return ''; } };
  // A step names a page, not a tab: by the time a macro is replayed the tab that held it is often
  // closed. The hash is dropped because it rarely makes a page different; the query is kept because
  // it often does.
  function pageKey(value) {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname.replace(/\/$/, '')}${url.search}`.toLowerCase();
    } catch { return ''; }
  }
  function pageLoose(value) {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname.replace(/\/$/, '')}`.toLowerCase();
    } catch { return ''; }
  }

  function normalise(candidate) {
    if (!candidate || typeof candidate !== 'object') return null;
    const k = clean(candidate.k, 12);
    if (!ORDER.includes(k)) return null;
    const value = clean(candidate.value, 200);
    if (!value) return null;
    const out = { k, value, nth: Math.max(0, Number(candidate.nth) || 0), count: Math.max(1, Number(candidate.count) || 1) };
    const name = clean(candidate.name, 120);
    if (name) out.name = name;
    return out;
  }

  // Candidates arrive in whatever order the page produced them; this is the order replay uses.
  function rank(candidates) {
    if (!Array.isArray(candidates)) return [];
    const seen = new Set(), out = [];
    for (const strategy of ORDER) {
      for (const raw of candidates) {
        const candidate = normalise(raw);
        if (!candidate || candidate.k !== strategy) continue;
        const key = `${candidate.k}|${candidate.value}|${candidate.name || ''}|${candidate.nth}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(candidate);
      }
    }
    return out;
  }

  const first = step => (Array.isArray(step?.target) ? step.target[0] : null);
  const targetKey = step => {
    const candidate = first(step);
    return candidate ? `${candidate.k}|${candidate.value}|${candidate.nth}` : '';
  };

  // One line a person can read: what the step does, not how it is encoded.
  function label(step) {
    if (!step) return '';
    if (step.type === 'navigate') return `Open ${host(step.url) || clean(step.url, 60)}`;
    if (step.type === 'switch') return `Switch to ${host(step.url) || clean(step.url, 60)}`;
    if (step.type === 'key') return `Press ${prettyKey(clean(step.key, 24)) || 'a key'}`;
    const candidate = first(step);
    const name = clean(step.label, 70) || clean(candidate?.name, 70) || clean(candidate?.value, 70) || 'the element';
    if (step.type === 'fill') return `Type “${clean(step.text, 40)}” into ${name}`;
    if (step.type === 'select') return `Choose “${clean(step.value, 40)}” in ${name}`;
    if (step.type === 'secret') return `Type your own value into ${name}`;
    return `Click ${name}`;
  }

  // Typing arrives as one event per keystroke. A field is one step holding the final value, so the
  // list reads like the task and replay does not insert text character by character.
  function append(steps, step) {
    const list = Array.isArray(steps) ? steps.slice() : [];
    if (!step || !TYPES.includes(step.type)) return list;
    const last = list[list.length - 1];
    if (step.type === 'fill' && last?.type === 'fill' && targetKey(last) === targetKey(step)) {
      list[list.length - 1] = { ...last, text: step.text, at: step.at || last.at };
      return list;
    }
    // Going back to the tab you are already in is not a step the replay needs.
    if (step.type === 'switch' && last?.type === 'switch' && last.url === step.url) {
      list[list.length - 1] = { ...last, at: step.at || last.at };
      return list;
    }
    list.push(step);
    return list.slice(-STEPS);
  }

  // Everything a macro stores passes through here, which is also the one place that guarantees a
  // credential never lands in storage: a secret step keeps its target and loses any text.
  function prune(steps) {
    const out = [];
    for (const raw of Array.isArray(steps) ? steps : []) {
      if (!raw || !TYPES.includes(raw.type)) continue;
      if (raw.type === 'navigate') {
        const url = String(raw.url ?? '').slice(0, 2000);
        if (!url) continue;
        out.push({ type: 'navigate', url, at: raw.at });
        continue;
      }
      if (raw.type === 'key') {
        const key = keySpec(raw.key);
        if (!key) continue;
        out.push({ type: 'key', key, at: raw.at });
        continue;
      }
      if (raw.type === 'switch') {
        const url = String(raw.url ?? '').slice(0, 2000);
        if (!/^https?:\/\//i.test(url)) continue;
        const previous = out[out.length - 1];
        if (previous?.type === 'switch' && previous.url === url) continue;
        out.push({ type: 'switch', url, at: raw.at });
        continue;
      }
      const target = rank(raw.target);
      if (!target.length) continue;
      const step = { type: raw.type, target, label: clean(raw.label, 120), at: raw.at };
      if (raw.type === 'fill') step.text = String(raw.text ?? '').slice(0, 2000);
      if (raw.type === 'select') step.value = clean(raw.value, 200);
      if (raw.type === 'secret') delete step.text;
      out.push(step);
    }
    return out.slice(-STEPS);
  }

  function summary(macro) {
    const count = Array.isArray(macro?.steps) ? macro.steps.length : 0;
    const where = host(macro?.startUrl);
    return `${count} step${count === 1 ? '' : 's'}${where ? ` · ${where}` : ''}`;
  }

  function nameFor(title, url) {
    return clean(title, 48) || host(url) || 'New macro';
  }

  // A step that cannot find its target is not a dead end: the agent can finish the macro from the
  // page it is on, and this is the message that says so without the user describing the task again.
  function recovery(macro, index, reason) {
    const steps = Array.isArray(macro?.steps) ? macro.steps : [];
    const from = Math.max(0, Math.min(Number(index) || 0, steps.length));
    const remaining = steps.slice(from).map((step, offset) => `${from + offset + 1}. ${label(step)}`);
    return [
      `Continue the macro “${clean(macro?.name, 60) || 'macro'}” from step ${from + 1}.`,
      `That step failed: ${clean(reason, 200)}`,
      remaining.length ? `Remaining steps:\n${remaining.join('\n')}` : ''
    ].filter(Boolean).join('\n');
  }

  // The rail shows the macros you pinned, as one letter each: it is a launcher, not a menu, so the
  // list stays short by design and an unpinned macro never appears there.
  const RAIL = 8;
  function rail(macros) {
    return (Array.isArray(macros) ? macros : [])
      .filter(macro => macro && macro.pinned === true && Array.isArray(macro.steps) && macro.steps.length)
      .slice(0, RAIL)
      .map(macro => {
        const name = clean(macro.name, 60) || 'Macro';
        const first = name.match(/[\p{L}\p{N}]/u);
        return { id: String(macro.id || ''), name, letter: first ? first[0].toUpperCase() : '?' };
      })
      .filter(entry => entry.id);
  }
  return { rail, RAIL, ORDER, TYPES, KEYS, SHORTCUTS, STEPS, rank, append, prune, label, summary, nameFor, recovery, host, pageKey, pageLoose, keySpec };
});
