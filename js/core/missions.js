/*
 * missions.js — Short guided challenges, one idea each, for new programmers.
 *
 * A mission is a fixed little arena (start position, optional goal zone and
 * practice dummies), starter code with one thing to fix, and a check that
 * decides pass or fail. buildMission() returns an ordinary World whose
 * `mission` object is updated at the end of every step():
 *
 *   world.mission = { def, zone, result: null | { ok, text } }
 *
 * Each mission's `solution` is never shown in the app; the tests use it to
 * prove the mission can be passed, and that the starter code alone cannot.
 */
(function (BB) {
  'use strict';

  const ENTRY_ID = -1; // entry id of the player's robot in a mission world

  const dummy = (src) => `${src}\n.shape circle\n.drive hover\nloop:\n    WAIT\n    JMP loop`;

  const TURRET = `Turret
.shape hexagon
.turret twin
main:
    SCAN 8
    GET  R1, SCAN_DIST
    CMP  R1, -1
    JE   sweep
    GET  R2, SCAN_ANGLE
    AIM  R2
    FIRE
    MOV  R3, 45          ; rest between shots, so dodging can work
rest:
    WAIT
    DEC  R3
    CMP  R3, 0
    JG   rest
    JMP  main
sweep:
    GET  R0, TURRET
    ADD  R0, 8
    AIM  R0
    WAIT
    JMP  main`;

  const inZone = (r, z) => BB.geo.pointInRect(r.x, r.y, z);

  const MISSIONS = [
    {
      id: 'drive',
      title: 'Full speed ahead',
      teaches: 'SPEED',
      goal: 'Drive your robot into the green goal zone.',
      hint: 'SPEED sets how fast your robot drives, from -3 (backward) to 5 (full speed). Change the 0 to a bigger number, then press Apply and Start.',
      guide: 'Field Guide: "Your first robot in 1 minute"',
      start: { x: 120, y: 300, heading: 0 },
      zone: { x: 560, y: 240, w: 140, h: 120 },
      maxTicks: 400,
      check: (w, me) => (inZone(me, w.mission.zone) ? { ok: true, text: 'You reached the goal!' } : null),
      starter: `Rookie
; Mission 1: drive into the green goal zone.
; SPEED sets how fast your robot drives:
;   -3 = backward, 0 = stopped, 5 = full speed
main:
    SPEED 0      ; <- change this number!
    WAIT
    JMP main
`,
      solution: 'Rookie\nmain:\n    SPEED 5\n    WAIT\n    JMP main',
    },
    {
      id: 'angles',
      title: 'Which way is up?',
      teaches: 'HEAD and angles',
      goal: 'The goal is straight above you. Face up and drive into it.',
      hint: 'In Battle Bots, 0° points right and angles go clockwise: 90 is down, 180 is left and 270 is up.',
      guide: 'Field Guide: "Angles: which way is which?"',
      start: { x: 400, y: 480, heading: 0 },
      zone: { x: 340, y: 60, w: 120, h: 100 },
      maxTicks: 400,
      check: (w, me) => (inZone(me, w.mission.zone) ? { ok: true, text: 'You found the way up!' } : null),
      starter: `Climber
; Mission 2: the goal is straight UP from you.
; HEAD turns your robot to face a direction:
;   0 = right, 90 = down, 180 = left, 270 = up
main:
    HEAD 0       ; <- which number points up?
    SPEED 4
    WAIT
    JMP main
`,
      solution: 'Climber\nmain:\n    HEAD 270\n    SPEED 4\n    WAIT\n    JMP main',
    },
    {
      id: 'aim',
      title: 'Hit the target',
      teaches: 'AIM and FIRE',
      goal: 'Point your turret at the target and destroy it (3 hits).',
      hint: 'The target is up and to the right, exactly halfway between up (270) and right (360, which is the same as 0). What number is halfway?',
      guide: 'Field Guide: "Angles" and "Controlling the robot"',
      start: { x: 200, y: 420, heading: 0 },
      dummies: [{ source: dummy('Target'), x: 450, y: 170, heading: 180, health: 30 }],
      maxTicks: 600,
      check: (w) => (!w.robots[1].alive ? { ok: true, text: 'Target destroyed!' } : null),
      starter: `Gunner
; Mission 3: hit the target 3 times.
; AIM points your turret: 0 = right, 90 = down, 180 = left, 270 = up.
; The target is up and to the right of you.
main:
    AIM 0        ; <- point at the target
    FIRE         ; shoot (the gun reloads for 15 ticks)
    WAIT
    JMP main
`,
      solution: 'Gunner\nmain:\n    AIM 315\n    FIRE\n    WAIT\n    JMP main',
    },
    {
      id: 'scan',
      title: 'Find it with SCAN',
      teaches: 'SCAN, CMP and jumps',
      goal: 'This robot already spins its turret and finds the target with SCAN, but it never shoots. Make it fire and destroy the target.',
      hint: 'Read the code from top to bottom. After it finds the target and aims at it, one instruction is missing: the one that shoots. Turn on the CPU inspector and press Step to watch it look around.',
      guide: 'Field Guide: Challenge 6 "First shot"',
      start: { x: 180, y: 450, heading: 0 },
      dummies: [{ source: dummy('Target'), x: 640, y: 130, heading: 180, health: 30 }],
      maxTicks: 900,
      check: (w) => (!w.robots[1].alive ? { ok: true, text: 'Found it and hit it!' } : null),
      starter: `Seeker
; Mission 4: this robot spins its turret and looks with SCAN.
; When SCAN finds the target, it aims at it... but never shoots!
; Add one line so it fires.
main:
    SCAN 10              ; look where the turret points
    GET  R1, SCAN_DIST   ; how far away? -1 = nobody
    CMP  R1, -1
    JE   spin            ; nobody found: keep spinning
    GET  R2, SCAN_ANGLE  ; found it! which way?
    AIM  R2              ; point the gun at it
                         ; <- add the shooting line here
    WAIT
    JMP  main
spin:
    GET  R0, TURRET
    ADD  R0, 10
    AIM  R0              ; turn the turret a bit more
    WAIT
    JMP  main
`,
      solution: `Seeker
main:
    SCAN 10
    GET  R1, SCAN_DIST
    CMP  R1, -1
    JE   spin
    GET  R2, SCAN_ANGLE
    AIM  R2
    FIRE
    WAIT
    JMP  main
spin:
    GET  R0, TURRET
    ADD  R0, 10
    AIM  R0
    WAIT
    JMP  main`,
    },
    {
      id: 'dodge',
      title: 'Dodge!',
      teaches: 'RADAR',
      goal: 'A turret is shooting at you. Survive for 600 ticks with at least 50 health.',
      hint: 'A robot that sits still is easy to hit. When RADAR sees a bullet, keep turning and driving, so the bullet arrives where you used to be. The comments in the code show how.',
      guide: 'Field Guide: Challenge 8 "Bullet dodger"',
      start: { x: 250, y: 300, heading: 90 },
      dummies: [{ source: TURRET, x: 620, y: 300, heading: 180 }],
      maxTicks: 600,
      check: (w, me) => (me.health < 50 ? { ok: false, text: 'Too many hits! Get moving when a bullet is coming.' } : null),
      timeUp: () => ({ ok: true, text: 'You survived!' }),
      starter: `Dodger
; Mission 5: a turret is shooting at you! Survive 600 ticks.
; RADAR spots bullets flying at you. Right now this robot
; notices them... and just sits there.
main:
    RADAR                    ; any bullets coming?
    GET  R0, THREAT_DIST     ; -1 = no danger
    CMP  R0, -1
    JE   safe
    ; DANGER! Add two lines here to get out of the way:
    ;   one that keeps turning (try TURN 90)
    ;   one that drives fast (try SPEED 5)
safe:
    WAIT
    JMP main
`,
      solution: `Dodger
main:
    RADAR
    GET  R0, THREAT_DIST
    CMP  R0, -1
    JE   safe
    TURN 90
    SPEED 5
safe:
    WAIT
    JMP main`,
    },
  ];

  /** End the mission once the player wins, loses or runs out of time. */
  function updateMission(world) {
    const m = world.mission;
    if (m.result) return;
    const me = world.robots[0];
    let res = me.alive ? m.def.check(world, me) : { ok: false, text: 'Your robot was destroyed.' };
    if (!res && world.tick >= m.def.maxTicks) {
      res = m.def.timeUp ? m.def.timeUp(world, me) : { ok: false, text: 'Time\'s up! Change your code and try again.' };
    }
    if (!res) return;
    m.result = res;
    world.over = true;
    world.endReason = res.text;
    world.addLog(res.ok ? `✓ Mission complete: ${res.text}` : `✗ ${res.text}`, res.ok ? 'win' : 'fault');
  }

  /** A World for mission `def`, with `player` ({ name, program, appearance }) as robot 0. */
  function buildMission(def, player) {
    const dummies = (def.dummies || []).map((d, i) => {
      const c = BB.assemble(d.source);
      return { id: ENTRY_ID - 1 - i, name: c.name, program: c.program, appearance: c.appearance };
    });
    const world = new BB.World({
      entries: [{ id: ENTRY_ID, name: player.name, program: player.program, appearance: player.appearance }, ...dummies],
      seed: 1, obstacles: def.obstacles || [], mud: def.mud || [],
    });
    const place = (r, p) => {
      r.x = p.x; r.y = p.y;
      r.heading = r.targetHeading = r.turret = r.targetTurret = p.heading || 0;
      if (p.health) r.health = p.health;
    };
    place(world.robots[0], def.start);
    (def.dummies || []).forEach((d, i) => place(world.robots[i + 1], d));
    world.log = [];
    world.addLog(`Mission ${MISSIONS.indexOf(def) + 1}: ${def.title}. ${def.goal}`);
    world.mission = { def, zone: def.zone || null, result: null, update: updateMission };
    return world;
  }

  BB.MISSIONS = MISSIONS;
  BB.buildMission = buildMission;
  BB.MISSION_ENTRY_ID = ENTRY_ID;
})(globalThis.BB = globalThis.BB || {});
