// Did that action do anything? The question is asked after every click, key and fill, and the answer
// decides whether a step is verified, whether it counts as PROVEN DONE, and whether the panel spends a
// scripted click or another round on it. It is one comparison, which is exactly why it belongs in a
// named function with tests rather than inline in five places.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Effect = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  // `before` and `after` are page fingerprints. An empty one means the page could not be read — during
  // a navigation, or on a page that blocks injection — and that is unknown, not disproved: reporting
  // it as a failure is how a working click gets retried into a double submit.
  function of(before, after, fallback = null) {
    const known = Boolean(before) && Boolean(after);
    return { verified: known ? before !== after : fallback };
  }

  // The error code the model and the timeline read. Only a real "nothing changed" earns NO_EFFECT;
  // unknown never does.
  function code(effect) {
    return effect && effect.verified === false ? 'NO_EFFECT' : undefined;
  }

  return { of, code };
});
