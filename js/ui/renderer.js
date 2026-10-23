/*
 * renderer.js — Draws a World onto a <canvas>. Read-only with respect to
 * the simulation; owns only cosmetic state (particles, flashes, a cached
 * floor). Visual randomness uses Math.random and never touches the world RNG.
 * Static terrain art lives in terrain.js, which must load first.
 */
(function (BB) {
  'use strict';

  const C = BB.CONFIG;
  const T = BB.terrain;
  const DEG = Math.PI / 180;
  const TAU = Math.PI * 2;
  const MAX_PARTICLES = 350;
  const MAX_SCARS = 400;      // oldest scars fade out past this
  const MAX_IGNITED = 30;     // fires that shots can start per match
  const MAX_TRACKS = 900;     // mud track segments kept at once
  const TRACK_LIFE = 900;     // ticks for a mud track to fade out
  const FIRE_LIGHT = 80;      // how far a fire lights robots, in units
  const MAX_CASINGS = 40;     // spent shell casings lying around
  const MAX_DENTS = 8;        // dents remembered per robot

  // Robot body geometry (robot-local units, +x = heading). The collision
  // circle has radius C.ROBOT_RADIUS (16); the hull fits just inside it.
  const HULL = { x: -12, y: -9, w: 24, h: 18, r: 4 };
  const TREAD = { x: -14, len: 28, inner: 8, outer: 14 };

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.showScans = true;
      this.particles = [];
      this.robotFx = new Map();   // robot id -> { flash, muzzle } frame counters
      this.floor = null;          // offscreen canvas: floor + obstacles
      this.decals = null;         // offscreen canvas: battle scars, rebuilt from `scars`
      this.scars = [];            // { kind: 'crater' | 'char', x, y, r, seed }
      this.ignited = [];          // fires started by shots this match
      this.tracks = [];           // mud track segments { x1, y1, x2, y2, heading, drive, tick }
      this.casings = [];          // spent shell casings, drawn under the robots
      this.world = null;
      this.resize();
    }

    /**
     * Size the canvas to `cssWidth` CSS pixels (height follows the arena's
     * aspect ratio). The backing store matches the physical pixels so the
     * arena stays sharp at any size; drawing still uses arena units.
     */
    resize(cssWidth = C.ARENA_W) {
      const dpr = window.devicePixelRatio || 1;
      const cssHeight = cssWidth * C.ARENA_H / C.ARENA_W;
      this.canvas.style.width = `${cssWidth}px`;
      this.canvas.style.height = `${cssHeight}px`;
      this.canvas.width = Math.round(cssWidth * dpr);
      this.canvas.height = Math.round(cssHeight * dpr);
      this.scale = (cssWidth / C.ARENA_W) * dpr;
      this.ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
      this.floor = null;
      this.decals = null;
    }

    /** Forget all cosmetic state (called when a new match starts). */
    clearEffects() {
      this.particles = [];
      this.robotFx.clear();
      this.scars = [];
      this.ignited = [];
      this.tracks = [];
      this.casings = [];
      this.decals = null;
      this.lastTick = undefined;
      this.overAt = undefined;    // when the victory card started fading in
    }

    fx(id) {
      let f = this.robotFx.get(id);
      if (!f) { f = { flash: 0, muzzle: 0 }; this.robotFx.set(id, f); }
      return f;
    }

    addEvents(events) {
      for (const e of events) {
        switch (e.type) {
          case 'fire':
            this.fx(e.robot).muzzle = 4;
            this.shotFired(e);
            break;
          case 'hit':
            if (e.robot !== undefined) { this.fx(e.robot).flash = 6; this.addDent(e); }
            this.burst(e.x, e.y, 7, ['#fff6d5', '#ffb347', e.color], 1.5, 3.5, 10, 2);
            this.particles.push({ kind: 'flash', x: e.x, y: e.y, size: 9, life: 5, max: 5, color: '#fff3c4' });
            break;
          case 'spark':
            this.shotHitTerrain(e.x, e.y);
            break;
          case 'bump':
            this.burst(e.x, e.y, 4, ['#ffcc80', '#ffffff'], 1, 2, 7, 1.5);
            break;
          case 'explode':
            this.particles.push({ kind: 'flash', x: e.x, y: e.y, size: 34, life: 12, max: 12, color: '#ffe2a8' });
            this.particles.push({ kind: 'ring', x: e.x, y: e.y, size: 70, life: 22, max: 22, color: '#ffffff' });
            this.burst(e.x, e.y, 22, ['#ffb347', '#ff6a3d', '#fff1c1', e.color], 1.5, 5.5, 28, 2.6);
            for (let i = 0; i < 8; i++) this.smoke(e.x, e.y, 1.6);
            this.addScar({ kind: 'crater', x: e.x, y: e.y, r: 15 + Math.random() * 5 });
            break;
        }
      }
      if (this.particles.length > MAX_PARTICLES) this.particles.splice(0, this.particles.length - MAX_PARTICLES);
    }

    burst(x, y, n, colors, vmin, vmax, life, size) {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * TAU, v = vmin + Math.random() * (vmax - vmin);
        this.particles.push({
          kind: 'spark', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
          life: life * (0.6 + Math.random() * 0.4), max: life,
          color: colors[i % colors.length], size: size * (0.6 + Math.random() * 0.6),
        });
      }
    }

    /**
     * A shot stopped at x, y. Trees splinter, get charred and may catch fire;
     * the arena wall throws sparks and dust.
     */
    shotHitTerrain(x, y) {
      const world = this.world;
      const tree = world && world.obstacles.some((o) => BB.geo.pointInRect(x, y, { x: o.x - 1, y: o.y - 1, w: o.w + 2, h: o.h + 2 }));
      if (!tree) {
        this.burst(x, y, 4, ['#ffd27f', '#c9d0dc'], 1, 2.5, 6, 1.3);
        for (let i = 0; i < 3; i++) this.dust(x, y, '#8a7a62');
        return;
      }
      this.burst(x, y, 2, ['#ffd27f'], 1, 2, 5, 1.2);
      for (let i = 0; i < 6; i++) {
        const a = Math.random() * TAU, v = 0.8 + Math.random() * 2;
        this.particles.push({
          kind: 'chip', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, spin: (Math.random() - 0.5) * 0.6, angle: Math.random() * TAU,
          life: 18 + Math.random() * 10, max: 28, size: 1.2 + Math.random() * 1.4,
          color: ['#6b4a2e', '#4a3320', '#8a6a44', '#3f5a2c'][Math.floor(Math.random() * 4)],
        });
      }
      this.dust(x, y, '#5a4a36');
      this.addScar({ kind: 'char', x, y, r: 4 + Math.random() * 3 });
      const burning = (this.fires || []).concat(this.ignited);
      if (Math.random() < 0.12 && this.ignited.length < MAX_IGNITED && !burning.some((f) => Math.hypot(f.x - x, f.y - y) < 14)) {
        this.ignited.push({ x, y, r: 8 + Math.random() * 5, phase: Math.random() * TAU, born: performance.now() });
      }
    }

    addScar(scar) {
      scar.seed = Math.floor(Math.random() * 4294967296);
      this.scars.push(scar);
      if (this.scars.length > MAX_SCARS) { this.scars.shift(); this.decals = null; }
      else if (this.decals) T.drawScar(this.decals.getContext('2d'), scar);
    }

    renderDecals() {
      const c = document.createElement('canvas');
      c.width = this.canvas.width;
      c.height = this.canvas.height;
      const g = c.getContext('2d');
      g.setTransform(this.scale, 0, 0, this.scale, 0, 0);
      for (const scar of this.scars) T.drawScar(g, scar);
      return c;
    }

    /** A shot left the barrel: a puff of smoke and a casing kicked out of the turret's side. */
    shotFired(e) {
      const dx = Math.cos(e.angle * DEG), dy = Math.sin(e.angle * DEG);
      for (let i = 0; i < 2; i++) {
        this.puff(e.x + dx * 3, e.y + dy * 3,
          dx * (0.4 + Math.random() * 0.4) + (Math.random() - 0.5) * 0.3, dy * (0.4 + Math.random() * 0.4) + (Math.random() - 0.5) * 0.3,
          2 + Math.random() * 2, 26);
      }
      // Starts at the hull edge and travels 13-23 units, so it comes to rest clear of the robot.
      const side = Math.random() < 0.5 ? -1 : 1, v = 1.6 + Math.random() * 1.2;
      this.casings.push({
        x: e.rx - dy * side * 9, y: e.ry + dx * side * 9,
        vx: -dy * side * v - dx * 0.3, vy: dx * side * v - dy * 0.3,
        angle: Math.random() * TAU, spin: (Math.random() - 0.5) * 0.8, life: 150,
      });
      if (this.casings.length > MAX_CASINGS) this.casings.shift();
    }

    /** Remember where a shot struck a robot, in hull coordinates so the dent turns with it. */
    addDent(e) {
      const c = Math.cos(-e.heading * DEG), sn = Math.sin(-e.heading * DEG);
      let lx = (e.x - e.rx) * c - (e.y - e.ry) * sn, ly = (e.x - e.rx) * sn + (e.y - e.ry) * c;
      const d = Math.hypot(lx, ly), max = 9;
      if (d > max) { lx *= max / d; ly *= max / d; }
      const f = this.fx(e.robot);
      f.dents = f.dents || [];
      f.dents.push({ x: lx, y: ly, r: 1.6 + Math.random(), a: Math.random() * TAU });
      if (f.dents.length > MAX_DENTS) f.dents.shift();
    }

    /** One soft particle that drifts and grows: smoke, dust or a muzzle puff. */
    puff(x, y, vx, vy, size, life, kind = 'smoke', color) {
      this.particles.push({ kind, x, y, vx, vy, size, life, max: life, color });
    }

    dust(x, y, color) {
      this.puff(x + (Math.random() - 0.5) * 4, y + (Math.random() - 0.5) * 4,
        (Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.8, 2 + Math.random() * 2, 24, 'dust', color);
    }

    /** Spent casings skid to a stop and fade out; they age by simulated ticks, so they freeze while paused. */
    drawCasings(ctx, ticks) {
      if (!this.casings.length) return;
      const keep = [];
      for (const c of this.casings) {
        for (let i = 0; i < ticks && (c.vx || c.vy); i++) {
          c.x += c.vx; c.y += c.vy; c.vx *= 0.88; c.vy *= 0.88; c.angle += c.spin; c.spin *= 0.88;
          if (Math.abs(c.vx) + Math.abs(c.vy) < 0.01) c.vx = c.vy = 0;
        }
        c.life -= ticks;
        if (c.life <= 0) continue;
        keep.push(c);
        ctx.save();
        ctx.globalAlpha = 0.75 * Math.min(1, c.life / 40);
        ctx.translate(c.x, c.y);
        ctx.rotate(c.angle);
        ctx.fillStyle = '#86703a';
        ctx.fillRect(-1.6, -0.7, 3.2, 1.4);
        ctx.fillStyle = 'rgba(230,205,140,0.35)';
        ctx.fillRect(-1.6, -0.7, 3.2, 0.45);
        ctx.fillStyle = '#4f3f1e';
        ctx.fillRect(1.1, -0.7, 0.5, 1.4);
        ctx.restore();
      }
      this.casings = keep;
    }

    smoke(x, y, spread = 0.4) {
      this.puff(x + (Math.random() - 0.5) * 6, y + (Math.random() - 0.5) * 6,
        (Math.random() - 0.5) * spread, (Math.random() - 0.5) * spread - 0.15, 3 + Math.random() * 3, 40);
    }

    // ------------------------------------------------------------ frame

    /** `paused`: the match is not running, so intention labels are worth reading. */
    draw(world, selectedEntryId, { paused = false } = {}) {
      const ctx = this.ctx;
      if (world !== this.world) { this.world = world; this.floor = null; this.clearEffects(); }
      if (!this.floor) this.floor = this.renderFloor(world);
      ctx.drawImage(this.floor, 0, 0, C.ARENA_W, C.ARENA_H);
      if (!world) return;
      if (!this.decals) this.decals = this.renderDecals();
      ctx.drawImage(this.decals, 0, 0, C.ARENA_W, C.ARENA_H);

      const now = performance.now();
      // Ticks simulated since the last frame: 0 while paused, so tick-based effects freeze.
      const ticks = this.lastTick === undefined ? 0 : Math.min(150, Math.max(0, world.tick - this.lastTick));
      this.lastTick = world.tick;
      this.updateMud(world);
      this.drawTracks(ctx, world.tick);
      if (world.mission && world.mission.zone) this.drawZone(ctx, world.mission.zone, now, world.mission.def.zoneLabel);
      this.drawFires(ctx, now);
      this.drawCasings(ctx, ticks);
      for (const r of world.robots) if (!r.alive) this.drawWreck(ctx, r);
      if (this.showScans) for (const r of world.robots) if (r.alive) this.drawScan(ctx, r, world.tick);
      for (const p of world.projectiles) this.drawProjectile(ctx, p, ticks > 0);
      for (const r of world.robots) if (r.alive) this.drawRobot(ctx, r, r.entryId === selectedEntryId, now);
      this.drawFireLight(ctx, world, now);
      this.emitAmbientSmoke(world);
      this.drawParticles(ctx);
      for (const r of world.robots) if (r.alive) this.drawLabel(ctx, r, now);
      if (world.mission) for (const l of world.mission.labels) this.drawNote(ctx, l.x, l.y, l.text);
      const selected = world.robots.find((r) => r.alive && r.entryId === selectedEntryId);
      if (selected && !world.over) this.drawIntent(ctx, selected, paused);

      if (world.over) {
        if (world.mission && world.mission.result) this.drawMissionCard(ctx, world, now);
        else this.drawBanner(ctx, world, now);
      }
      for (const f of this.robotFx.values()) { if (f.flash > 0) f.flash--; if (f.muzzle > 0) f.muzzle--; }
    }

    // ------------------------------------------------------------ static layer

    renderFloor(world) {
      const c = document.createElement('canvas');
      c.width = this.canvas.width;
      c.height = this.canvas.height;
      const g = c.getContext('2d');
      g.setTransform(this.scale, 0, 0, this.scale, 0, 0);
      const W = C.ARENA_W, H = C.ARENA_H;

      T.drawGround(g, world, W, H);

      // vignette: darker toward the edges so the centre reads as the stage
      const v = g.createRadialGradient(W / 2, H / 2, H * 0.25, W / 2, H / 2, W * 0.62);
      v.addColorStop(0, 'rgba(0,0,0,0)');
      v.addColorStop(1, 'rgba(0,0,0,0.46)');
      g.fillStyle = v;
      g.fillRect(0, 0, W, H);
      const haze = g.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.7);
      haze.addColorStop(0, 'rgba(0,0,0,0)');
      haze.addColorStop(1, 'rgba(90,30,10,0.07)');
      g.fillStyle = haze;
      g.fillRect(0, 0, W, H);

      if (world) for (const m of world.mud) T.drawMud(g, m);
      this.fires = [];
      if (world) for (const o of world.obstacles) T.drawObstacle(g, o, this.fires);

      // border: weathered steel rim with a dull inner glow
      g.strokeStyle = 'rgba(170,150,120,0.07)';
      g.lineWidth = 10;
      g.strokeRect(7, 7, W - 14, H - 14);
      g.strokeStyle = '#4c4f50';
      g.lineWidth = 4;
      g.strokeRect(2, 2, W - 4, H - 4);
      g.strokeStyle = '#7a7568';
      g.lineWidth = 1;
      g.strokeRect(4.5, 4.5, W - 9, H - 9);
      return c;
    }

    // ------------------------------------------------------------ robots

    drawScan(ctx, r, tick) {
      const s = r.lastScanFx;
      if (!s || tick - s.tick > 1) return;
      const reach = s.range;
      const grad = ctx.createRadialGradient(r.x, r.y, C.ROBOT_RADIUS, r.x, r.y, reach);
      grad.addColorStop(0, hexA(r.color, s.found ? 0.24 : 0.12));
      grad.addColorStop(1, hexA(r.color, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(r.x, r.y);
      ctx.arc(r.x, r.y, reach, (s.angle - s.width / 2) * DEG, (s.angle + s.width / 2) * DEG);
      ctx.closePath();
      ctx.fill();
    }

    drawRobot(ctx, r, selected, now) {
      const R = C.ROBOT_RADIUS;
      const f = this.fx(r.id);
      const hp = r.health / C.MAX_HEALTH;
      const dim = r.vm.halted && !r.vm.fault;

      if (selected) {
        ctx.save();
        ctx.translate(r.x, r.y);
        ctx.rotate(now / 1500);
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.setLineDash([5, 5]);
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(0, 0, R + 8, 0, TAU); ctx.stroke();
        ctx.restore();
      }

      ctx.save();
      if (dim) ctx.globalAlpha = 0.5;
      ctx.translate(r.x, r.y);

      // ground shadow
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath(); ctx.ellipse(2, 3, R + 1, R - 2, 0, 0, TAU); ctx.fill();

      ctx.rotate(r.heading * DEG);

      // motion streaks behind the direction of travel
      if (Math.abs(r.speed) > 1.5) {
        const dir = Math.sign(r.speed);
        const x0 = -dir * (R - 1), x1 = -dir * (R - 1 + Math.abs(r.speed) * 2.5);
        const g = ctx.createLinearGradient(x0, 0, x1, 0);
        g.addColorStop(0, hexA(r.color, 0.3));
        g.addColorStop(1, hexA(r.color, 0));
        ctx.strokeStyle = g;
        ctx.lineWidth = TREAD.outer - TREAD.inner - 1;
        ctx.beginPath();
        for (const y of [-11, 11]) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
        ctx.stroke();
      }

      // treads, with tread marks that scroll as the robot drives
      this.drawDrive(ctx, r);
      this.drawDriveMud(ctx, r, f);

      // hull
      const grad = ctx.createLinearGradient(0, HULL.y, 0, HULL.y + HULL.h);
      const paint = weathered(r.color);
      grad.addColorStop(0, shade(paint, 0.22));
      grad.addColorStop(1, shade(paint, -0.28));
      ctx.fillStyle = grad;
      this.hullPath(ctx, r);
      ctx.fill();
      this.drawWear(ctx, r, f);
      ctx.strokeStyle = '#0b0d12';
      ctx.lineWidth = 1.5;
      this.hullPath(ctx, r);
      ctx.stroke();

      // Headlights mark the front for every hull shape.
      ctx.fillStyle = '#fff7d1';
      const shape = r.appearance ? r.appearance.shape : 'tank';
      const lightX = shape === 'tank' ? 9 : shape === 'wedge' ? 6 : 8;
      const lightY = shape === 'tank' ? [-7, 4] : shape === 'wedge' ? [-2.5, 1] : [-5, 2];
      for (const y of lightY) ctx.fillRect(lightX, y, 2, shape === 'wedge' ? 1.5 : 3);

      // battle damage
      if (hp < 0.5) {
        ctx.save();
        this.hullPath(ctx, r);
        ctx.clip();
        ctx.fillStyle = 'rgba(15,10,8,0.55)';
        const n = hp < 0.25 ? 3 : 2;
        for (let i = 0; i < n; i++) {
          const a = (r.id * 2.3 + i * 2.1), d = 4 + (i * 3) % 6;
          ctx.beginPath(); ctx.ellipse(Math.cos(a) * d - 2, Math.sin(a) * d * 0.7, 3.5, 2.5, a, 0, TAU); ctx.fill();
        }
        ctx.restore();
      }

      // hit flash
      if (f.flash > 0) {
        ctx.fillStyle = `rgba(255,255,255,${(f.flash / 6) * 0.75})`;
        this.hullPath(ctx, r);
        ctx.fill();
      }

      // turret: light barrel and dome, independent of the hull
      ctx.rotate((r.turret - r.heading) * DEG);
      if (f.muzzle > 0) {
        const s = 4 + f.muzzle * 2;
        ctx.fillStyle = `rgba(255,236,170,${f.muzzle / 4})`;
        ctx.beginPath();
        ctx.moveTo(R + 5, 0);
        ctx.lineTo(R + 7 + s, -s * 0.55); ctx.lineTo(R + 9 + s * 1.4, 0); ctx.lineTo(R + 7 + s, s * 0.55);
        ctx.closePath(); ctx.fill();
      }
      this.drawBarrels(ctx, r);
      const dome = ctx.createRadialGradient(-1.5, -1.5, 0.5, 0, 0, 6.5);
      dome.addColorStop(0, shade(r.color, 0.7));
      dome.addColorStop(1, shade(r.color, 0.15));
      ctx.fillStyle = dome;
      ctx.beginPath(); ctx.arc(0, 0, 6, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.fillStyle = 'rgba(11,13,18,0.55)'; // hatch
      ctx.beginPath(); ctx.arc(-1, 0, 1.8, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(30,25,20,0.45)'; // scuff
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.arc(0, 0, 4.2, 0.6 + (r.id % 3), 1.5 + (r.id % 3)); ctx.stroke();

      ctx.restore();
    }

    hullPath(ctx, r) {
      const shape = r.appearance ? r.appearance.shape : 'tank';
      if (shape === 'circle') {
        ctx.beginPath(); ctx.arc(0, 0, 12, 0, TAU);
      } else if (shape === 'hexagon' || shape === 'wedge') {
        const points = shape === 'hexagon'
          ? [[12, 0], [6, 11], [-6, 11], [-12, 0], [-6, -11], [6, -11]]
          : [[14, 0], [-9, 11], [-13, 7], [-13, -7], [-9, -11]];
        ctx.beginPath();
        points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
        ctx.closePath();
      } else roundRect(ctx, HULL.x, HULL.y, HULL.w, HULL.h, HULL.r);
    }

    /**
     * Weathering on the hull, seeded from the robot's name so each robot
     * keeps the same scratches and chips: rear grime, panel seams, rivets,
     * scratches, chipped paint, a rust streak and any mud it picked up.
     */
    drawWear(ctx, r, f) {
      const rnd = BB.geo.makeRng(nameSeed(r.name));
      ctx.save();
      this.hullPath(ctx, r);
      ctx.clip();
      const grime = ctx.createLinearGradient(-14, 0, 4, 0);
      grime.addColorStop(0, 'rgba(35,26,16,0.45)');
      grime.addColorStop(1, 'rgba(35,26,16,0)');
      ctx.fillStyle = grime;
      ctx.fillRect(-15, -15, 30, 30);
      // Panel seams with rivets.
      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(-4, -12); ctx.lineTo(-4, 12); ctx.moveTo(-4, 0); ctx.lineTo(-13, 0); ctx.stroke();
      for (const [x, y] of [[-6, -6], [-6, 6], [-10, -3], [-10, 3]]) {
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.beginPath(); ctx.arc(x, y, 0.7, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.beginPath(); ctx.arc(x - 0.3, y - 0.3, 0.35, 0, TAU); ctx.fill();
      }
      // Rust streak running back from one rivet.
      const ry = rnd() < 0.5 ? -6 : 6;
      const rust = ctx.createLinearGradient(-6, 0, -13, 0);
      rust.addColorStop(0, 'rgba(130,65,25,0.45)');
      rust.addColorStop(1, 'rgba(130,65,25,0)');
      ctx.fillStyle = rust;
      ctx.fillRect(-13, ry - 0.8, 7, 1.6);
      // Scratches.
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      for (let i = 0; i < 4; i++) {
        const x = -10 + rnd() * 20, y = -9 + rnd() * 18, a = rnd() * Math.PI, len = 2.5 + rnd() * 4;
        ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
      }
      ctx.stroke();
      // Chipped paint showing bare metal.
      for (let i = 0; i < 4; i++) {
        const x = -11 + rnd() * 22, y = -10 + rnd() * 20, rad = 0.7 + rnd() * 0.9;
        ctx.fillStyle = 'rgba(70,72,78,0.7)';
        ctx.beginPath(); ctx.ellipse(x, y, rad * 1.3, rad, rnd() * Math.PI, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(200,200,205,0.25)';
        ctx.beginPath(); ctx.arc(x - rad * 0.4, y - rad * 0.4, rad * 0.4, 0, TAU); ctx.fill();
      }
      // Dents and scorches where shots struck.
      for (const d of f.dents || []) {
        ctx.fillStyle = 'rgba(10,8,6,0.2)'; // scorch fading outward
        ctx.beginPath(); ctx.arc(d.x, d.y, d.r * 2.4, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.arc(d.x, d.y, d.r * 1.6, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(20,18,16,0.85)';
        ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, TAU); ctx.fill();
        ctx.strokeStyle = 'rgba(220,220,225,0.35)'; // lit lip of the dent
        ctx.lineWidth = 0.6;
        ctx.beginPath(); ctx.arc(d.x, d.y, d.r, Math.PI * 0.9, Math.PI * 1.6); ctx.stroke();
        ctx.strokeStyle = 'rgba(0,0,0,0.45)'; // hairline cracks
        ctx.beginPath();
        for (let k = 0; k < 3; k++) {
          const a = d.a + k * 2.1;
          ctx.moveTo(d.x + Math.cos(a) * d.r, d.y + Math.sin(a) * d.r);
          ctx.lineTo(d.x + Math.cos(a) * d.r * 2.1, d.y + Math.sin(a) * d.r * 2.1);
        }
        ctx.stroke();
      }
      // Mud splatter, mostly low on the hull and towards the back.
      if (f.mud > 0.03) {
        ctx.fillStyle = 'rgba(84,64,42,' + (0.6 * Math.min(1, f.mud * 1.5)).toFixed(3) + ')';
        const n = Math.ceil(9 * f.mud);
        for (let i = 0; i < 9; i++) {
          const x = -13 + rnd() * 18, y = (rnd() < 0.5 ? -1 : 1) * (6 + rnd() * 6), rad = 0.8 + rnd() * 1.8;
          if (i >= n) continue;
          ctx.beginPath(); ctx.arc(x, y, rad, 0, TAU); ctx.fill();
        }
      }
      ctx.restore();
    }

    /** Mud caked on the treads or wheels after driving through mud. */
    drawDriveMud(ctx, r, f) {
      if (!(f.mud > 0.03) || (r.appearance && r.appearance.drive === 'hover')) return;
      const rnd = BB.geo.makeRng(nameSeed(r.name) ^ 0x5EED);
      ctx.fillStyle = 'rgba(80,60,38,' + (0.85 * Math.min(1, f.mud * 1.5)).toFixed(3) + ')';
      const n = Math.ceil(16 * f.mud);
      for (let i = 0; i < 16; i++) {
        const side = i % 2 ? 1 : -1;
        const x = TREAD.x + rnd() * TREAD.len, y = side * (TREAD.inner + rnd() * (TREAD.outer - TREAD.inner)), rad = 0.9 + rnd() * 1.6;
        if (i >= n) continue;
        ctx.beginPath(); ctx.arc(x, y, rad, 0, TAU); ctx.fill();
      }
    }

    drawDrive(ctx, r, wreck = false) {
      const drive = r.appearance ? r.appearance.drive : 'tracks';
      if (drive === 'hover') {
        ctx.fillStyle = wreck ? '#16191f' : hexA(r.color, 0.2);
        ctx.strokeStyle = wreck ? '#3a414e' : hexA(r.color, 0.65);
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(0, 0, 15, 12, 0, 0, TAU); ctx.fill(); ctx.stroke();
        return;
      }
      if (drive === 'wheels') {
        for (const x of [-8, 8]) for (const y of [-12, 12]) {
          ctx.fillStyle = wreck ? '#16191f' : '#1a1e26';
          roundRect(ctx, x - 3, y - 2.5, 6, 5, 1.5); ctx.fill();
          ctx.strokeStyle = '#59677c'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(x, y - 2); ctx.lineTo(x, y + 2); ctx.stroke();
        }
        return;
      }
      const odo = r.x * Math.cos(r.heading * DEG) + r.y * Math.sin(r.heading * DEG);
      const phase = ((odo % 5) + 5) % 5;
      for (const side of [-1, 1]) {
        const y0 = side < 0 ? -TREAD.outer : TREAD.inner;
        ctx.fillStyle = wreck ? '#16191f' : '#1a1e26';
        roundRect(ctx, TREAD.x, y0, TREAD.len, TREAD.outer - TREAD.inner, 2.5);
        ctx.fill();
        ctx.strokeStyle = '#3a414e';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = TREAD.x + 2 - phase + 5; x < TREAD.x + TREAD.len - 1; x += 5) {
          ctx.moveTo(x, y0 + 1); ctx.lineTo(x, y0 + TREAD.outer - TREAD.inner - 1);
        }
        ctx.stroke();
      }

    }

    drawBarrels(ctx, r, wreck = false) {
      const turret = r.appearance ? r.appearance.turret : 'standard';
      const end = turret === 'short' ? 13 : C.ROBOT_RADIUS + 5;
      const width = turret === 'twin' ? 3 : 4;
      ctx.strokeStyle = '#0b0d12'; ctx.lineWidth = 1.2;
      for (const y of turret === 'twin' ? [-3.5, 3.5] : [0]) {
        ctx.fillStyle = wreck ? '#3a3f49' : '#cdd4df';
        roundRect(ctx, 2, y - width / 2, end - 2, width, 1.5);
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = wreck ? '#3a3f49' : '#8e97a6';
        ctx.fillRect(end - 4, y - width / 2 - 0.5, 4, width + 1);
        if (!wreck) { ctx.fillStyle = 'rgba(20,15,10,0.6)'; ctx.fillRect(end - 2.5, y - width / 2 - 0.5, 2.5, width + 1); }
      }
    }

    drawLabel(ctx, r, now) {
      const R = C.ROBOT_RADIUS;
      const hp = Math.max(0, r.health / C.MAX_HEALTH);
      // Label above the robot, or below it when hugging the top wall.
      const above = r.y - R - 15 >= 18;
      const w = 40, bx = r.x - w / 2, by = above ? r.y - R - 15 : r.y + R + 8;
      const ty = above ? by - 4 : by + 16;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      roundRect(ctx, bx - 1, by - 1, w + 2, 6, 2);
      ctx.fill();
      ctx.fillStyle = hp > 0.5 ? '#66d17a' : hp > 0.25 ? '#ffc94d' : '#ff5a5a';
      if (hp > 0) { roundRect(ctx, bx, by, w * hp, 4, 1.5); ctx.fill(); }

      let label = r.team === null ? r.name : `${BB.World.TEAM_NAMES[r.team]} · ${r.name}`;
      if (r.vm.fault) label += Math.floor(now / 400) % 2 ? '  ⚠' : '   ';
      else if (r.vm.halted) label += ' (halted)';
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(10,12,18,0.85)';
      ctx.strokeText(label, r.x, ty);
      ctx.fillStyle = r.vm.fault ? '#ffd27f' : '#eef1f6';
      ctx.fillText(label, r.x, ty);
    }

    drawWreck(ctx, r, label = true) {
      ctx.save();
      ctx.translate(r.x, r.y);
      // scorch mark on the floor
      const s = ctx.createRadialGradient(0, 0, 4, 0, 0, 34);
      s.addColorStop(0, 'rgba(0,0,0,0.6)');
      s.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = s;
      ctx.beginPath(); ctx.arc(0, 0, 34, 0, TAU); ctx.fill();

      ctx.rotate(r.heading * DEG);
      ctx.fillStyle = '#16191f';
      this.drawDrive(ctx, r, true);
      ctx.fillStyle = '#2a2e36';
      this.hullPath(ctx, r);
      ctx.fill();
      ctx.strokeStyle = '#0b0d12';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = hexA(r.color, 0.35);         // a hint of the old paint
      ctx.fillRect(HULL.x + 3, HULL.y + 3, 6, 4);
      ctx.rotate((r.turret - r.heading + 35) * DEG); // turret knocked askew
      ctx.fillStyle = '#3a3f49';
      this.drawBarrels(ctx, r, true);
      ctx.beginPath(); ctx.arc(0, 0, 6.5, 0, TAU); ctx.fill();
      ctx.restore();

      if (!label) return;
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#6b7385';
      ctx.fillText(r.name, r.x, r.y - C.ROBOT_RADIUS - 8);
    }

    /** Flickering flames on burning trees, with rising sparks and smoke. */
    drawFires(ctx, now) {
      const fires = (this.fires || []).concat(this.ignited);
      if (!fires.length) return;
      const t = now / 1000;
      const tongue = (x, y, s) => {
        ctx.beginPath();
        ctx.moveTo(x, y - s * 1.7);
        ctx.quadraticCurveTo(x + s, y - s * 0.2, x, y + s * 0.6);
        ctx.quadraticCurveTo(x - s, y - s * 0.2, x, y - s * 1.7);
        ctx.fill();
      };
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const f of fires) {
        const flick = T.fireFlicker(f, now);
        const reach = Math.max(14, f.r) * 2 * flick;
        const glow = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, reach);
        glow.addColorStop(0, 'rgba(255,120,30,0.3)');
        glow.addColorStop(1, 'rgba(255,60,10,0)');
        ctx.fillStyle = glow;
        ctx.beginPath(); ctx.arc(f.x, f.y, reach, 0, TAU); ctx.fill();
        for (let k = 0; k < 5; k++) {
          const a = f.phase + k * TAU / 5 + t * 0.3;
          const d = f.r * (0.2 + 0.18 * Math.sin(k * 2.3 + f.phase));
          const x = f.x + Math.cos(a) * d, y = f.y + Math.sin(a) * d;
          const s = Math.max(4, f.r * 0.42) * (0.7 + 0.3 * Math.sin(t * 11 + k * 1.7 + f.phase)) * flick;
          ctx.fillStyle = 'rgba(255,80,20,0.55)';
          tongue(x, y, s);
          ctx.fillStyle = 'rgba(255,180,60,0.6)';
          tongue(x, y + s * 0.15, s * 0.6);
          ctx.fillStyle = 'rgba(255,240,190,0.7)';
          tongue(x, y + s * 0.25, s * 0.28);
        }
      }
      ctx.restore();
      if (this.particles.length >= MAX_PARTICLES) return;
      for (const f of fires) {
        if (Math.random() < 0.05) this.smoke(f.x, f.y - f.r * 0.4, 0.3);
        if (Math.random() < 0.06) {
          this.particles.push({
            kind: 'ember', x: f.x + (Math.random() - 0.5) * f.r, y: f.y - f.r * 0.3,
            vx: (Math.random() - 0.5) * 0.3, vy: -0.4 - Math.random() * 0.4,
            life: 45, max: 45, color: Math.random() < 0.5 ? '#ffb347' : '#ff7a2f', size: 1.1,
          });
        }
      }
    }

    /** Lay mud tracks and throw droplets for robots driving through mud. */
    updateMud(world) {
      for (const r of world.robots) {
        const f = this.fx(r.id);
        // Capped so a respawn or teleport never counts as a huge move.
        const moved = f.px === undefined ? 0 : Math.min(6, Math.hypot(r.x - f.px, r.y - f.py));
        f.px = r.x; f.py = r.y;
        f.mud = (f.mud || 0) * 0.9985;
        if (!r.alive || !world.inMud(r)) { f.trackX = undefined; continue; }
        f.mud = Math.min(1, f.mud + moved * 0.015);
        if (f.trackX === undefined) { f.trackX = r.x; f.trackY = r.y; }
        if (Math.hypot(r.x - f.trackX, r.y - f.trackY) >= 3) {
          this.tracks.push({ x1: f.trackX, y1: f.trackY, x2: r.x, y2: r.y, heading: r.heading,
            drive: r.appearance ? r.appearance.drive : 'tracks', tick: world.tick });
          if (this.tracks.length > MAX_TRACKS) this.tracks.shift();
          f.trackX = r.x; f.trackY = r.y;
        }
        // Droplets flick off the back of the treads while actually moving.
        if (moved < 0.05 || this.particles.length >= MAX_PARTICLES) continue;
        const dx = Math.cos(r.heading * DEG), dy = Math.sin(r.heading * DEG), back = r.speed >= 0 ? -1 : 1;
        for (let i = 0, n = Math.random() < Math.min(0.9, moved * 0.4) ? 1 + (Math.random() < 0.3 ? 1 : 0) : 0; i < n; i++) {
          const side = Math.random() < 0.5 ? -1 : 1;
          const sx = r.x + back * dx * 12 - side * dy * 11, sy = r.y + back * dy * 12 + side * dx * 11;
          const v = 0.6 + Math.random();
          this.particles.push({
            kind: 'drop', x: sx, y: sy,
            vx: back * dx * v - side * dy * (0.3 + Math.random() * 0.7), vy: back * dy * v + side * dx * (0.3 + Math.random() * 0.7),
            life: 16 + Math.random() * 8, max: 24, size: 1 + Math.random() * 1.3,
            color: ['#5a4430', '#3e2e1f', '#6e5638'][Math.floor(Math.random() * 3)],
          });
        }
      }
    }

    /** Fading tread marks, ruts or hover wakes left in mud. */
    drawTracks(ctx, tick) {
      if (!this.tracks.length) return;
      this.tracks = this.tracks.filter((t) => tick - t.tick < TRACK_LIFE && tick >= t.tick);
      ctx.save();
      ctx.lineCap = 'round';
      for (const t of this.tracks) {
        const a = 1 - (tick - t.tick) / TRACK_LIFE;
        const nx = -Math.sin(t.heading * DEG), ny = Math.cos(t.heading * DEG);
        const line = (off, width, color) => {
          ctx.strokeStyle = color;
          ctx.lineWidth = width;
          ctx.beginPath();
          ctx.moveTo(t.x1 + nx * off, t.y1 + ny * off);
          ctx.lineTo(t.x2 + nx * off, t.y2 + ny * off);
          ctx.stroke();
        };
        if (t.drive === 'hover') {
          line(0, 22, 'rgba(30,22,14,' + (0.22 * a).toFixed(3) + ')');
          continue;
        }
        const off = t.drive === 'wheels' ? 12 : 11, width = t.drive === 'wheels' ? 3.5 : 5;
        for (const side of [-1, 1]) {
          line(side * off, width, 'rgba(22,15,9,' + (0.5 * a).toFixed(3) + ')');
          line(side * off - 1.5, 1, 'rgba(130,105,70,' + (0.18 * a).toFixed(3) + ')'); // lit ridge
        }
      }
      ctx.restore();
    }

    /** Robots and wrecks near burning trees pick up a flickering orange glow on the side facing the fire. */
    drawFireLight(ctx, world, now) {
      const fires = (this.fires || []).concat(this.ignited);
      if (!fires.length) return;
      const R = C.ROBOT_RADIUS;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const r of world.robots) {
        let sum = 0, dx = 0, dy = 0;
        for (const f of fires) {
          const d = Math.hypot(f.x - r.x, f.y - r.y);
          if (d >= FIRE_LIGHT || d < 1e-6) continue;
          const w = (1 - d / FIRE_LIGHT) ** 2 * T.fireFlicker(f, now);
          sum += w; dx += (f.x - r.x) / d * w; dy += (f.y - r.y) / d * w;
        }
        if (sum < 0.02) continue;
        const k = Math.min(1, sum), len = Math.hypot(dx, dy) || 1;
        const lx = r.x + dx / len * R * 0.45, ly = r.y + dy / len * R * 0.45;
        const glow = ctx.createRadialGradient(lx, ly, 0, lx, ly, R * 1.7);
        glow.addColorStop(0, 'rgba(255,135,45,' + (0.55 * k).toFixed(3) + ')');
        glow.addColorStop(0.5, 'rgba(255,110,30,' + (0.22 * k).toFixed(3) + ')');
        glow.addColorStop(1, 'rgba(255,90,20,0)');
        ctx.fillStyle = glow;
        ctx.beginPath(); ctx.arc(lx, ly, R * 1.7, 0, TAU); ctx.fill();
      }
      ctx.restore();
    }

    emitAmbientSmoke(world) {
      for (const r of world.robots) {
        if (r.alive && r.health / C.MAX_HEALTH < 0.25 && Math.random() < 0.35) this.smoke(r.x, r.y);
        else if (!r.alive && Math.random() < 0.08) this.smoke(r.x, r.y, 0.25);
      }
    }

    /** A hot shell with a team-coloured tracer streak, trailing thin smoke while the match runs. */
    drawProjectile(ctx, p, moving = true) {
      const speed = Math.hypot(p.vx, p.vy) || 1;
      const dx = p.vx / speed, dy = p.vy / speed;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const tx = p.x - dx * 24, ty = p.y - dy * 24;
      const streak = ctx.createLinearGradient(tx, ty, p.x, p.y);
      streak.addColorStop(0, hexA(p.color, 0));
      streak.addColorStop(1, hexA(p.color, 0.75));
      ctx.strokeStyle = streak;
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(p.x, p.y); ctx.stroke();
      ctx.fillStyle = 'rgba(255,140,50,0.16)';
      ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(255,180,90,0.28)';
      ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, TAU); ctx.fill();
      ctx.restore();
      // Shell body: orange-hot, white at the nose.
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(Math.atan2(dy, dx));
      ctx.fillStyle = '#ff8a3a';
      ctx.beginPath(); ctx.ellipse(0, 0, 3.5, 1.3, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = '#ffd08a';
      ctx.beginPath(); ctx.ellipse(1, 0, 2.2, 0.95, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = '#fffbe8';
      ctx.beginPath(); ctx.ellipse(2.4, 0, 1, 0.65, 0, 0, TAU); ctx.fill();
      ctx.restore();
      // Thin smoke left behind, only when there is spare particle budget.
      if (moving && this.particles.length < MAX_PARTICLES * 0.7 && Math.random() < 0.55) {
        this.particles.push({
          kind: 'trail', x: p.x - dx * 6, y: p.y - dy * 6,
          vx: (Math.random() - 0.5) * 0.15, vy: (Math.random() - 0.5) * 0.15 - 0.03,
          size: 1.2, life: 34, max: 34,
        });
      }
    }

    drawParticles(ctx) {
      const keep = [];
      for (const p of this.particles) {
        const t = 1 - p.life / p.max; // 0 -> 1 over the particle's life
        switch (p.kind) {
          case 'spark':
            p.x += p.vx; p.y += p.vy; p.vx *= 0.88; p.vy *= 0.88;
            ctx.globalAlpha = 1 - t;
            ctx.fillStyle = p.color;
            ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1 - t * 0.5), 0, TAU); ctx.fill();
            break;
          case 'drop':
            p.x += p.vx; p.y += p.vy; p.vx *= 0.86; p.vy *= 0.86;
            ctx.globalAlpha = Math.min(1, 1.6 * (1 - t));
            ctx.fillStyle = p.color;
            ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, TAU); ctx.fill();
            break;
          case 'trail':
            p.x += p.vx; p.y += p.vy;
            ctx.globalAlpha = 0.22 * (1 - t);
            ctx.fillStyle = '#9aa0a8';
            ctx.beginPath(); ctx.arc(p.x, p.y, p.size + t * 3, 0, TAU); ctx.fill();
            break;
          case 'dust':
            p.x += p.vx; p.y += p.vy; p.vx *= 0.93; p.vy *= 0.93;
            ctx.globalAlpha = 0.4 * (1 - t);
            ctx.fillStyle = p.color;
            ctx.beginPath(); ctx.arc(p.x, p.y, p.size + t * 5, 0, TAU); ctx.fill();
            break;
          case 'chip':
            p.x += p.vx; p.y += p.vy; p.vx *= 0.86; p.vy *= 0.86; p.angle += p.spin;
            ctx.globalAlpha = Math.min(1, 1.5 * (1 - t));
            ctx.fillStyle = p.color;
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.angle);
            ctx.fillRect(-p.size, -p.size * 0.4, p.size * 2, p.size * 0.8);
            ctx.restore();
            break;
          case 'ember':
            p.x += p.vx + Math.sin(p.life * 0.4) * 0.15; p.y += p.vy; p.vy *= 0.985;
            ctx.globalAlpha = 1 - t;
            ctx.fillStyle = p.color;
            ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1 - t * 0.6), 0, TAU); ctx.fill();
            break;
          case 'smoke':
            p.x += p.vx; p.y += p.vy;
            ctx.globalAlpha = 0.45 * (1 - t);
            ctx.fillStyle = '#8b93a1';
            ctx.beginPath(); ctx.arc(p.x, p.y, p.size + t * 9, 0, TAU); ctx.fill();
            break;
          case 'flash': {
            const rad = p.size * (0.6 + t * 0.6);
            const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad);
            g.addColorStop(0, '#ffffff');
            g.addColorStop(0.35, p.color);
            g.addColorStop(0.7, 'rgba(255,120,40,0.55)');
            g.addColorStop(1, 'rgba(255,80,20,0)');
            ctx.globalAlpha = 1 - t * t;
            ctx.fillStyle = g;
            ctx.beginPath(); ctx.arc(p.x, p.y, rad, 0, TAU); ctx.fill();
            break;
          }
          case 'ring':
            ctx.globalAlpha = 0.7 * (1 - t);
            ctx.strokeStyle = p.color;
            ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(p.x, p.y, 8 + p.size * t, 0, TAU); ctx.stroke();
            break;
        }
        if (--p.life > 0) keep.push(p);
      }
      ctx.globalAlpha = 1;
      this.particles = keep;
    }

    /**
     * End-of-match card: the winner (or winning team) rendered large on a
     * spotlit podium, still wearing its dents and mud, with its stats.
     * Fades and scales in over 0.6 s.
     */
    drawBanner(ctx, world, now) {
      if (this.overAt === undefined) this.overAt = now;
      const ease = 1 - (1 - Math.min(1, (now - this.overAt) / 600)) ** 3;
      const W = C.ARENA_W, H = C.ARENA_H;
      const teamWin = world.teamMode && world.winnerTeam !== null;
      const heroes = teamWin ? world.robots.filter((r) => r.team === world.winnerTeam).slice(0, 3)
        : world.winner ? [world.winner] : [];
      const color = teamWin ? BB.World.TEAM_COLORS[world.winnerTeam][0] : world.winner ? world.winner.color : '#c9d0dc';
      const reason = world.endReason ? world.endReason[0].toUpperCase() + world.endReason.slice(1) : '';

      ctx.save();
      // "Time limit reached, highest total health wins" needs two lines in the winner's column; the card grows to fit.
      const pw = 480, maxW = pw - 270;
      ctx.font = '13px system-ui, sans-serif';
      const why = heroes.length ? wrapText(ctx, reason, maxW, 2) : [reason], below = (why.length - 1) * 16;
      const ph = 270 + below, px = (W - pw) / 2, py = (H - ph) / 2 + (1 - ease) * 20;
      ctx.globalAlpha = ease;
      ctx.fillStyle = 'rgba(6,7,10,0.62)';
      ctx.fillRect(0, 0, W, H);
      ctx.shadowColor = hexA(color, 0.45);
      ctx.shadowBlur = 24;
      ctx.fillStyle = 'rgba(16,19,26,0.94)';
      roundRect(ctx, px, py, pw, ph, 12);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = hexA(color, 0.7);
      ctx.lineWidth = 1.5;
      ctx.stroke();

      if (!heroes.length) {
        ctx.textAlign = 'center';
        ctx.fillStyle = color;
        ctx.font = '700 40px system-ui, sans-serif';
        ctx.fillText('DRAW', W / 2, py + 120);
        ctx.fillStyle = '#aab2c2';
        ctx.font = '14px system-ui, sans-serif';
        ctx.fillText(reason, W / 2, py + 148);
      } else {
        const hx = px + 125, hy = py + 135;
        // Spotlit podium with embers drifting up around the winner.
        const spot = ctx.createRadialGradient(hx, hy + 32, 4, hx, hy + 32, 110);
        spot.addColorStop(0, hexA(color, 0.3));
        spot.addColorStop(1, hexA(color, 0));
        ctx.fillStyle = spot;
        ctx.beginPath(); ctx.ellipse(hx, hy + 32, 110, 46, 0, 0, TAU); ctx.fill();
        ctx.save();
        roundRect(ctx, px, py, pw, ph, 12);
        ctx.clip();
        for (let i = 0; i < 16; i++) {
          const rise = (now / 1000 * 0.35 + i * 0.137) % 1;
          ctx.globalAlpha = ease * (1 - rise) * 0.8;
          ctx.fillStyle = i % 3 ? '#ffb347' : '#ff7a2f';
          ctx.beginPath();
          ctx.arc(hx + Math.sin(i * 12.9898) * 85 + Math.sin(now / 700 + i) * 4, hy + 60 - rise * 170, 1.2 + (i % 2) * 0.6, 0, TAU);
          ctx.fill();
        }
        ctx.restore();
        ctx.globalAlpha = ease;
        // The robots themselves, posed with a slowly sweeping turret. Fallen teammates show as wrecks.
        const slots = heroes.length === 1 ? [[0, 0, 3.6]]
          : heroes.length === 2 ? [[-48, 0, 2.4], [48, 0, 2.4]]
          : [[-55, -28, 2.1], [55, -28, 2.1], [0, 40, 2.1]];
        heroes.forEach((r, i) => {
          const [ox, oy, scale] = slots[i];
          const pose = Object.create(r);
          Object.assign(pose, { x: 0, y: 0, heading: -20, turret: -20 + Math.sin(now / 900 + i * 1.7) * 25, speed: 0, vm: { halted: false, fault: null } });
          ctx.save();
          ctx.translate(hx + ox, hy + oy);
          ctx.scale(scale * (0.85 + 0.15 * ease), scale * (0.85 + 0.15 * ease));
          if (r.alive) this.drawRobot(ctx, pose, false, now); else this.drawWreck(ctx, pose, false);
          ctx.restore();
        });

        const tx = px + 250;
        ctx.textAlign = 'left';
        ctx.fillStyle = hexA(color, 0.9);
        ctx.font = '700 12px system-ui, sans-serif';
        ctx.fillText('V I C T O R Y', tx, py + 48);
        ctx.fillStyle = color;
        ctx.font = '700 28px system-ui, sans-serif';
        ctx.fillText(fitText(ctx, teamWin ? `Team ${BB.World.TEAM_NAMES[world.winnerTeam]}` : heroes[0].name, maxW), tx, py + 82);
        ctx.fillStyle = '#aab2c2';
        ctx.font = '13px system-ui, sans-serif';
        why.forEach((line, i) => ctx.fillText(line, tx, py + 102 + i * 16));
        if (teamWin) this.drawTeamLines(ctx, heroes, tx, py + 132 + below, maxW);
        else this.drawWinnerStats(ctx, heroes[0], tx, py + 124 + below);
      }
      ctx.textAlign = 'center';
      ctx.fillStyle = '#7d8696';
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText(`tick ${world.tick} · press Rematch to play again`, W / 2, py + ph - 16);
      ctx.restore();
    }

    /** A small mission note on the arena, such as a target's coordinates, centred on (x, y). */
    drawNote(ctx, x, y, text) {
      ctx.save();
      ctx.font = '600 11px system-ui, sans-serif';
      const w = ctx.measureText(text).width + 10;
      const bx = Math.max(4, Math.min(C.ARENA_W - w - 4, x - w / 2)), by = Math.max(4, Math.min(C.ARENA_H - 20, y - 9));
      ctx.fillStyle = 'rgba(10,12,18,0.75)';
      roundRect(ctx, bx, by, w, 17, 4); ctx.fill();
      ctx.fillStyle = '#b8f0c0';
      ctx.textAlign = 'center';
      ctx.fillText(text, bx + w / 2, by + 12.5);
      ctx.restore();
    }

    /** A mission's goal zone: a softly pulsing green pad, with an optional `label` under GOAL. */
    drawZone(ctx, z, now, label) {
      const pulse = 0.5 + 0.5 * Math.sin(now / 400);
      ctx.save();
      ctx.fillStyle = `rgba(102,209,122,${(0.1 + 0.06 * pulse).toFixed(3)})`;
      ctx.fillRect(z.x, z.y, z.w, z.h);
      ctx.strokeStyle = `rgba(140,230,150,${(0.5 + 0.4 * pulse).toFixed(3)})`;
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 6]);
      ctx.strokeRect(z.x, z.y, z.w, z.h);
      ctx.setLineDash([]);
      ctx.fillStyle = '#b8f0c0';
      ctx.font = '700 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('GOAL', z.x + z.w / 2, z.y + z.h / 2 + (label ? -2 : 5));
      if (label) {
        ctx.font = '11px system-ui, sans-serif';
        ctx.fillStyle = 'rgba(184,240,192,0.85)';
        ctx.fillText(label, z.x + z.w / 2, z.y + z.h / 2 + 14);
      }
      ctx.restore();
    }

    /**
     * What the selected robot has been told to do, so commands have a visible
     * effect: an arc to the heading it is turning toward and a dotted line
     * where the turret is turning. While paused, labels spell it out.
     */
    drawIntent(ctx, r, paused) {
      const R = C.ROBOT_RADIUS;
      const turnBy = BB.geo.angleDiff(r.targetHeading, r.heading);
      const aimBy = BB.geo.angleDiff(r.targetTurret, r.turret);
      ctx.save();
      ctx.translate(r.x, r.y);
      // Light blue, outside the white selection ring, so the two never blur together.
      ctx.strokeStyle = ctx.fillStyle = 'rgba(127,211,255,0.95)';
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      if (Math.abs(turnBy) > 0.5) {
        const a0 = r.heading * DEG, a1 = r.targetHeading * DEG, rad = R + 17;
        ctx.beginPath(); ctx.arc(0, 0, rad, a0, a0 + turnBy * DEG, turnBy < 0); ctx.stroke();
        const tx = Math.cos(a1) * rad, ty = Math.sin(a1) * rad, s = Math.sign(turnBy);
        const bx = Math.cos(a1 + s * Math.PI / 2), by = Math.sin(a1 + s * Math.PI / 2);
        ctx.beginPath(); // arrowhead pointing along the turn
        ctx.moveTo(tx + bx * 3, ty + by * 3);
        ctx.lineTo(tx - bx * 7 + Math.cos(a1) * 5, ty - by * 7 + Math.sin(a1) * 5);
        ctx.lineTo(tx - bx * 7 - Math.cos(a1) * 5, ty - by * 7 - Math.sin(a1) * 5);
        ctx.closePath(); ctx.fill();
      }
      if (Math.abs(aimBy) > 0.5) {
        const a = r.targetTurret * DEG;
        ctx.strokeStyle = 'rgba(255,214,120,0.85)';
        ctx.setLineDash([2, 4]);
        ctx.beginPath(); ctx.moveTo(Math.cos(a) * R, Math.sin(a) * R); ctx.lineTo(Math.cos(a) * (R + 60), Math.sin(a) * (R + 60)); ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
      if (!paused) return;
      const lines = [];
      if (Math.abs(r.targetSpeed - r.speed) > 0.01) lines.push(`speed ${round1(r.speed)} → ${round1(r.targetSpeed)}`);
      else if (r.speed) lines.push(`speed ${round1(r.speed)}`);
      if (Math.abs(turnBy) > 0.5) lines.push(`turning to ${Math.round(r.targetHeading) % 360}°`);
      if (Math.abs(aimBy) > 0.5) lines.push(`aiming at ${Math.round(r.targetTurret) % 360}°`);
      if (!lines.length) return;
      ctx.save();
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'left';
      const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 10, h = lines.length * 14 + 6;
      // Beside the robot, flipped to the left near the right wall, kept inside the arena.
      const bx = r.x + R + 14 + w > C.ARENA_W ? r.x - R - 14 - w : r.x + R + 14;
      const by = Math.max(4, Math.min(C.ARENA_H - h - 4, r.y - h / 2));
      ctx.fillStyle = 'rgba(10,12,18,0.78)';
      roundRect(ctx, bx, by, w, h, 4); ctx.fill();
      ctx.fillStyle = '#e8ecf3';
      lines.forEach((l, i) => ctx.fillText(l, bx + 5, by + 15 + i * 14));
      ctx.restore();
    }

    /**
     * End of a mission: a green "complete" or amber "not yet" card with the reason.
     * The reason is the feedback that says what to change, so it wraps onto more
     * lines (smaller if need be) instead of being cut short.
     */
    drawMissionCard(ctx, world, now) {
      if (this.overAt === undefined) this.overAt = now;
      const ease = 1 - (1 - Math.min(1, (now - this.overAt) / 500)) ** 3;
      const { ok, text } = world.mission.result;
      const W = C.ARENA_W, H = C.ARENA_H, color = ok ? '#66d17a' : '#ffc94d';
      const pw = 460, maxW = pw - 48, message = ok ? `✓ ${text}` : text;
      // The largest size that fits on two lines, else on three, else the smallest.
      const layouts = [24, 20, 17].map((s) => {
        ctx.font = `700 ${s}px system-ui, sans-serif`;
        return { size: s, lines: wrapText(ctx, message, maxW, 4) };
      });
      const { size, lines } = layouts.find((l) => l.lines.length <= 2) || layouts.find((l) => l.lines.length <= 3) || layouts[2];
      const lh = Math.round(size * 1.3);
      const ph = Math.max(160, 120 + size + (lines.length - 1) * lh);
      const px = (W - pw) / 2, py = (H - ph) / 2 + (1 - ease) * 16;
      const first = py + 46 + size, last = first + (lines.length - 1) * lh; // text baselines
      ctx.save();
      ctx.globalAlpha = ease;
      ctx.fillStyle = 'rgba(6,7,10,0.55)';
      ctx.fillRect(0, 0, W, H);
      ctx.shadowColor = hexA(color, 0.45);
      ctx.shadowBlur = 24;
      ctx.fillStyle = 'rgba(16,19,26,0.95)';
      roundRect(ctx, px, py, pw, ph, 12); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = hexA(color, 0.75);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.fillStyle = color;
      ctx.font = '700 12px system-ui, sans-serif';
      ctx.fillText(ok ? 'M I S S I O N   C O M P L E T E' : 'N O T   Y E T', W / 2, py + 36);
      ctx.font = `700 ${size}px system-ui, sans-serif`;
      lines.forEach((line, i) => ctx.fillText(line, W / 2, first + i * lh));
      ctx.fillStyle = '#9aa4b8';
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillText(ok ? 'Try the next mission, or make this one even better.' : 'Change your code, then press ▶ Try again.', W / 2, last + 32);
      ctx.fillStyle = '#7d8696';
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText(`tick ${world.tick}`, W / 2, py + ph - 18);
      ctx.restore();
    }

    /** Health bar and a 2×2 grid of shots, hits, accuracy and damage dealt. */
    drawWinnerStats(ctx, r, x, y) {
      const hp = Math.max(0, r.health / C.MAX_HEALTH);
      ctx.fillStyle = '#7d8696';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(`Health ${Math.ceil(r.health)} / ${C.MAX_HEALTH}`, x, y);
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      roundRect(ctx, x, y + 6, 190, 6, 3); ctx.fill();
      ctx.fillStyle = hp > 0.5 ? '#66d17a' : hp > 0.25 ? '#ffc94d' : '#ff5a5a';
      if (hp > 0) { roundRect(ctx, x, y + 6, 190 * hp, 6, 3); ctx.fill(); }
      const { shots, hits, damageDealt } = r.stats;
      const cells = [['Shots', shots], ['Hits', hits], ['Accuracy', shots ? `${Math.round(hits / shots * 100)}%` : '–'], ['Damage dealt', damageDealt]];
      cells.forEach(([label, value], i) => {
        const cx = x + (i % 2) * 105, cy = y + 38 + Math.floor(i / 2) * 42;
        ctx.fillStyle = '#7d8696';
        ctx.font = '11px system-ui, sans-serif';
        ctx.fillText(label, cx, cy);
        ctx.fillStyle = '#e8ecf3';
        ctx.font = '600 18px system-ui, sans-serif';
        ctx.fillText(String(value), cx, cy + 20);
      });
    }

    /** One line per team member: name, then health or "destroyed", hits and damage. */
    drawTeamLines(ctx, members, x, y, maxW) {
      members.forEach((r, i) => {
        const ly = y + i * 38;
        ctx.fillStyle = r.color;
        ctx.beginPath(); ctx.arc(x + 5, ly - 4, 4, 0, TAU); ctx.fill();
        ctx.fillStyle = r.alive ? '#e8ecf3' : '#7d8696';
        ctx.font = '600 14px system-ui, sans-serif';
        ctx.fillText(fitText(ctx, r.name, maxW - 16), x + 16, ly);
        ctx.fillStyle = '#7d8696';
        ctx.font = '12px system-ui, sans-serif';
        const status = r.alive ? `HP ${Math.ceil(r.health)}` : 'destroyed';
        ctx.fillText(`${status} · ${r.stats.hits} hits · ${r.stats.damageDealt} damage`, x + 16, ly + 16);
      });
    }
  }

  // ------------------------------------------------------------ helpers

  /** Shorten text with an ellipsis until it fits in maxWidth at the current font. */
  function fitText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
    return t + '…';
  }

  /**
   * Break text into lines that fit maxWidth at the current font, between words.
   * Past maxLines, the rest joins the last line, shortened with an ellipsis.
   */
  function wrapText(ctx, text, maxWidth, maxLines = Infinity) {
    const lines = [];
    for (const word of String(text).split(/\s+/).filter(Boolean)) {
      const line = lines.length ? `${lines[lines.length - 1]} ${word}` : word;
      if (lines.length && ctx.measureText(line).width <= maxWidth) lines[lines.length - 1] = line;
      else lines.push(word);
    }
    if (lines.length > maxLines) lines.splice(maxLines - 1, lines.length, lines.slice(maxLines - 1).join(' '));
    return lines.map((line) => fitText(ctx, line, maxWidth)); // a single overlong word still fits
  }

  const round1 = (v) => Math.round(v * 10) / 10;

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function rgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function hexA(hex, a) {
    const [r, g, b] = rgb(hex);
    return `rgba(${r},${g},${b},${a})`;
  }

  /** Sun-faded paint: the team colour mixed 15% toward dusty grey, as hex. */
  function weathered(hex) {
    const dust = [119, 115, 106];
    return '#' + rgb(hex).map((v, i) => Math.round(v * 0.85 + dust[i] * 0.15).toString(16).padStart(2, '0')).join('');
  }

  /** Stable 32-bit seed from a robot's name, so its wear looks the same every match. */
  function nameSeed(name) {
    let h = 2166136261;
    for (const ch of String(name)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    return h >>> 0;
  }

  /** Lighten (amt > 0) or darken (amt < 0) a hex colour. */
  function shade(hex, amt) {
    const c = rgb(hex).map((v) => Math.round(amt > 0 ? v + (255 - v) * amt : v * (1 + amt)));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  BB.Renderer = Renderer;
})(globalThis.BB = globalThis.BB || {});
