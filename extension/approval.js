// Approval posture, kept in storage so it survives a reload. Plan mode was remembered and this was
// not, which is what made two adjacent settings feel like one broken one.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Approval = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  // The three answers to "how much should this run do without me?". The modes are the panel's older
  // internal names and are still what the round loop checks.
  const MODES = {
    auto: { mode: 'autopilot', label: 'Run without asking', why: 'The agent acts on its own and tells you what it did.' },
    risky: { mode: 'auto', label: 'Ask only before risky steps', why: 'Steps that look irreversible wait for you; the rest do not.' },
    ask: { mode: 'manual', label: 'Ask before every round', why: 'Every round waits for your approval before it acts.' }
  };
  const ORDER = ['auto', 'risky', 'ask'];
  const read = value => (Object.prototype.hasOwnProperty.call(MODES, value) ? value : 'auto');
  const modeFor = value => MODES[read(value)].mode;
  const labelFor = value => MODES[read(value)].label;
  const whyFor = value => MODES[read(value)].why;
  const next = value => ORDER[(ORDER.indexOf(read(value)) + 1) % ORDER.length];
  return { MODES, ORDER, read, modeFor, labelFor, whyFor, next };
});
