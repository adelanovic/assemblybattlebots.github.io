/*
 * world.js — The arena simulation.
 *
 * One call to step() advances the match by one tick:
 *   1. Every living robot's VM runs for exactly CYCLES_PER_TICK cycles (the
 *      order rotates each tick). Programs only *request* actions here; the
 *      world itself stays frozen, so execution order gives no advantage.
 *   2. Bodies and turrets turn, speeds change, robots move and collide.
 *   3. Requested shots are spawned.
 *   4. Projectiles move and deal damage.
 *   5. Eliminations and the victory condition are checked.
 *
 * The UI never mutates robots directly. It reads world state and drains
 * `events` for visual effects.
 */
(function (BB) {
  'use strict';

  const C = BB.CONFIG;
  const G = BB.geo;

  const COLORS = ['#ff5c5c', '#4fc3f7', '#ffd54f', '#81c784', '#ba68c8', '#ff9f43', '#4dd0e1', '#f06292'];
  // What `.color` calls each of COLORS (see APPEARANCE.color in isa.js).
  const COLOR_NAMES = ['red', 'blue', 'yellow', 'green', 'purple', 'orange', 'cyan', 'pink'];
  const colorName = (hex) => COLOR_NAMES[COLORS.indexOf(hex)] || 'a team color';
  // Team matches: warm colours for team A, cool for team B.
  const TEAM_NAMES = ['A', 'B'];
  const TEAM_COLORS = [
    ['#ff5c5c', '#ff9f43', '#f06292'],
    ['#4fc3f7', '#81c784', '#4dd0e1'],
  ];

  const DEFAULT_OBSTACLES = [
    { x: 360, y: 260, w: 80, h: 80 },
    { x: 150, y: 140, w: 140, h: 20 },
    { x: 510, y: 440, w: 140, h: 20 },
    { x: 600, y: 90, w: 20, h: 120 },
    { x: 180, y: 390, w: 20, h: 120 },
  ];

  /*
   * Arena layouts. 'random' is generated from the match seed, so a seed
   * always reproduces the same map.
   */
  const ARENAS = {
    classic: { label: 'Classic', desc: 'The fixed default layout, with four mud patches.' },
    random: { label: 'Random', desc: 'Symmetric obstacles and mud generated from the seed.' },
    open: { label: 'Open', desc: 'No obstacles or mud.' },
  };

  // Random-map rules. GAP > robot diameter keeps every corridor passable:
  // inflating each obstacle by one robot radius leaves them disjoint and clear
  // of the walls, so the free space a robot can drive through stays connected.
  const GEN = {
    GAP: 44,             // min clearance between obstacles, and to the walls
    THICKNESS: 20,       // bars are this thick (bullets can't skip through)
    MAX_COVERAGE: 0.11,  // max fraction of the arena covered
    ATTEMPTS: 400,
  };

  function generateRandomObstacles(seed) {
    const rng = G.makeRng((seed ^ 0x9E3779B9) >>> 0); // independent of the spawn RNG
    const W = C.ARENA_W, H = C.ARENA_H;
    const between = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
    const rects = [];
    let area = 0;

    const fits = (r) => r.x >= GEN.GAP && r.y >= GEN.GAP &&
      r.x + r.w <= W - GEN.GAP && r.y + r.h <= H - GEN.GAP &&
      rects.every((o) => r.x >= o.x + o.w + GEN.GAP || o.x >= r.x + r.w + GEN.GAP ||
                         r.y >= o.y + o.h + GEN.GAP || o.y >= r.y + r.h + GEN.GAP);
    const add = (r) => { rects.push(r); area += r.w * r.h; };

    // Optional centre piece (its own mirror image).
    if (rng() < 0.5) {
      const s = 2 * between(20, 45); // even, so it centres exactly
      add({ x: (W - s) / 2, y: (H - s) / 2, w: s, h: s });
    }

    // Pairs mirrored through the centre: every obstacle has a twin.
    const pairs = between(2, 4);
    for (let made = 0, tries = 0; made < pairs && tries < GEN.ATTEMPTS; tries++) {
      const kind = rng();
      let w, h;
      if (kind < 0.4) { w = between(80, 180); h = GEN.THICKNESS; }        // horizontal bar
      else if (kind < 0.8) { w = GEN.THICKNESS; h = between(80, 160); }   // vertical bar
      else { w = between(40, 80); h = between(40, 80); }                  // block
      const r = { x: between(0, W - w), y: between(0, H - h), w, h };
      const twin = { x: W - r.x - w, y: H - r.y - h, w, h };
      if ((area + 2 * w * h) / (W * H) > GEN.MAX_COVERAGE) continue;
      if (!fits(r)) continue;
      add(r);
      if (!fits(twin)) { rects.pop(); area -= w * h; continue; } // also rejects twin overlapping r
      add(twin);
      made++;
    }
    return rects;
  }

  function makeObstacles(arena, seed) {
    if (arena === 'open') return [];
    if (arena === 'random') return generateRandomObstacles(seed);
    return DEFAULT_OBSTACLES.map((o) => ({ ...o }));
  }

  /*
   * Mud: drivable patches that cap speed at MUD_MAX_SPEED while a robot's
   * centre is inside. Bullets, SCAN and RADAR pass over it. Patches come in
   * pairs mirrored through the centre, like obstacles, so neither side is favoured.
   */
  const DEFAULT_MUD = [
    { x: 80, y: 250, w: 110, h: 90 },
    { x: 610, y: 260, w: 110, h: 90 },
    { x: 330, y: 40, w: 140, h: 70 },
    { x: 330, y: 490, w: 140, h: 70 },
  ];

  function generateRandomMud(seed, obstacles) {
    // Separate stream: adding mud leaves every seed's obstacle layout unchanged.
    const rng = G.makeRng((seed ^ 0x5BD1E995) >>> 0);
    const W = C.ARENA_W, H = C.ARENA_H, EDGE = 20, GAP = 10;
    const between = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
    const patches = [];
    const clear = (r) => r.x >= EDGE && r.y >= EDGE && r.x + r.w <= W - EDGE && r.y + r.h <= H - EDGE &&
      obstacles.concat(patches).every((o) => r.x >= o.x + o.w + GAP || o.x >= r.x + r.w + GAP ||
                                              r.y >= o.y + o.h + GAP || o.y >= r.y + r.h + GAP);
    const pairs = between(1, 2);
    for (let made = 0, tries = 0; made < pairs && tries < GEN.ATTEMPTS; tries++) {
      const w = between(70, 150), h = between(50, 110);
      const r = { x: between(0, W - w), y: between(0, H - h), w, h };
      const twin = { x: W - r.x - w, y: H - r.y - h, w, h };
      if (!clear(r)) continue;
      patches.push(r);
      if (!clear(twin)) { patches.pop(); continue; } // also rejects twin overlapping r
      patches.push(twin);
      made++;
    }
    return patches;
  }

  function makeMud(arena, seed, obstacles) {
    if (arena === 'open') return [];
    if (arena === 'random') return generateRandomMud(seed, obstacles);
    return DEFAULT_MUD.map((m) => ({ ...m }));
  }

  /** Narrow scan cones reach farther; `width` is already clamped to 1..SCAN_MAX_WIDTH. */
  const scanRange = (width) => Math.floor(C.SCAN_RANGE_FACTOR / Math.sqrt(width));

  const blankScan =() =>({ dist: -1, angle: 0, x: 0, y: 0, heading: 0, speed: 0 });
  const blankThreat = () => ({ dist: -1, angle: 0, heading: 0 });

  class Robot {
    constructor(id, entry, color) {
      this.id = id;
      this.entryId = entry.id;
      this.team = entry.team === 0 || entry.team === 1 ? entry.team : null; // null = free-for-all
      this.name = entry.name;
      this.appearance = Object.fromEntries(Object.entries(BB.ISA.APPEARANCE).map(([key, spec]) =>
        [key, BB.ISA.appearanceAllows(spec, entry.appearance && entry.appearance[key]) ? entry.appearance[key] : spec.default]));
      this.color = color;
      this.x = 0; this.y = 0;
      this.heading = 0; this.targetHeading = 0;
      this.turret = 0; this.targetTurret = 0;
      this.speed = 0; this.targetSpeed = 0;
      this.health = C.MAX_HEALTH;
      this.cooldown = 0;
      this.alive = true;
      this.wantFire = false;
      this.scan = blankScan();
      this.scanRange = 0;       // reach of the last SCAN
      this.threat = blankThreat();
      this.lastHitTick = -1;
      this.lastScanFx = null;   // { tick, angle, width, found } for rendering
      this.cyclesLastTick = 0;
      this.stats = { shots: 0, hits: 0, damageDealt: 0 };
      this.vm = null;
    }
  }

  class World {
    /**
     * @param {object} opts
     *   entries:   [{ id, name, program, team? }] valid compiled robots.
     *              team 0 / 1 puts a robot on team A / B. Teammates don't
     *              see each other on SCAN or RADAR and can't hurt each other.
     *   seed:      integer RNG seed (spawn positions, RAND)
     *   arena:     'classic' | 'random' | 'open'
     *   obstacles: optional explicit array of rects (overrides `arena`)
     *   mud:       optional explicit array of mud rects; defaults to the
     *              arena's mud, or none when `obstacles` is explicit
     */
    constructor({ entries, seed = 1, arena = 'classic', obstacles = null, mud = null }) {
      this.width = C.ARENA_W;
      this.height = C.ARENA_H;
      this.arena = ARENAS[arena] ? arena : 'classic';
      this.obstacles = obstacles ? obstacles.map((o) => ({ ...o })) : makeObstacles(this.arena, seed);
      this.mud = mud ? mud.map((m) => ({ ...m }))
        : obstacles ? [] : makeMud(this.arena, seed, this.obstacles);
      this.seed = seed;
      this.rng = G.makeRng(seed);
      this.tick = 0;
      this.robots = [];
      this.projectiles = [];
      this.events = [];
      this.log = [];
      this.over = false;
      this.winner = null;      // Robot, or null for a draw
      this.endReason = null;   // why the match ended, e.g. 'last robot standing'
      this.nextProjectileId = 1;

      const used = new Map();
      const teamCount = [0, 0];
      entries.forEach((entry, i) => {
        const t = entry.team;
        const color = t === 0 || t === 1
          ? TEAM_COLORS[t][teamCount[t]++ % TEAM_COLORS[t].length]
          : COLORS[i % COLORS.length];
        const r = new Robot(i, entry, color);
        // Each robot draws RAND from its own stream, so one program's random
        // calls never change the values another program sees.
        r.rng = G.makeRng((seed ^ Math.imul(i + 1, 0x85EBCA6B)) >>> 0);
        const n = (used.get(entry.name) || 0) + 1;
        used.set(entry.name, n);
        if (n > 1) r.name = `${entry.name} (${n})`;
        r.vm = new BB.VM(entry.program, this.makeIO(r));
        this.robots.push(r);
      });
      this.teamMode = this.robots.some((r) => r.team !== null);
      this.winnerTeam = null;  // team matches: 0 / 1, or null for a draw
      this.competitive = this.teamMode
        ? this.robots.some((r) => r.team === 0) && this.robots.some((r) => r.team === 1)
        : this.robots.length >= 2;
      const colorNotes = this.assignColors();
      this.spawnRobots();
      const where = `${ARENAS[this.arena].label} arena, seed ${seed}`;
      if (!this.robots.length) this.addLog('No robots in the arena.');
      else if (!this.competitive) this.addLog('Practice mode: add an opponent for a real match.');
      else if (this.teamMode) {
        const size = (t) => this.robots.filter((r) => r.team === t).length;
        this.addLog(`Team match ${size(0)}v${size(1)} started (${where}).`);
      } else this.addLog(`Match started with ${this.robots.length} robots (${where}).`);
      for (const note of colorNotes) this.addLog(note);
    }

    /**
     * Paint robots that chose a `.color`. First come, first served in roster order;
     * `auto` robots keep their slot colour unless it was chosen, then take the next
     * free one. Team matches keep warm-vs-cool team colours. Returns log lines.
     */
    assignColors() {
      const chosen = (r) => (r.appearance.color !== 'auto' ? COLORS[COLOR_NAMES.indexOf(r.appearance.color)] : null);
      if (this.teamMode) {
        return this.robots.some(chosen) ? ['Team matches use team colors (warm for A, cool for B), so .color is ignored.'] : [];
      }
      const owner = new Map(); // colour -> robot
      for (const r of this.robots) {
        const want = chosen(r);
        if (want && !owner.has(want)) { r.color = want; owner.set(want, r); }
      }
      const notes = [];
      this.robots.forEach((r, i) => {
        if (owner.get(r.color) === r) return; // got the colour it chose
        // Its slot colour if free, else the next free one round the list (with 9+ robots, colours repeat).
        const free = COLORS.map((_, k) => COLORS[(i + k) % COLORS.length]).find((c) => !owner.has(c));
        r.color = free || COLORS[i % COLORS.length];
        if (free) owner.set(free, r);
        const want = chosen(r);
        if (want) notes.push(`${r.name} chose ${r.appearance.color}, but ${owner.get(want).name} already has it, so ${r.name} is ${colorName(r.color)}.`);
      });
      return notes;
    }

    /** After a mid-match Apply: switch to a newly chosen `.color` if no other robot has it. */
    recolor(r) {
      if (r.team !== null || r.appearance.color === 'auto') return;
      const want = COLORS[COLOR_NAMES.indexOf(r.appearance.color)];
      if (want === r.color) return;
      const holder = this.robots.find((o) => o !== r && o.color === want);
      if (holder) this.addLog(`${r.name} chose ${r.appearance.color}, but ${holder.name} already has it.`);
      else r.color = want;
    }

    /** True if `b` is an opponent of `a` (teammates never are). */
    isEnemy(a, b) {
      return a !== b && (a.team === null || a.team !== b.team);
    }

    /** Rename `r` after a program reload, numbering it "(2)", "(3)"... if another robot has the name. */
    renameRobot(r, name) {
      let label = name;
      for (let n = 2; this.robots.some((o) => o !== r && o.name === label); n++) label = `${name} (${n})`;
      r.name = label;
    }

    addLog(text, kind = 'info') {
      this.log.push({ tick: this.tick, text, kind });
      if (this.log.length > 500) this.log.shift();
    }

    emit(ev) { this.events.push(ev); }

    drainEvents() {
      const e = this.events;
      this.events = [];
      return e;
    }

    // ------------------------------------------------------------------ setup

    spawnRobots() {
      if (this.teamMode) this.spawnTeams();
      else for (const r of this.robots) this.placeRandomly(r, 0, this.width);
      for (const r of this.robots) delete r._placed;
    }

    /** Clear of obstacles (with a margin) and not on top of a placed robot. */
    spotIsFree(x, y, minSep) {
      const R = C.ROBOT_RADIUS;
      return this.obstacles.every((o) => !G.circleRectPush(x, y, R + 12, o)) &&
        this.robots.every((b) => !b._placed || Math.hypot(b.x - x, b.y - y) > minSep);
    }

    /** Random free spot with x in [xMin, xMax], random heading. */
    placeRandomly(r, xMin, xMax) {
      const margin = 50;
      const lo = Math.max(margin, xMin), hi = Math.min(this.width - margin, xMax);
      let placed = false;
      for (let attempt = 0; attempt < 500 && !placed; attempt++) {
        const x = lo + this.rng() * (hi - lo);
        const y = margin + this.rng() * (this.height - 2 * margin);
        if (this.spotIsFree(x, y, attempt < 300 ? 150 : 3 * C.ROBOT_RADIUS)) { r.x = x; r.y = y; placed = true; }
      }
      // Rare (crowded roster or cramped map): take the first free spot on a fine
      // grid so the robot never starts in an obstacle. Uses no RNG, so seeds that
      // placed every robot above are unchanged.
      for (let y = margin; y <= this.height - margin && !placed; y += 4) {
        for (let x = lo; x <= hi && !placed; x += 4) {
          if (this.spotIsFree(x, y, 2 * C.ROBOT_RADIUS)) { r.x = x; r.y = y; placed = true; }
        }
      }
      if (!placed) { r.x = this.width / 2; r.y = 30; } // no room at all; the collision solver separates
      r._placed = true;
      r.heading = r.targetHeading = Math.floor(this.rng() * 360);
      r.turret = r.targetTurret = r.heading;
    }

    /**
     * Team A spawns in the left half; each team B robot takes the mirror
     * image (through the arena centre) of its team A counterpart, facing the
     * mirrored direction. Every built-in arena layout is point-symmetric, so
     * both sides get exactly the same terrain.
     */
    spawnTeams() {
      const a = this.robots.filter((r) => r.team === 0);
      const b = this.robots.filter((r) => r.team === 1);
      const mid = this.width / 2;
      for (const r of a) this.placeRandomly(r, 0, mid - 40);
      b.forEach((r, i) => {
        const twin = a[i];
        if (twin) {
          const x = this.width - twin.x, y = this.height - twin.y;
          if (this.spotIsFree(x, y, 3 * C.ROBOT_RADIUS)) {
            r.x = x; r.y = y; r._placed = true;
            r.heading = r.targetHeading = G.normAngle(twin.heading + 180);
            r.turret = r.targetTurret = r.heading;
            return;
          }
        }
        this.placeRandomly(r, mid + 40, this.width);
      });
    }

    // ---------------------------------------------------------------- VM I/O

    /** Build the only interface a robot's program has to the world. */
    makeIO(robot) {
      const world = this;
      const num = (v) => (Number.isFinite(v) ? v : 0);
      return {
        sense: (id) => world.sense(robot, id),
        random: (n) => Math.floor(robot.rng() * n),
        speed: (v) => { robot.targetSpeed = Math.max(C.MAX_REVERSE, Math.min(C.MAX_SPEED, num(v))); },
        turn: (v) => { robot.targetHeading = G.normAngle(robot.heading + num(v)); },
        head: (v) => { robot.targetHeading = G.normAngle(num(v)); },
        aim: (v) => { robot.targetTurret = G.normAngle(num(v)); },
        fire: () => { robot.wantFire = true; },
        scan: (w) => world.doScan(robot, w),
        radar: () => world.doRadar(robot),
      };
    }

    sense(r, id) {
      const round = Math.round;
      switch (BB.ISA.SENSORS[id] && BB.ISA.SENSORS[id].name) {
        case 'X': return round(r.x);
        case 'Y': return round(r.y);
        case 'HEADING': return round(r.heading) % 360;
        case 'SPEED': return round(r.speed);
        case 'HEALTH': return Math.ceil(r.health);
        case 'COOLDOWN': return r.cooldown;
        case 'TURRET': return round(r.turret) % 360;
        case 'SCAN_DIST': return r.scan.dist;
        case 'SCAN_ANGLE': return r.scan.angle;
        case 'SCAN_X': return r.scan.x;
        case 'SCAN_Y': return r.scan.y;
        case 'SCAN_HEADING': return r.scan.heading;
        case 'SCAN_SPEED': return r.scan.speed;
        case 'THREAT_DIST': return r.threat.dist;
        case 'THREAT_ANGLE': return r.threat.angle;
        case 'THREAT_HEADING': return r.threat.heading;
        case 'FRONT': return round(this.freeDistance(r));
        case 'LAST_HIT': return r.lastHitTick < 0 ? -1 : this.tick - r.lastHitTick;
        case 'TICK': return this.tick;
        case 'ENEMIES': return this.robots.filter((o) => o.alive && this.isEnemy(r, o)).length;
        case 'ALLIES': return this.robots.filter((o) => o.alive && o !== r && !this.isEnemy(r, o)).length;
        case 'SCAN_RANGE': return r.scanRange;
        case 'MUD': return this.inMud(r) ? 1 : 0;
        case 'ARENA_W': return this.width;
        case 'ARENA_H': return this.height;
        default: return 0;
      }
    }

    /** Distance the whole robot can travel along its heading before terrain contact. */
    freeDistance(r) {
      const dx = Math.cos(r.heading * G.DEG), dy = Math.sin(r.heading * G.DEG);
      let t = Infinity;
      const R = C.ROBOT_RADIUS;
      if (dx > 1e-9) t = Math.min(t, (this.width - R - r.x) / dx);
      if (dx < -1e-9) t = Math.min(t, (R - r.x) / dx);
      if (dy > 1e-9) t = Math.min(t, (this.height - R - r.y) / dy);
      if (dy < -1e-9) t = Math.min(t, (R - r.y) / dy);
      for (const o of this.obstacles) t = Math.min(t, G.sweptCircleRect(r.x, r.y, dx, dy, R, o));
      return Math.max(0, t);
    }

    inMud(r) {
      return this.mud.some((m) => G.pointInRect(r.x, r.y, m));
    }

    lineOfSight(x1, y1, x2, y2) {
      return this.obstacles.every((o) => !G.segmentHitsRect(x1, y1, x2, y2, o));
    }

    doScan(r, width) {
      const w = Math.max(1, Math.min(C.SCAN_MAX_WIDTH, width | 0));
      const range = scanRange(w);
      r.scanRange = range;
      let best = null, bestD = Infinity;
      for (const o of this.robots) {
        if (!o.alive || o.stealth || !this.isEnemy(r, o)) continue; // stealth: a mission target SCAN can't see
        const d = Math.hypot(o.x - r.x, o.y - r.y);
        if (d > range) continue;
        const ang = G.angleTo(r.x, r.y, o.x, o.y);
        // The cone hits if any part of the target's body is inside it.
        const slack = d > C.ROBOT_RADIUS ? Math.asin(C.ROBOT_RADIUS / d) / G.DEG : 90;
        if (Math.abs(G.angleDiff(ang, r.turret)) > w / 2 + slack) continue;
        if (d >= bestD || !this.lineOfSight(r.x, r.y, o.x, o.y)) continue;
        best = o; bestD = d;
      }
      if (best) {
        r.scan = {
          dist: Math.round(bestD),
          angle: Math.round(G.angleTo(r.x, r.y, best.x, best.y)) % 360,
          x: Math.round(best.x), y: Math.round(best.y),
          heading: Math.round(best.heading) % 360,
          speed: Math.round(best.speed),
        };
      } else {
        r.scan = blankScan();
      }
      r.lastScanFx = { tick: this.tick, angle: r.turret, width: w, range, found: !!best };
    }

    doRadar(r) {
      let best = null, bestD = C.RADAR_RANGE;
      for (const p of this.projectiles) {
        if (!this.isEnemy(r, this.robots[p.owner])) continue; // own and teammates' shots are harmless
        const d = Math.hypot(p.x - r.x, p.y - r.y);
        if (d > bestD) continue;
        // Approaching: velocity points toward us.
        if (p.vx * (r.x - p.x) + p.vy * (r.y - p.y) <= 0) continue;
        best = p; bestD = d;
      }
      r.threat = best
        ? {
          dist: Math.round(bestD),
          angle: Math.round(G.angleTo(r.x, r.y, best.x, best.y)) % 360,
          heading: Math.round(G.angleTo(0, 0, best.vx, best.vy)) % 360,
        }
        : blankThreat();
    }

    // ------------------------------------------------------------- the tick

    step() {
      if (this.over) return;
      this.tick++;

      const alive = this.robots.filter((r) => r.alive);
      const n = alive.length;
      for (let i = 0; i < n; i++) this.runCpu(alive[(i + this.tick) % n]);

      for (const r of alive) this.moveRobot(r);
      this.resolveRobotCollisions(alive);
      for (const r of alive) {
        if (r.alive) this.tryFire(r);
        if (r.cooldown > 0) r.cooldown--;
      }
      this.moveProjectiles();
      this.checkVictory();
      if (this.mission) this.mission.update(this); // see missions.js
    }

    runCpu(r) {
      const vm = r.vm;
      if (vm.halted) { r.cyclesLastTick = 0; return; }
      try {
        r.cyclesLastTick = vm.run(C.CYCLES_PER_TICK);
      } catch (e) {
        // VM.run already traps faults; this is a last line of defence.
        vm.halted = true;
        vm.fault = `internal error: ${e.message}`;
      }
      if (vm.fault && !r.faultReported) {
        r.faultReported = true;
        this.addLog(`${r.name} crashed: ${vm.fault}`, 'fault');
      }
    }

    moveRobot(r) {
      r.heading = G.rotateToward(r.heading, r.targetHeading, C.BODY_TURN_RATE);
      r.turret = G.rotateToward(r.turret, r.targetTurret, C.TURRET_TURN_RATE);

      const dv = r.targetSpeed - r.speed;
      r.speed += Math.sign(dv) * Math.min(Math.abs(dv), C.ACCELERATION);
      // Mud bogs the robot down at once; it accelerates normally again once out.
      if (this.inMud(r)) r.speed = Math.max(-C.MUD_MAX_SPEED, Math.min(C.MUD_MAX_SPEED, r.speed));

      r.x += Math.cos(r.heading * G.DEG) * r.speed;
      r.y += Math.sin(r.heading * G.DEG) * r.speed;

      this.constrainRobot(r);
    }

    /** `pusher` is the enemy that shoved `r` here, credited for any wall damage. */
    constrainRobot(r, pusher = null) {
      const R = C.ROBOT_RADIUS;
      let bumped = false;
      if (r.x < R) { r.x = R; bumped = true; }
      if (r.x > this.width - R) { r.x = this.width - R; bumped = true; }
      if (r.y < R) { r.y = R; bumped = true; }
      if (r.y > this.height - R) { r.y = this.height - R; bumped = true; }
      for (const o of this.obstacles) {
        const p = G.circleRectPush(r.x, r.y, R, o);
        if (p) { r.x += p.x * p.depth; r.y += p.y * p.depth; bumped = true; }
      }
      if (bumped) {
        const dmg = Math.floor(Math.abs(r.speed) / 2);
        if (dmg > 0) this.damage(r, dmg, pusher, 'wall');
        r.speed = 0;
      }
    }

    resolveRobotCollisions(list) {
      const R2 = C.ROBOT_RADIUS * 2;
      const contacts = new Set();
      const pushers = new Map(); // robot -> last enemy that pushed it this tick
      // Alternate body separation and terrain correction until contacts settle.
      // Bound work for impossible crowds; allow only microscopic numerical slack.
      for (let pass = 0; pass < 512; pass++) {
        let separated = false;
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            const a = list[i], b = list[j];
            if (!a.alive || !b.alive) continue;
            const dx = b.x - a.x, dy = b.y - a.y;
            const d = Math.hypot(dx, dy);
            if (d >= R2 - 1e-7) continue;
            separated = true;
            const nx = d < 1e-9 ? 1 : dx / d, ny = d < 1e-9 ? 0 : dy / d;
            const push = (R2 - d + 1e-7) / 2;
            a.x -= nx * push; a.y -= ny * push;
            b.x += nx * push; b.y += ny * push;
            if (this.isEnemy(a, b)) { pushers.set(a, b); pushers.set(b, a); }
            const contact = i * list.length + j;
            if (!contacts.has(contact)) {
              // Apply impact effects only once per pair, not on solver iterations.
              const avx = Math.cos(a.heading * G.DEG) * a.speed, avy = Math.sin(a.heading * G.DEG) * a.speed;
              const bvx = Math.cos(b.heading * G.DEG) * b.speed, bvy = Math.sin(b.heading * G.DEG) * b.speed;
              const closing = (avx - bvx) * nx + (avy - bvy) * ny;
              if (closing > 1 && this.isEnemy(a, b)) {
                this.damage(a, 1, b, 'ram');
                this.damage(b, 1, a, 'ram');
                this.emit({ type: 'bump', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
              }
              a.speed *= 0.5; b.speed *= 0.5;
              contacts.add(contact);
            }
          }
        }
        for (const r of list) if (r.alive) this.constrainRobot(r, pushers.get(r) || null);
        if (!separated) break;
      }
    }

    tryFire(r) {
      if (!r.wantFire) return;
      r.wantFire = false;
      if (r.cooldown > 0) return;
      r.cooldown = C.FIRE_COOLDOWN;
      r.stats.shots++;
      const dx = Math.cos(r.turret * G.DEG), dy = Math.sin(r.turret * G.DEG);
      const muzzle = C.ROBOT_RADIUS + 4;
      this.projectiles.push({
        id: this.nextProjectileId++,
        owner: r.id,
        color: r.color,
        x: r.x + dx * muzzle, y: r.y + dy * muzzle,
        px: r.x, py: r.y,
        vx: dx * C.BULLET_SPEED, vy: dy * C.BULLET_SPEED,
      });
      // The renderer drains events after several ticks, so they carry the state at the time of the shot.
      this.emit({ type: 'fire', x: r.x + dx * muzzle, y: r.y + dy * muzzle, robot: r.id, rx: r.x, ry: r.y, angle: r.turret });
    }

    moveProjectiles() {
      const SUB = 4;
      const R = C.ROBOT_RADIUS;
      const survivors = [];
      outer: for (const p of this.projectiles) {
        p.px = p.x; p.py = p.y;
        for (let s = 0; s < SUB; s++) {
          p.x += p.vx / SUB; p.y += p.vy / SUB;
          if (p.x < 0 || p.x > this.width || p.y < 0 || p.y > this.height ||
              this.obstacles.some((o) => G.pointInRect(p.x, p.y, o))) {
            this.emit({ type: 'spark', x: p.x, y: p.y });
            continue outer;
          }
          for (const r of this.robots) {
            if (!r.alive || !this.isEnemy(r, this.robots[p.owner])) continue; // no friendly fire
            if ((r.x - p.x) ** 2 + (r.y - p.y) ** 2 <= R * R) {
              const owner = this.robots[p.owner];
              owner.stats.hits++;
              this.damage(r, C.BULLET_DAMAGE, owner, 'shot');
              this.emit({ type: 'hit', x: p.x, y: p.y, color: r.color, robot: r.id, rx: r.x, ry: r.y, heading: r.heading });
              continue outer;
            }
          }
        }
        survivors.push(p);
      }
      this.projectiles = survivors;
    }

    damage(r, amount, source, cause) {
      if (!r.alive) return;
      r.health = Math.max(0, r.health - amount);
      if (cause === 'shot') r.lastHitTick = this.tick;
      if (source && source !== r) source.stats.damageDealt += amount;
      if (r.health <= 0) {
        r.alive = false;
        r.speed = r.targetSpeed = 0;
        const by = source
          ? (cause === 'wall' ? ` by ${source.name}, shoved into a wall` : ` by ${source.name}`)
          : cause === 'wall' ? ' by crashing into a wall' : '';
        this.addLog(`${r.name} was destroyed${by}.`, 'death');
        this.emit({ type: 'explode', x: r.x, y: r.y, color: r.color });
      }
    }

    checkVictory() {
      // Missions have their own win and lose rules (missions.js), so they decide when it ends.
      if (!this.competitive || this.mission) return;
      if (this.teamMode) { this.checkTeamVictory(); return; }
      const alive = this.robots.filter((r) => r.alive);
      if (alive.length <= 1) {
        this.finish(alive[0] || null, alive.length ? 'last robot standing' : 'everyone was destroyed');
      } else if (this.tick >= C.MAX_TICKS) {
        alive.sort((a, b) => b.health - a.health);
        const tie = alive[0].health === alive[1].health;
        this.finish(tie ? null : alive[0], 'time limit reached, highest health wins');
      }
    }

    checkTeamVictory() {
      const alive = [0, 1].map((t) => this.robots.filter((r) => r.alive && r.team === t));
      if (!alive[0].length || !alive[1].length) {
        const t = alive[0].length ? 0 : alive[1].length ? 1 : null;
        this.finishTeams(t, t === null ? 'everyone was destroyed' : 'last team standing');
      } else if (this.tick >= C.MAX_TICKS) {
        const hp = alive.map((list) => list.reduce((sum, r) => sum + r.health, 0));
        this.finishTeams(hp[0] === hp[1] ? null : hp[0] > hp[1] ? 0 : 1, 'time limit reached, highest total health wins');
      }
    }

    finishTeams(team, reason) {
      this.over = true;
      this.endReason = reason;
      this.winnerTeam = team;
      this.addLog(team === null ? `Draw (${reason}).` : `🏆 Team ${TEAM_NAMES[team]} wins (${reason}).`, 'win');
    }

    finish(winner, reason) {
      this.over = true;
      this.endReason = reason;
      this.winner = winner;
      this.addLog(winner ? `🏆 ${winner.name} wins (${reason}).` : `Draw (${reason}).`, 'win');
    }
  }

  World.DEFAULT_OBSTACLES = DEFAULT_OBSTACLES;
  World.ARENAS = ARENAS;
  World.makeObstacles = makeObstacles;
  World.DEFAULT_MUD = DEFAULT_MUD;
  World.makeMud = makeMud;
  World.scanRange = scanRange;
  World.COLORS = COLORS;
  World.COLOR_NAMES = COLOR_NAMES;
  World.TEAM_NAMES = TEAM_NAMES;
  World.TEAM_COLORS = TEAM_COLORS;
  BB.World = World;
})(globalThis.BB = globalThis.BB || {});
