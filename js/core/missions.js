/*
 * missions.js — Short guided challenges, one idea each, for new programmers.
 *
 * A mission is a fixed little arena (start position, optional goal zone and
 * practice dummies), starter code with one thing to fix, and a check that
 * decides pass or fail. buildMission() returns an ordinary World whose
 * `mission` object is updated at the end of every step():
 *
 *   world.mission = { def, zone, labels, result: null | { ok, text }, state }
 *
 * Optional hooks on a mission: setup(world, rng) places things that change
 * from attempt to attempt (rng comes from buildMission's seed), and
 * tick(world) runs at the end of every step, before the check.
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

  /** The nearest of the four main directions to `deg`, in words. */
  const facing = (deg) => ['right', 'down', 'left', 'up'][Math.round(BB.geo.normAngle(deg) / 90) % 4];

  /** "Time's up" for target missions: a robot that never fired needs different help from one that missed. */
  const notFired = (where) => ({ ok: false, text: `Time's up, and your robot never fired. Keep FIRE ${where}.` });

  /** The point `dist` units from (x, y) at arena angle `deg`, as { x, y }. */
  const around = (x, y, deg, dist) => ({ x: x + Math.cos(deg * BB.geo.DEG) * dist, y: y + Math.sin(deg * BB.geo.DEG) * dist });

  const LEAD_SOLUTION = 10; // degrees; see the lead mission
  const UNIT3 = makeUnit3();

  // The boss turret: tuned so standing still loses but dodging wins (see tests).
  // 13 lets every Mission 5 answer with SPEED 3 to 5 win.
  const BOSS_REST = 13;
  const BOSS_HEALTH = 100;

  const MISSIONS = [
    {
      id: 'drive',
      title: 'Full speed ahead',
      teaches: 'SPEED',
      goal: 'Drive your robot into the green goal zone.',
      hint: 'SPEED sets how fast your robot drives, from -3 (backward) to 5 (full speed). Change the 0 to a bigger number, then press ▶ Start.',
      start: { x: 120, y: 300, heading: 0 },
      zone: { x: 560, y: 240, w: 140, h: 120 },
      maxTicks: 400,
      check: (w, me) => (inZone(me, w.mission.zone) ? { ok: true, text: 'You reached the goal!' } : null),
      timeUp: (w, me) => {
        const s = w.mission.def.start;
        if (Math.hypot(me.x - s.x, me.y - s.y) < 5) return { ok: false, text: 'Time\'s up, and your robot never moved. Change SPEED 0 to a bigger number, like 5.' };
        if (me.x < s.x) return { ok: false, text: 'Your robot drove backward, away from the goal. Positive SPEED numbers drive forward.' };
        return { ok: false, text: 'Time\'s up before your robot reached the goal. Try a bigger SPEED.' };
      },
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
      start: { x: 400, y: 480, heading: 0 },
      zone: { x: 340, y: 60, w: 120, h: 100 },
      maxTicks: 400,
      check: (w, me) => (inZone(me, w.mission.zone) ? { ok: true, text: 'You found the way up!' } : null),
      timeUp: (w, me) => (facing(me.heading) === 'up'
        ? { ok: false, text: 'Your robot faces up, but it didn\'t reach the goal. Keep the SPEED line so it drives.' }
        : { ok: false, text: `Your robot faced ${facing(me.heading)}, but the goal is up. Which HEAD number points up?` }),
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
      start: { x: 200, y: 420, heading: 0 },
      dummies: [{ source: dummy('Target'), x: 450, y: 170, heading: 180, health: 30 }],
      maxTicks: 600,
      check: (w) => (!w.robots[1].alive ? { ok: true, text: 'Target destroyed!' } : null),
      timeUp: (w, me) => (!me.stats.shots ? notFired('in the loop')
        : { ok: false, text: `Time's up, and your shots missed. Your turret points at ${Math.round(me.turret) % 360}°, but the target is exactly halfway between up (270) and right (360).` }),
      starter: `Aimer
; Mission 3: hit the target 3 times.
; AIM points your turret: 0 = right, 90 = down, 180 = left, 270 = up.
; The target is up and to the right of you.
main:
    AIM 0        ; <- point at the target
    FIRE         ; fire (the turret reloads for 15 ticks)
    WAIT
    JMP main
`,
      solution: 'Aimer\nmain:\n    AIM 315\n    FIRE\n    WAIT\n    JMP main',
    },
    {
      id: 'scan',
      title: 'Find it with SCAN',
      teaches: 'SCAN, and reading CMP and jumps',
      goal: 'This robot already spins its turret and finds the target with SCAN, but it never fires. Make it fire and destroy the target.',
      hint: 'Read the code from top to bottom. After it finds the target and aims at it, one instruction is missing: the one that fires. Turn on the CPU inspector and press Step to watch it look around.',
      start: { x: 180, y: 450, heading: 0 },
      dummies: [{ source: dummy('Target'), x: 640, y: 130, heading: 180, health: 30 }],
      maxTicks: 900,
      check: (w) => (!w.robots[1].alive ? { ok: true, text: 'Found it and hit it!' } : null),
      timeUp: (w, me) => (!me.stats.shots ? notFired('on the line right after AIM R2')
        : { ok: false, text: 'Time\'s up, and the target is still there. Keep FIRE right after AIM R2, so it fires where SCAN found the target.' }),
      starter: `Seeker
; Mission 4: this robot spins its turret and looks with SCAN.
; When SCAN finds the target, it aims at it... but never fires!
; Add one line so it fires.
main:
    SCAN 10              ; look where the turret points
    GET  R1, SCAN_DIST   ; how far away? -1 = nobody
    CMP  R1, -1
    JE   spin            ; nobody found: keep spinning
    GET  R2, SCAN_ANGLE  ; found it! which way?
    AIM  R2              ; point the turret at it
                         ; <- add the firing line here
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
      goal: 'A turret is firing at you. Survive for 600 ticks with at least 50 health.',
      hint: 'A robot that sits still is easy to hit. When RADAR sees a bullet, keep turning and driving, so the bullet arrives where you used to be. The comments in the code show how.',
      start: { x: 250, y: 300, heading: 90 },
      dummies: [{ source: turret(45), x: 620, y: 300, heading: 180 }],
      maxTicks: 600,
      check: (w, me) => (me.health < 50 ? { ok: false, text: 'Too many hits! Get moving when a bullet is coming.' }
        : !w.robots[1].alive ? { ok: true, text: 'You destroyed the turret. That works too!' } : null),
      timeUp: () => ({ ok: true, text: 'You survived!' }),
      starter: `Dodger
; Mission 5: a turret is firing at you! Survive 600 ticks.
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
      teaches: 'registers, GET, CMP and your first jump',
      goal: 'Drive right and stop inside the green zone, which goes from x = 480 to x = 600.',
      hint: 'R0 is a box that holds your X position (how far right you are). The robot parks as soon as R0 is at least the number in the CMP line. Which number makes it stop inside the zone? The robot needs a few ticks to brake, so don\'t pick the very end of the zone. Then add the jump: JGE park means "if R0 was greater than or equal, go to the park label".',
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
      timeUp: (w, me) => ({ ok: false, text: `Still moving at x = ${Math.round(me.x)}. Under the CMP line, add "JGE park" so the robot parks when R0 is big enough.` }),
      starter: `Parker
; Mission 6: stop inside the green zone (x = 480 to x = 600).
; A register is a box that holds one number. GET puts a sensor
; reading into a box: here, R0 holds how far right you are.
; CMP compares two numbers, and a jump uses the answer:
; JGE label means "if it was greater than or equal, go to label".
main:
    GET  R0, X        ; R0 = my x position
    CMP  R0, 0        ; <- compare R0 with where you want to stop
                      ; <- far enough? jump to park (use JGE)
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
      hint: 'R1 holds the angle the turret aims at. It starts at 330. After each shot, make R1 bigger by 30 with "ADD R1, 30", so the next time round the loop the turret aims at the next target.',
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
    AIM  R1            ; point the turret at the angle in R1
reload:
    GET  R0, COOLDOWN  ; is the turret ready? (0 = ready)
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
      goal: 'Destroy both targets, using one "fire_at" function for both.',
      hint: 'CALL jumps to a function (also called a subroutine) and remembers where it came from. RET goes back there. Without a RET at the end of "fire_at", the robot never comes back for the second target. Every CALL needs a RET!',
      start: { x: 200, y: 300, heading: 0 },
      dummies: [315, 45].map((a) => ({ source: dummy('Target'), ...around(200, 300, a, 220), heading: 180, health: 10 })),
      maxTicks: 700,
      check: (w) => (w.robots.slice(1).every((r) => !r.alive) ? { ok: true, text: 'One function, two targets!' } : null),
      timeUp: (w, me) => {
        const hit = w.robots.slice(1).filter((r) => !r.alive).length;
        if (!me.vm.program.some((ins) => ins.op === 'RET')) {
          return { ok: false, text: `${hit} of 2 targets hit. Did your robot come back from "fire_at"? Every CALL needs a RET.` };
        }
        return { ok: false, text: `${hit} of 2 targets hit. "fire_at" comes back now, so check the angles in R1, and keep the WAIT after FIRE so the shot leaves before the turret turns.` };
      },
      starter: `Caller
; Mission 9: one "fire_at" function, used for two targets.
; CALL jumps to a function (also called a subroutine) and
; remembers where it came from.
; RET jumps back, to the line after the CALL.
main:
    MOV  R1, 315      ; first target: up and right
    CALL fire_at
    MOV  R1, 45       ; second target: down and right
    CALL fire_at
    HALT              ; all done!

; ---- fire_at: aim at the angle in R1, wait, then fire ----
fire_at:
    AIM  R1
    MOV  R2, 15       ; wait 15 ticks for the turret to turn and reload
pause:
    WAIT
    DEC  R2
    CMP  R2, 0
    JG   pause
    FIRE
    WAIT
                      ; <- something is missing! Every CALL needs a...
`,
      solution: 'Caller\nmain:\n    MOV  R1, 315\n    CALL fire_at\n    MOV  R1, 45\n    CALL fire_at\n    HALT\nfire_at:\n    AIM  R1\n    MOV  R2, 15\npause:\n    WAIT\n    DEC  R2\n    CMP  R2, 0\n    JG   pause\n    FIRE\n    WAIT\n    RET',
    },
    {
      id: 'boss',
      title: 'Boss: dodge and attack',
      teaches: 'building a program from functions',
      goal: 'Destroy the turret before your health drops below 40. It fires fast, so you must dodge as well as attack.',
      hint: 'The main loop calls two functions every tick. "attack" is done for you. Finish "dodge" with your answer from Mission 5: keep turning and drive fast while a bullet is coming.',
      start: { x: 200, y: 300, heading: 90 },
      dummies: [{ source: turret(BOSS_REST), x: 620, y: 300, heading: 180, health: BOSS_HEALTH }],
      maxTicks: 1500,
      check: (w, me) => {
        if (!w.robots[1].alive) return { ok: true, text: 'You beat the boss!' };
        if (me.health < 40) return { ok: false, text: 'Too many hits! Finish the dodge function so you keep moving, and drive fast (try SPEED 5).' };
        return null;
      },
      timeUp: () => ({ ok: false, text: 'Time\'s up: the turret is still standing. Is "attack" being called?' }),
      starter: `Boss
; Mission 10: beat the turret! It fires fast, so dodge too.
; The main loop calls two functions every tick:
;   attack - finds the turret and fires at it (done for you)
;   dodge  - gets out of the way of bullets (you finish it!)
main:
    CALL dodge
    CALL attack
    WAIT
    JMP  main

; ---- attack: look for the turret, fire when found ----
attack:
    SCAN 10
    GET  R1, SCAN_DIST
    CMP  R1, -1
    JE   turn_turret     ; nothing found: turn the turret a bit
    GET  R2, SCAN_ANGLE
    AIM  R2
    FIRE
    RET
turn_turret:
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
    JE   turn_turret
    GET  R2, SCAN_ANGLE
    AIM  R2
    FIRE
    RET
turn_turret:
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

  MISSIONS.push(...UNIT3);

  /**
   * Second hints, shown after two failed attempts: nearly the answer, so a
   * stuck student can always move on. After four, the app offers the solution.
   */
  const HINT2 = {
    drive: 'Change "SPEED 0" to "SPEED 5", then press ▶ Start.',
    angles: 'Up is 270. Change "HEAD 0" to "HEAD 270".',
    aim: 'Halfway between 270 and 360 is 315. Change "AIM 0" to "AIM 315".',
    scan: 'On the empty line right after "AIM R2", type FIRE.',
    dodge: 'Under the DANGER! comment, add two lines: "TURN 90" and then "SPEED 5".',
    park: 'Change "CMP R0, 0" to "CMP R0, 500". On the empty line under it, type "JGE park". The robot brakes a little after x = 500, still inside the zone.',
    sweep: 'On the empty line right after FIRE, type "ADD R1, 30".',
    laps: 'On the empty line right after "TURN 6", type "INC R5".',
    call: 'On the very last line of fire_at, after its WAIT, type RET.',
    boss: 'Under "; <- add your two dodge lines", type "TURN 90" and then "SPEED 5", the same as Mission 5.',
    explore: 'After "GET R0, FRONT" add "CMP R0, 80", then "JG clear", then "TURN 90". Put the label "clear:" on its own line just before WAIT.',
    follow: 'On the empty line after "CMP R1, 100", type "JG far". On the empty line after "SPEED 0", type "JMP done".',
    coords: 'On the empty line just before "AIM R4", type exactly: ATAN2 R4, R3, R2',
    lead: 'Change ".def LEAD 0" to ".def LEAD 10". If it still misses, the message tells you which way to change it.',
    graduate: 'In move, above its RET, add: "SPEED 3", "GET R0, FRONT", "CMP R0, 80", "JG move_done", "TURN 90", "move_done:". For attack, copy the whole attack function from Mission 10 over the two-line stub.',
  };

  /** Missions grouped for the Missions tab, in order. */
  const UNITS = [
    { title: 'Getting started', ids: ['drive', 'angles', 'aim', 'scan', 'dodge'] },
    { title: 'Registers, loops and functions', ids: ['park', 'sweep', 'laps', 'call', 'boss'] },
    { title: 'Sensors, math and science', ids: ['explore', 'follow', 'coords', 'lead', 'graduate'] },
  ];

  /** End the mission once the player wins, loses or runs out of time. */
  function updateMission(world) {
    const m = world.mission;
    if (m.result) return;
    const me = world.robots[0];
    if (m.def.tick) m.def.tick(world);
    // A crash ends the attempt at once: otherwise it would only show up later as "Time's up".
    let res = !me.alive ? { ok: false, text: 'Your robot was destroyed.' }
      : me.vm.fault ? { ok: false, text: `Your program crashed on line ${me.vm.faultLine}. The CPU inspector explains why.` }
      : m.def.check(world, me);
    if (!res && world.tick >= m.def.maxTicks) {
      res = m.def.timeUp ? m.def.timeUp(world, me) : { ok: false, text: 'Time\'s up! Change your code and try again.' };
    }
    if (!res) return;
    m.result = res;
    world.over = true;
    world.endReason = res.text;
    world.addLog(res.ok ? `✓ Mission complete: ${res.text}` : `✗ ${res.text}`, res.ok ? 'win' : 'fault');
  }

  /**
   * A World for mission `def`, with `player` ({ name, program, appearance }) as
   * robot 0. `seed` varies whatever the mission randomises (a new one per attempt
   * in the app; fixed in tests).
   */
  function buildMission(def, player, seed = 1) {
    const dummies = (def.dummies || []).map((d, i) => {
      const c = BB.assemble(d.source);
      return { id: ENTRY_ID - 1 - i, name: c.name, program: c.program, appearance: c.appearance };
    });
    const world = new BB.World({
      entries: [{ id: ENTRY_ID, name: player.name, program: player.program, appearance: player.appearance }, ...dummies],
      seed, obstacles: def.obstacles || [], mud: def.mud || [],
    });
    const place = (r, p) => {
      r.x = p.x; r.y = p.y;
      r.heading = r.targetHeading = r.turret = r.targetTurret = p.heading || 0;
      if (p.health) r.health = p.health;
      if (p.stealth) r.stealth = true; // hidden from SCAN (see World.doScan)
    };
    place(world.robots[0], def.start);
    (def.dummies || []).forEach((d, i) => place(world.robots[i + 1], d));
    world.log = [];
    world.addLog(`Mission ${MISSIONS.indexOf(def) + 1}: ${def.title}. ${def.goal}`);
    // `state` is scratch space for a mission's check (laps driven, ticks parked...);
    // `labels` are { x, y, text } notes the renderer draws on the arena.
    world.mission = { def, zone: def.zone || null, labels: [], result: null, state: {}, update: updateMission };
    if (def.setup) def.setup(world, BB.geo.makeRng((seed ^ 0x5EED1E55) >>> 0));
    return world;
  }

  // ------------------------------------------------------------------ unit 3

  /** Unit 3: sensors, math and science. Declared last; hoisted for MISSIONS above. */
  function makeUnit3() {
    const R = BB.CONFIG.ROBOT_RADIUS;
    // Explore: the arena is split into 12 areas, 4 across and 3 down, each 200 x 200.
    // Every FRONT-based explorer tried visits 5 or more; circling visits 1 or 2.
    const EXPLORE_AREAS = 5;
    const areaOf = (r) => Math.floor(r.x / 200) + 4 * Math.floor(r.y / 200);
    const BLOCKS = [
      { x: 360, y: 260, w: 80, h: 80 },
      { x: 150, y: 120, w: 140, h: 20 },
      { x: 510, y: 460, w: 140, h: 20 },
      { x: 610, y: 90, w: 20, h: 120 },
      { x: 170, y: 400, w: 20, h: 120 },
    ];

    // A wide circle (radius about 170) round the middle, so parking in one spot can't keep up.
    const LEADER = `Leader
.shape wedge
.drive wheels
loop:
    SPEED 2
    TURN 2
    WAIT
    WAIT
    WAIT
    JMP loop`;

    const MOVER = `Mover
.shape circle
.drive hover
    HEAD 90
    SPEED 2
loop:
    GET  R0, Y
    CMP  R0, 130
    JL   go_down
    CMP  R0, 470
    JG   go_up
    WAIT
    JMP  loop
go_down:
    HEAD 90
    WAIT
    JMP  loop
go_up:
    HEAD 270
    WAIT
    JMP  loop`;

    const RIVAL = `Rival
.shape wedge
.drive wheels
main:
    SPEED 3
    GET  R0, FRONT
    CMP  R0, 70
    JG   look
    TURN 100
look:
    SCAN 20
    GET  R1, SCAN_DIST
    CMP  R1, -1
    JE   spin
    GET  R2, SCAN_ANGLE
    AIM  R2
    FIRE
    MOV  R3, 30          ; rest between shots
rest:
    WAIT
    DEC  R3
    CMP  R3, 0
    JG   rest
    JMP  main
spin:
    GET  R2, TURRET
    ADD  R2, 15
    AIM  R2
    WAIT
    JMP  main`;

    // The graduation solution: earlier missions' functions, put together.
    const MOVE_FN = `move:
    SPEED 3
    GET  R0, FRONT
    CMP  R0, 80
    JG   move_done
    TURN 90
move_done:
    RET`;
    const ATTACK_FN = `attack:
    SCAN 10
    GET  R1, SCAN_DIST
    CMP  R1, -1
    JE   turn_turret
    GET  R2, SCAN_ANGLE
    AIM  R2
    FIRE
    RET
turn_turret:
    GET  R2, TURRET
    ADD  R2, 10
    AIM  R2
    RET`;
    const DODGE_FN = `dodge:
    RADAR
    GET  R0, THREAT_DIST
    CMP  R0, -1
    JE   dodge_done
    TURN 90
    SPEED 5
dodge_done:
    RET`;

    const unit = [
      {
        id: 'explore',
        title: 'Don\'t crash',
        teaches: 'sensor loops with FRONT',
        goal: `Explore for 600 ticks: drive at least 1200 units and visit at least ${EXPLORE_AREAS} of the arena's 12 areas, without crashing (two gentle bumps are allowed).`,
        hint: 'FRONT is a sensor that tells you how far you can drive before you hit something. Every tick, compare it with a safe distance like 80. If it is smaller, TURN 90. Lots of real robots explore this way!',
        start: { x: 90, y: 300, heading: 0 },
        obstacles: [BLOCKS[0]],
        maxTicks: 600,
        check: (w, me) => {
          const s = w.mission.state;
          if (s.x !== undefined) s.dist += Math.hypot(me.x - s.x, me.y - s.y); else { s.dist = 0; s.bumps = 0; s.hp = me.health; s.areas = new Set(); }
          s.x = me.x; s.y = me.y;
          s.areas.add(areaOf(me));
          if (me.health < s.hp) { s.bumps++; s.hp = me.health; }
          if (s.bumps > 2) return { ok: false, text: 'Three crashes! Check FRONT every tick and turn before you get too close.' };
          return null;
        },
        timeUp: (w) => {
          const d = Math.round(w.mission.state.dist), areas = w.mission.state.areas.size;
          // Driving in circles covers the distance without exploring: count the areas visited too.
          return d < 600 ? { ok: false, text: `You only drove ${d} units. Stuck against something? Check FRONT and TURN before you reach it.` }
            : d < 1200 ? { ok: false, text: `No crashes, but you only drove ${d} units. Drive a little faster: the goal is 1200.` }
            : areas < EXPLORE_AREAS ? { ok: false, text: `You drove ${d} units but only visited ${areas} of the 12 areas: going round in circles? Drive straight, and TURN only when FRONT says something is close.` }
            : { ok: true, text: `${d} units and ${areas} areas explored without crashing!` };
        },
        starter: `Explorer
; Mission 11: explore for 600 ticks and drive 1200 units without crashing,
; visiting at least 5 of the arena's 12 areas (no going round in circles!).
; FRONT is a sensor: how far you can drive before you hit something.
main:
    SPEED 3
    GET  R0, FRONT    ; R0 = distance to whatever is ahead
                      ; <- if R0 is less than 80, TURN 90 (use CMP and a jump)
    WAIT
    JMP  main
`,
        solution: 'Explorer\nmain:\n    SPEED 3\n    GET  R0, FRONT\n    CMP  R0, 80\n    JG   clear\n    TURN 90\nclear:\n    WAIT\n    JMP  main',
      },
      {
        id: 'follow',
        title: 'Follow the leader',
        teaches: 'IF / ELSE: choosing between two actions',
        goal: 'Stay within 150 units of the Leader for most of the mission, without bumping into it.',
        hint: 'An IF / ELSE picks one of two actions. After "CMP R1, 100", jump to "far" if R1 is bigger (JG far). If it doesn\'t jump, the robot carries on to SPEED 0. Then it must JMP past the "far" part to "done", or both actions would run.',
        start: { x: 200, y: 300, heading: 0 },
        dummies: [{ source: LEADER, x: 400, y: 472, heading: 180 }],
        maxTicks: 600,
        check: (w, me) => {
          const s = w.mission.state, leader = w.robots[1];
          if (w.tick > 60) {
            s.counted = (s.counted || 0) + 1;
            if (Math.hypot(leader.x - me.x, leader.y - me.y) <= 150) s.close = (s.close || 0) + 1;
          }
          if (me.health < 85 || leader.health < 85) return { ok: false, text: 'Too many bumps! Slow right down when you are close to the Leader. Is "JMP done" there, so SPEED 4 is skipped when you are close?' };
          return null;
        },
        timeUp: (w) => {
          const s = w.mission.state, pct = Math.round(100 * (s.close || 0) / Math.max(1, s.counted));
          return pct >= 85 ? { ok: true, text: `You stayed close ${pct}% of the time. Great following!` }
            : { ok: false, text: `You stayed close ${pct}% of the time. The goal is 85%.` };
        },
        starter: `Follower
; Mission 12: follow the Leader without bumping into it.
main:
    SCAN 40              ; look for the Leader
    GET  R1, SCAN_DIST   ; R1 = how far away it is (-1 = not found)
    CMP  R1, -1
    JE   search
    GET  R2, SCAN_ANGLE
    HEAD R2              ; face the Leader
    AIM  R2              ; and keep the turret on it
    ; IF R1 is more than 100 (far away), drive: SPEED 4
    ; ELSE (close), wait for it: SPEED 0
    CMP  R1, 100
                         ; <- IF: jump to "far" when R1 is bigger (JG)
    SPEED 0              ; ELSE: close, so wait for the Leader
                         ; <- skip the "far" part: jump to "done"
far:
    SPEED 4              ; far away: drive to catch up
done:
    WAIT
    JMP  main
search:
    GET  R2, TURRET
    ADD  R2, 20
    AIM  R2
    WAIT
    JMP  main
`,
        solution: `Follower
main:
    SCAN 40
    GET  R1, SCAN_DIST
    CMP  R1, -1
    JE   search
    GET  R2, SCAN_ANGLE
    HEAD R2
    AIM  R2
    CMP  R1, 100
    JG   far
    SPEED 0
    JMP  done
far:
    SPEED 4
done:
    WAIT
    JMP  main
search:
    GET  R2, TURRET
    ADD  R2, 20
    AIM  R2
    WAIT
    JMP  main`,
      },
      {
        id: 'coords',
        title: 'Mission control',
        teaches: 'coordinates, memory and ATAN2',
        goal: 'Mission control has sent the target\'s position. The target has a stealth shield, so SCAN can\'t see it: work out the angle to it and destroy it. It is somewhere new every attempt!',
        hint: 'Your position is (X, Y) and the target\'s is in memory: [0] is its x and [1] is its y. Subtract to get dx and dy, how far right and how far down the target is. ATAN2 R4, R3, R2 turns dy (R3) and dx (R2) into an angle in R4.',
        start: { x: 150, y: 300, heading: 0 },
        dummies: [{ source: dummy('Target'), x: 600, y: 150, heading: 180, health: 30, stealth: true }], // so SCAN can't replace ATAN2
        maxTicks: 600,
        setup: (w, rng) => {
          // Anywhere on the right, but never straight ahead, where AIM 0 would hit by luck.
          const t = w.robots[1];
          t.x = 450 + Math.floor(rng() * 250);
          t.y = rng() < 0.5 ? 90 + Math.floor(rng() * 130) : 380 + Math.floor(rng() * 130);
          w.mission.state.target = { x: Math.round(t.x), y: Math.round(t.y) };
          w.mission.labels.push({ x: t.x, y: t.y + R + 22, text: `(${Math.round(t.x)}, ${Math.round(t.y)})` });
          w.mission.def.tick(w); // memory is ready before the first tick
        },
        tick: (w) => {
          // Mission control keeps memory [0] and [1] up to date, even after Apply.
          const me = w.robots[0], t = w.mission.state.target;
          me.vm.mem[0] = t.x;
          me.vm.mem[1] = t.y;
        },
        check: (w, me) => {
          if (!w.robots[1].alive) return { ok: true, text: 'Right on target, navigator!' };
          if (me.stats.shots - me.stats.hits >= 8) return { ok: false, text: 'Eight misses. Is R4 set by ATAN2 before you AIM?' };
          return null;
        },
        timeUp: (w, me) => (!me.stats.shots ? notFired('after AIM R4')
          : { ok: false, text: 'Time\'s up, and the target is still there. Is R4 set by ATAN2 before you AIM?' }),
        starter: `Navigator
; Mission 13: mission control sent the target's position:
;   memory [0] holds its x, memory [1] holds its y.
; It has a stealth shield, so SCAN can't see it. Work out the
; angle from you to the target with maths, then fire.
main:
    GET  R0, X         ; my x
    GET  R1, Y         ; my y
    MOV  R2, [0]       ; R2 = target x
    SUB  R2, R0        ; R2 = dx: how far right the target is
    MOV  R3, [1]       ; R3 = target y
    SUB  R3, R1        ; R3 = dy: how far down the target is
                       ; <- turn dy and dx into an angle in R4 (look up ATAN2 in Reference)
    AIM  R4            ; point the turret at the angle in R4
    FIRE
    WAIT
    JMP  main
`,
        solution: 'Navigator\nmain:\n    GET  R0, X\n    GET  R1, Y\n    MOV  R2, [0]\n    SUB  R2, R0\n    MOV  R3, [1]\n    SUB  R3, R1\n    ATAN2 R4, R3, R2\n    AIM  R4\n    FIRE\n    WAIT\n    JMP  main',
      },
      {
        id: 'lead',
        title: 'Lead the target',
        teaches: 'experimenting: aim ahead of a moving target',
        goal: 'Hit the moving target 3 times. Your bullets take time to fly, so aim ahead of it. Find the right LEAD by experimenting!',
        hint: 'Scientists test an idea, look at the result, and adjust. Try LEAD 5, then watch: the mission tells you whether your bullets pass behind or in front of the target. Behind? Make LEAD bigger. In front? Make it smaller.',
        start: { x: 150, y: 300, heading: 0 },
        dummies: [{ source: MOVER, x: 380, y: 300, heading: 90, health: 30 }], // LEAD 8 to 14 all work here
        maxTicks: 900,
        check: (w, me) => {
          const s = w.mission.state, t = w.robots[1];
          if (!t.alive) return { ok: true, text: 'Three hits on a moving target. Great experimenting!' };
          // Follow each of our fires: where did it pass the target, in front or behind?
          s.live = s.live || new Map();
          const vx = Math.cos(t.heading * BB.geo.DEG), vy = Math.sin(t.heading * BB.geo.DEG);
          const seen = new Set();
          for (const p of w.projectiles) {
            if (p.owner !== 0) continue;
            seen.add(p.id);
            const dx = p.x - t.x, dy = p.y - t.y, d = Math.hypot(dx, dy);
            const f = s.live.get(p.id);
            // Misses while the target turns round at the end of its track don't count: front and behind flip there.
            const straight = Math.abs(BB.geo.angleDiff(t.heading, 90)) < 20 || Math.abs(BB.geo.angleDiff(t.heading, 270)) < 20;
            if (!f || d < f.best) s.live.set(p.id, { best: d, ahead: dx * vx + dy * vy > 0, straight });
          }
          for (const [id, f] of s.live) {
            if (seen.has(id)) continue;
            s.live.delete(id);
            if (f.best > R + 2 && f.straight) s[f.ahead ? 'ahead' : 'behind'] = (s[f.ahead ? 'ahead' : 'behind'] || 0) + 1;
          }
          if (me.stats.shots - me.stats.hits >= 10) {
            const ahead = s.ahead || 0, behind = s.behind || 0;
            const tip = ahead > behind ? `${ahead} of your misses passed in front of the target: try a smaller LEAD.`
              : behind > ahead ? `${behind} of your misses passed behind the target: try a bigger LEAD.` : 'Keep experimenting with LEAD.';
            return { ok: false, text: `Ten misses. ${tip}` };
          }
          return null;
        },
        timeUp: (w, me) => (!me.stats.shots ? notFired('after AIM R2')
          : { ok: false, text: `Time's up with ${me.stats.hits} of 3 hits. Keep experimenting with LEAD.` }),
        starter: `Predictor
; Mission 14: the target keeps moving, so aim AHEAD of it.
; Your bullets take time to fly. Try different LEAD values and
; watch where they go: the mission tells you if they pass
; in front of or behind the target.
.def LEAD 0           ; <- how many degrees ahead to aim. Experiment!
main:
    SCAN 20
    GET  R1, SCAN_DIST
    CMP  R1, -1
    JE   look
    GET  R2, SCAN_ANGLE   ; where the target is now
    GET  R3, SCAN_HEADING ; which way it is driving
    CMP  R3, 180          ; heading 90 = moving down, 270 = moving up
    JG   moving_up        ; more than 180? it is moving up
    ADD  R2, LEAD         ; moving down: aim a little further down
    JMP  fire_now
moving_up:
    SUB  R2, LEAD         ; moving up: aim a little further up
fire_now:
    AIM  R2
    FIRE
    WAIT
    JMP  main
look:
    GET  R2, TURRET
    ADD  R2, 10
    AIM  R2
    WAIT
    JMP  main
`,
        solution: null, // filled in below from the starter
      },
      {
        id: 'graduate',
        title: 'Graduation match',
        teaches: 'putting it all together',
        goal: 'Beat Rival in a real match: destroy it, or have more health when time runs out.',
        hint: 'Build your robot from functions you already wrote: "move" from Mission 11 and "attack" from Mission 10. Copy each one in, and rename labels if two functions use the same name. Extra challenge: add your dodge too, and test whether it really helps!',
        start: { x: 120, y: 300, heading: 0 },
        obstacles: [BLOCKS[0], BLOCKS[1], BLOCKS[2]],
        dummies: [{ source: RIVAL, x: 680, y: 300, heading: 180, health: 60 }],
        maxTicks: 3000,
        check: (w) => (!w.robots[1].alive ? { ok: true, text: 'You beat Rival. Congratulations, graduate!' } : null),
        // Winning on time needs at least one hit: health alone could be won by Rival bumping into walls.
        timeUp: (w, me) => (!me.stats.hits ? { ok: false, text: 'Time\'s up, and Rival was never hit. Is "attack" being called, and does it FIRE?' }
          : me.health > w.robots[1].health
          ? { ok: true, text: `Time's up, and you have more health (${Math.ceil(me.health)} vs ${Math.ceil(w.robots[1].health)}). You win, graduate!` }
          : { ok: false, text: `Time's up, and Rival has more health (${Math.ceil(w.robots[1].health)} vs ${Math.ceil(me.health)}).` }),
        starter: `Graduate
; Mission 15: beat Rival in a real match!
; Build your robot from functions you wrote in earlier missions.
main:
    CALL move        ; drive around without crashing (Mission 11)
    CALL attack      ; find Rival and fire (Mission 10)
    WAIT
    JMP  main

; ---- move: drive without crashing ----
move:
    ; <- copy the lines from Mission 11 that set SPEED, check FRONT
    ;    and TURN. Leave out WAIT and JMP main: main does those.
    RET

; ---- attack: replace this whole function (both lines) ----
; with the "attack" function from Mission 10, from "attack:"
; down to its last RET, including its "turn_turret" part.
attack:
    RET

; Extra challenge: write a "dodge" function, CALL it from main,
; and test whether it helps. Scientists check their ideas!
`,
        solution: `Graduate\nmain:\n    CALL move\n    CALL attack\n    WAIT\n    JMP  main\n${MOVE_FN}\n${ATTACK_FN}`,
        withDodge: `Graduate\nmain:\n    CALL move\n    CALL attack\n    CALL dodge\n    WAIT\n    JMP  main\n${MOVE_FN}\n${ATTACK_FN}\n${DODGE_FN}`,
      },
    ];
    // Lead: the starter with a LEAD that works (found by the tests' sweep of values).
    const lead = unit.find((m) => m.id === 'lead');
    lead.solution = lead.starter.replace('.def LEAD 0 ', `.def LEAD ${LEAD_SOLUTION}`);
    return unit;
  }

  for (const m of MISSIONS) m.hint2 = HINT2[m.id];

  BB.MISSIONS = MISSIONS;
  BB.MISSION_UNITS = UNITS;
  BB.buildMission = buildMission;
  BB.MISSION_ENTRY_ID = ENTRY_ID;
})(globalThis.BB = globalThis.BB || {});
