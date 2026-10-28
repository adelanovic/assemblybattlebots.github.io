/*
 * geometry.js — Small, pure geometry helpers used by the simulation.
 * Angles are degrees, 0 = +x (east), 90 = +y (south / down the screen).
 */
(function (BB) {
  'use strict';

  const DEG = Math.PI / 180;

  /** Wrap to [0, 360). */
  function normAngle(a) {
    a %= 360;
    return a < 0 ? a + 360 : a;
  }

  /** Signed shortest difference target - current, in [-180, 180). */
  function angleDiff(target, current) {
    return normAngle(target - current + 180) - 180;
  }

  /** Move `current` toward `target` by at most `rate` degrees. */
  function rotateToward(current, target, rate) {
    const d = angleDiff(target, current);
    if (Math.abs(d) <= rate) return normAngle(target);
    return normAngle(current + Math.sign(d) * rate);
  }

  function angleTo(x1, y1, x2, y2) {
    return normAngle(Math.atan2(y2 - y1, x2 - x1) / DEG);
  }

  function pointInRect(x, y, r) {
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }

  /**
   * Distance along a ray (ox,oy)+t*(dx,dy) to the first hit with rect r,
   * or Infinity. (dx,dy) should be a unit vector. Slab method.
   */
  function rayRect(ox, oy, dx, dy, r) {
    let tmin = -Infinity, tmax = Infinity;
    for (const [o, d, lo, hi] of [[ox, dx, r.x, r.x + r.w], [oy, dy, r.y, r.y + r.h]]) {
      if (Math.abs(d) < 1e-9) {
        if (o < lo || o > hi) return Infinity;
      } else {
        let t1 = (lo - o) / d, t2 = (hi - o) / d;
        if (t1 > t2) [t1, t2] = [t2, t1];
        tmin = Math.max(tmin, t1);
        tmax = Math.min(tmax, t2);
        if (tmin > tmax) return Infinity;
      }
    }
    if (tmax < 0) return Infinity;
    return Math.max(tmin, 0);
  }

  /** Travel distance before a moving circle touches a rect; unit direction. */
  function sweptCircleRect(ox, oy, dx, dy, radius, r) {
    // Minkowski sum: two face strips and four round corners, not an AABB.
    const stripDistance = (strip) => {
      const distance = rayRect(ox, oy, dx, dy, strip);
      // Contact behind us must not prevent driving away from a wall.
      if (distance === 0 && !pointInRect(ox + dx * 1e-7, oy + dy * 1e-7, strip)) return Infinity;
      return distance;
    };
    let t = Math.min(
      stripDistance({ x: r.x - radius, y: r.y, w: r.w + 2 * radius, h: r.h }),
      stripDistance({ x: r.x, y: r.y - radius, w: r.w, h: r.h + 2 * radius }),
    );
    for (const x of [r.x, r.x + r.w]) for (const y of [r.y, r.y + r.h]) {
      const vx = ox - x, vy = oy - y;
      const c = vx * vx + vy * vy - radius * radius;
      const b = vx * dx + vy * dy;
      // Touching a corner (rounding can put us a hair inside) only blocks driving toward it.
      if (c < 0) { if (b < 0) return 0; continue; }
      const discriminant = b * b - c;
      if (discriminant < 0) continue;
      const near = -b - Math.sqrt(discriminant);
      if (near >= 0) t = Math.min(t, near);
    }
    return t;
  }

  /** True if segment (x1,y1)-(x2,y2) touches rect r. */
  function segmentHitsRect(x1, y1, x2, y2, r) {
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 1e-9) return pointInRect(x1, y1, r);
    return rayRect(x1, y1, (x2 - x1) / len, (y2 - y1) / len, r) <= len;
  }

  /**
   * If a circle overlaps rect r, return the push-out vector {x, y, depth},
   * otherwise null.
   */
  function circleRectPush(cx, cy, radius, r) {
    const nx = Math.max(r.x, Math.min(cx, r.x + r.w));
    const ny = Math.max(r.y, Math.min(cy, r.y + r.h));
    let dx = cx - nx, dy = cy - ny;
    const d2 = dx * dx + dy * dy;
    if (d2 >= radius * radius) return null;
    if (d2 > 1e-9) {
      const d = Math.sqrt(d2);
      return { x: dx / d, y: dy / d, depth: radius - d };
    }
    // Centre is inside the rect: push out along the shallowest axis.
    const left = cx - r.x, right = r.x + r.w - cx, top = cy - r.y, bottom = r.y + r.h - cy;
    const m = Math.min(left, right, top, bottom);
    if (m === left) return { x: -1, y: 0, depth: left + radius };
    if (m === right) return { x: 1, y: 0, depth: right + radius };
    if (m === top) return { x: 0, y: -1, depth: top + radius };
    return { x: 0, y: 1, depth: bottom + radius };
  }

  /** Deterministic PRNG (mulberry32). Returns a function -> [0, 1). */
  function makeRng(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  BB.geo = { DEG, normAngle, angleDiff, rotateToward, angleTo, pointInRect, rayRect, sweptCircleRect, segmentHitsRect, circleRectPush, makeRng };
})(globalThis.BB = globalThis.BB || {});
