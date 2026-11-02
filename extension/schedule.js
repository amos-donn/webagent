// Scheduling maths, kept away from chrome.* so it can be tested: how often, when next, and which
// entries are due. The background owns the alarm and the tab; nothing here touches either.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Schedule = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MINUTE = 60 * 1000;
  const KEY = 'schedules';
  const ALARM = 'mezze-schedule';
  const LIMIT = 20;

  function parseEvery(value) {
    const raw = String(value ?? '').trim().toLowerCase();
    if (!raw || raw === 'off') return null;
    const match = raw.match(/^(\d{1,4})\s*(m|min|mins|minutes?|h|hrs?|hours?|d|days?)?$/);
    if (!match) return null;
    const count = Number(match[1]);
    const unit = match[2] || 'm';
    const minutes = unit.startsWith('h') ? count * 60 : unit.startsWith('d') ? count * 1440 : count;
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 7 * 1440) return null;
    return minutes;
  }

  const nextAt = (now, every) => Number(now) + Number(every) * MINUTE;

  const due = (list, now) => (Array.isArray(list) ? list : [])
    .filter(entry => entry && entry.prompt && (!entry.nextRun || entry.nextRun <= now));

  const describe = entry => {
    const every = Number(entry?.every) || 0;
    const span = every < 60 ? `${every} min` : every < 1440 ? `${Math.round(every / 60)} h` : `${Math.round(every / 1440)} d`;
    return `${span} · ${String(entry?.prompt || '').slice(0, 60)}`;
  };

  function add(list, prompt, every, now) {
    const text = String(prompt || '').trim();
    const minutes = parseEvery(every);
    if (!text) throw new Error('A scheduled task needs something to do.');
    if (!minutes) throw new Error('Say how often, like /every 60 summarize my inbox.');
    if ((list || []).length >= LIMIT) throw new Error(`That is already ${LIMIT} scheduled tasks. Remove one first.`);
    return {
      id: Math.random().toString(36).slice(2, 8),
      prompt: text.slice(0, 500),
      every: minutes,
      nextRun: nextAt(now, minutes),
      runs: 0
    };
  }

  return { KEY, ALARM, LIMIT, MINUTE, parseEvery, nextAt, due, describe, add };
});
