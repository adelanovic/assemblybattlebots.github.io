/*
 * missions.js — Short guided challenges, one idea each, for new programmers.
 *
 * A mission is a fixed little arena (start position, optional goal zone and
 * practice dummies), starter code with one thing to fix, and a check that
 * decides pass or fail. buildMission() returns an ordinary World whose
 * `mission` object is updated at the end of every step():
 *
 *   world.mission = { def, zone, result: null | { ok, text }, state }
 *
 * Each mission's `solution` is never shown in the app; the tests use it to
 * prove the mission can be passed, and that the starter code alone cannot.
 */
(function (BB) {
  'use strict';

  const ENTRY_ID = -1; // entry id of the player's robot in a mission world

  const dummy = (src) => `${src}\n.shape circle\n.drive hover\nloop:\n    WAIT\n    JMP loop`;

  /** A turret that sweeps with SCAN and fires, resting `rest` ticks between shots. */
  const turret = (rest) => `Turret
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
    MOV  R3, ${rest}     ; rest between shots, so dodging can work
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

  /** The point `dist` units from (x, y) at arena angle `deg`, as { x, y }. */
  const around = (x, y, deg, dist) => ({ x: x + Math.cos(deg * BB.geo.DEG) * dist, y: y + Math.sin(deg * BB.geo.DEG) * dist });

  // The boss turret: tuned so standing still loses but dodging wins (see tests).
  const BOSS_REST = 10;
  const BOSS_HEALTH = 100;

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
      dummies: [{ source: turret(45), x: 620, y: 300, heading: 180 }],
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

    // ---------------------------------------------------------------- unit 2
    {
      id: 'park',
      title: 'Park it',
      teaches: 'registers, GET and CMP',
      goal: 'Drive right and stop inside the green zone, which goes from x = 480 to x = 600.',
      hint: 'R0 is a box that holds your X position (how far right you are). The robot parks as soon as R0 is at least the number in the CMP line. Which number makes it stop inside the zone? The robot needs a few ticks to brake, so don\'t pick the very end of the zone.',
      guide: 'Field Guide: "Registers: your robot\'s scratch paper" and "Making decisions"',
      start: { x: 120, y: 300, heading: 0 },
      zone: { x: 480, y: 220, w: 120, h: 160 },
      zoneLabel: 'x 480 to 600',
      maxTicks: 500,
      check: (w, me) => {
        // Parked = stopped on purpose for 20 ticks in a row.
        const s = w.mission.state;
        s.still = Math.abs(me.speed) < 0.01 && me.targetSpeed === 0 ? (s.still || 0) + 1 : 0;
        if (s.still < 20) return null;
        if (inZone(me, w.mission.zone)) return { ok: true, text: 'Parked perfectly!' };
        return { ok: false, text: `You parked at x = ${Math.round(me.x)}. The zone goes from x = 480 to x = 600.` };
      },
      timeUp: (w, me) => ({ ok: false, text: `Still moving at x = ${Math.round(me.x)}. Make the robot park inside the zone.` }),
      starter: `Parker
; Mission 6: stop inside the green zone (x = 480 to x = 600).
; A register is a box that holds one number. GET puts a sensor
; reading into a box: here, R0 holds how far right you are.
main:
    GET  R0, X        ; R0 = my x position
    CMP  R0, 0        ; <- compare R0 with where you want to stop
    JGE  park         ; far enough? go and park
    SPEED 3
    WAIT
    JMP  main
park:
    SPEED 0
    WAIT
    JMP  park
`,
      solution: 'Parker\nmain:\n    GET  R0, X\n    CMP  R0, 500\n    JGE  park\n    SPEED 3\n    WAIT\n    JMP  main\npark:\n    SPEED 0\n    WAIT\n    JMP  park',
    },
    {
      id: 'sweep',
      title: 'Three in a row',
      teaches: 'changing a register in a loop',
      goal: 'Destroy all three targets. They are at angles 330, 0 and 30.',
      hint: 'R1 holds the angle the gun aims at. It starts at 330. After each shot, make R1 bigger by 30 with "ADD R1, 30", so the next time round the loop the gun aims at the next target.',
      guide: 'Field Guide: "Every instruction, explained" (ADD)',
      // Facing the first target, so the very first shot can hit it.
      start: { x: 150, y: 300, heading: 330 },
      dummies: [330, 0, 30].map((a) => ({ source: dummy('Target'), ...around(150, 300, a, 250), heading: 180, health: 10 })),
      maxTicks: 600,
      check: (w, me) => {
        if (w.robots.slice(1).every((r) => !r.alive)) return { ok: true, text: 'Three targets, one loop!' };
        // Sweeping all the way round would hit everything eventually; aiming is the lesson.
        if (me.stats.shots > 6) return { ok: false, text: `${me.stats.shots} shots for 3 targets is too many misses. Make R1 point at the next target after each shot.` };
        return null;
      },
      timeUp: (w) => ({ ok: false, text: `Only ${w.robots.slice(1).filter((r) => !r.alive).length} of 3 targets hit. Does R1 change after each shot?` }),
      starter: `Sweeper
; Mission 7: three targets, at angles 330, 0 and 30.
; R1 holds the angle to aim at. It starts at 330.
    MOV  R1, 330
loop:
    AIM  R1            ; point the gun at the angle in R1
reload:
    GET  R0, COOLDOWN  ; is the gun ready? (0 = ready)
    CMP  R0, 0
    JG   not_ready
    FIRE
                       ; <- add 30 to R1, so the next shot aims further round
    WAIT
    JMP  loop
not_ready:
    WAIT
    JMP  reload
`,
      solution: 'Sweeper\n    MOV  R1, 330\nloop:\n    AIM  R1\nreload:\n    GET  R0, COOLDOWN\n    CMP  R0, 0\n    JG   not_ready\n    FIRE\n    ADD  R1, 30\n    WAIT\n    JMP  loop\nnot_ready:\n    WAIT\n    JMP  reload',
    },
    {
      id: 'laps',
      title: 'Three laps',
      teaches: 'counting with INC',
      goal: 'Drive exactly 3 laps of a circle, then stop.',
      hint: 'One lap takes 60 ticks, so 3 laps take 180 ticks. R5 is your tick counter, but nothing adds to it yet! Add "INC R5" inside the loop so R5 counts up by 1 every tick.',
      guide: 'Field Guide: "Every instruction, explained" (INC) and "Making decisions"',
      start: { x: 400, y: 260, heading: 0 },
      maxTicks: 420,
      check: (w, me) => {
        // Add up how far the body has turned: 360° is one lap.
        const s = w.mission.state;
        if (s.last === undefined) { s.last = me.heading; s.turned = 0; }
        s.turned += Math.abs(BB.geo.angleDiff(me.heading, s.last));
        s.last = me.heading;
        if (Math.abs(me.speed) > 0.5) s.moved = true;
        if (!s.moved || Math.abs(me.speed) > 0.01) return null;
        const laps = s.turned / 360;
        if (laps >= 2.75 && laps <= 3.4) return { ok: true, text: 'Exactly three laps!' };
        return { ok: false, text: `You stopped after ${laps.toFixed(1)} laps. The goal is 3.` };
      },
      timeUp: (w) => ({ ok: false, text: `Still driving after ${(w.mission.state.turned / 360).toFixed(1)} laps! Count the ticks in R5 and stop at 180.` }),
      starter: `Lapper
; Mission 8: drive exactly 3 laps, then stop.
; One lap takes 60 ticks, so 3 laps take 180 ticks.
; R5 is the tick counter. Every box starts at 0.
main:
    SPEED 4
    TURN 6            ; turning 6° every tick drives in a circle
                      ; <- add a line that adds 1 to R5 (count up!)
    CMP  R5, 180      ; counted 180 ticks yet?
    JGE  stop
    WAIT
    JMP  main
stop:
    SPEED 0
    WAIT
    JMP  stop
`,
      solution: 'Lapper\nmain:\n    SPEED 4\n    TURN 6\n    INC  R5\n    CMP  R5, 180\n    JGE  stop\n    WAIT\n    JMP  main\nstop:\n    SPEED 0\n    WAIT\n    JMP  stop',
    },
    {
      id: 'call',
      title: 'Come back!',
      teaches: 'functions: CALL and RET',
      goal: 'Destroy both targets, using one "shoot" function for both.',
      hint: 'CALL jumps to a function and remembers where it came from. RET goes back there. Without a RET at the end of "shoot", the robot never comes back for the second target. Every CALL needs a RET!',
      guide: 'Field Guide: "Subroutines and timing"',
      start: { x: 200, y: 300, heading: 0 },
      dummies: [315, 45].map((a) => ({ source: dummy('Target'), ...around(200, 300, a, 220), heading: 180, health: 10 })),
      maxTicks: 700,
      check: (w) => (w.robots.slice(1).every((r) => !r.alive) ? { ok: true, text: 'One function, two targets!' } : null),
      timeUp: (w, me) => {
        const hit = w.robots.slice(1).filter((r) => !r.alive).length;
        if (!me.vm.program.some((ins) => ins.op === 'RET')) {
          return { ok: false, text: `${hit} of 2 targets hit. Did your robot come back from "shoot"? Every CALL needs a RET.` };
        }
        return { ok: false, text: `${hit} of 2 targets hit. "shoot" comes back now, so check the angles in R1, and keep the WAIT after FIRE so the shot leaves before the gun turns.` };
      },
      starter: `Caller
; Mission 9: one "shoot" function, used for two targets.
; CALL jumps to a function and remembers where it came from.
; RET jumps back, to the line after the CALL.
main:
    MOV  R1, 315      ; first target: up and right
    CALL shoot
    MOV  R1, 45       ; second target: down and right
    CALL shoot
    HALT              ; all done!

; ---- shoot: aim at the angle in R1, wait, then fire ----
shoot:
    AIM  R1
    MOV  R2, 15       ; wait 15 ticks for the gun to turn and reload
pause:
    WAIT
    DEC  R2
    CMP  R2, 0
    JG   pause
    FIRE
    WAIT
                      ; <- something is missing! Every CALL needs a...
`,
      solution: 'Caller\nmain:\n    MOV  R1, 315\n    CALL shoot\n    MOV  R1, 45\n    CALL shoot\n    HALT\nshoot:\n    AIM  R1\n    MOV  R2, 15\npause:\n    WAIT\n    DEC  R2\n    CMP  R2, 0\n    JG   pause\n    FIRE\n    WAIT\n    RET',
    },
    {
      id: 'boss',
      title: 'Boss: dodge and attack',
      teaches: 'building a program from functions',
      goal: 'Destroy the turret before your health drops below 40. It shoots fast, so you must dodge as well as attack.',
      hint: 'The main loop calls two functions every tick. "attack" is done for you. Finish "dodge" with your answer from Mission 5: keep turning and drive fast while a bullet is coming.',
      guide: 'Field Guide: Challenge 8 "Bullet dodger"',
      start: { x: 200, y: 300, heading: 90 },
      dummies: [{ source: turret(BOSS_REST), x: 620, y: 300, heading: 180, health: BOSS_HEALTH }],
      maxTicks: 1500,
      check: (w, me) => {
        if (!w.robots[1].alive) return { ok: true, text: 'You beat the boss!' };
        if (me.health < 40) return { ok: false, text: 'Too many hits! Finish the dodge function so you keep moving.' };
        return null;
      },
      timeUp: () => ({ ok: false, text: 'Time\'s up: the turret is still standing. Is "attack" being called?' }),
      starter: `Boss
; Mission 10: beat the turret! It shoots fast, so dodge too.
; The main loop calls two functions every tick:
;   attack - finds the turret and shoots it (done for you)
;   dodge  - gets out of the way of bullets (you finish it!)
main:
    CALL dodge
    CALL attack
    WAIT
    JMP  main

; ---- attack: look for the turret, shoot when found ----
attack:
    SCAN 10
    GET  R1, SCAN_DIST
    CMP  R1, -1
    JE   turn_gun        ; nothing found: turn the gun a bit
    GET  R2, SCAN_ANGLE
    AIM  R2
    FIRE
    RET
turn_gun:
    GET  R2, TURRET
    ADD  R2, 10
    AIM  R2
    RET

; ---- dodge: if a bullet is coming, move! ----
dodge:
    RADAR
    GET  R0, THREAT_DIST
    CMP  R0, -1
    JE   dodge_done      ; no danger: nothing to do
                         ; <- add your two dodge lines from Mission 5
dodge_done:
    RET
`,
      solution: `Boss
main:
    CALL dodge
    CALL attack
    WAIT
    JMP  main
attack:
    SCAN 10
    GET  R1, SCAN_DIST
    CMP  R1, -1
    JE   turn_gun
    GET  R2, SCAN_ANGLE
    AIM  R2
    FIRE
    RET
turn_gun:
    GET  R2, TURRET
    ADD  R2, 10
    AIM  R2
    RET
dodge:
    RADAR
    GET  R0, THREAT_DIST
    CMP  R0, -1
    JE   dodge_done
    TURN 90
    SPEED 5
dodge_done:
    RET`,
    },
  ];

  /** Missions grouped for the Missions tab, in order. */
  const UNITS = [
    { title: 'Getting started', ids: ['drive', 'angles', 'aim', 'scan', 'dodge'] },
    { title: 'Registers, loops and functions', ids: ['park', 'sweep', 'laps', 'call', 'boss'] },
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
    // `state` is scratch space for a mission's check (laps driven, ticks parked...).
    world.mission = { def, zone: def.zone || null, result: null, state: {}, update: updateMission };
    return world;
  }

  BB.MISSIONS = MISSIONS;
  BB.MISSION_UNITS = UNITS;
  BB.buildMission = buildMission;
  BB.MISSION_ENTRY_ID = ENTRY_ID;
})(globalThis.BB = globalThis.BB || {});
