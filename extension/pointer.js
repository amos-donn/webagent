// The agent's cursor, kept as geometry rather than as markup scattered through an injected function.
// The page-side renderer in background.js receives this object as an argument (Chrome serialises the
// function, so it cannot close over anything), and the tests read the same object — which is why the
// tip can be checked to land on the click point instead of being eyeballed.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Pointer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  // The 1.7.x arrow with its stem deleted. Every vertex is at or right of the tip's x, so nothing
  // sticks out behind it: that absence is what makes it read as a cursor rather than a mouse someone
  // is holding. The lower edge curves inward instead of running straight to the wing, which is the
  // difference between an arrowhead and a "play" triangle.
  const SHAPE = {
    viewBox: 24,
    box: 20,
    tip: [5, 3],
    next: [5, 19.6],
    wing: [18.8, 13.6],
    path: 'M5 3 L5 19.6 L9.4 15.4 L12.3 14.1 L18.8 13.6 Z',
    // Widest first: the white pass is the edge, the emerald pass the fill, and because both stroke the
    // same path the corners come out rounded without a hand-tuned bezier.
    strokes: [['#fff', 6], ['#157a52', 3.6]],
    ring: 52
  };

  const round = value => Math.round(value * 100) / 100;
  const unit = (from, to) => {
    const dx = to[0] - from[0], dy = to[1] - from[1];
    const length = Math.hypot(dx, dy) || 1;
    return [dx / length, dy / length];
  };

  function geometry(shape = SHAPE) {
    const scale = shape.box / shape.viewBox;
    const tip = [shape.tip[0] * scale, shape.tip[1] * scale];
    // A round join grows the tip outward along the bisector of its two edges by half the widest
    // stroke. Offsetting the box by that amount is what puts the painted tip, not the raw vertex, on
    // the coordinate the agent clicked.
    const a = unit(shape.tip, shape.next), b = unit(shape.tip, shape.wing);
    const bisector = unit([0, 0], [a[0] + b[0], a[1] + b[1]]);
    const reach = (Math.max(...shape.strokes.map(([, width]) => width)) / 2) * scale;
    const inset = { x: round(tip[0] - bisector[0] * reach), y: round(tip[1] - bisector[1] * reach) };
    return {
      viewBox: shape.viewBox,
      size: shape.box,
      path: shape.path,
      strokes: shape.strokes.map(([paint, width]) => [paint, width]),
      ring: shape.ring,
      // Where the unpainted tip sits in the box, for reference.
      tip: { x: round(tip[0]), y: round(tip[1]) },
      // How far the box hangs off the click point, and the pivot the press animation squashes around.
      // Both are the painted tip, so a click scales in place instead of sliding.
      inset,
      origin: { x: inset.x, y: inset.y },
      wrap: '.wrap{position:fixed;left:0;top:0;width:0;height:0;will-change:transform}',
      arrow: `.arrow{position:absolute;left:${-inset.x}px;top:${-inset.y}px;width:${shape.box}px;height:${shape.box}px;overflow:visible;opacity:0;transform-origin:${inset.x}px ${inset.y}px;filter:drop-shadow(0 2px 5px rgba(9,60,40,.34)) drop-shadow(0 0 4px rgba(21,122,82,.38))}`,
      ringCss: `.ring{position:absolute;left:${-shape.ring / 2}px;top:${-shape.ring / 2}px;width:${shape.ring}px;height:${shape.ring}px;border-radius:50%;border:2px solid rgba(21,122,82,.75);background:radial-gradient(circle,rgba(21,122,82,.24),rgba(21,122,82,0) 70%);opacity:0}`
    };
  }

  // The tip is a vertex of the path; a shape with a stem would have points behind it.
  function vertices(path = SHAPE.path) {
    return [...String(path).matchAll(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g)].map(match => [Number(match[1]), Number(match[2])]);
  }

  return { SHAPE, geometry, vertices };
});
