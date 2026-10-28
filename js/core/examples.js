/*
 * examples.js — Built-in example robots (also exported to examples/*.asm by
 * tools/build.js). Each one demonstrates a different strategy.
 */
(function (BB) {
  'use strict';

  const SENTINEL = `Sentinel
.shape hexagon
.drive tracks
.turret standard
.color green
.decal spots
.badge shield
.boom fire
.shot laser
; STRATEGY: turret sniper.
; Holds its ground, sweeps the turret with a narrow scan, leads moving
; targets (predicts where they will be when the bullet arrives) and
; sidesteps any projectile that gets close.
;
; Memory: [0] = tick until which the current dodge continues

.def SWEEP_STEP   9      ; turret sweep per tick while searching
.def DODGE_RANGE  200
.def DODGE_TICKS  14

main:
    ; ---------- 1. Dodge incoming projectiles ----------
    RADAR
    GET  R0, THREAT_DIST
    CMP  R0, 0
    JL   calm
    CMP  R0, DODGE_RANGE
    JG   calm
    CALL dodge
    JMP  target
calm:
    GET  R0, TICK
    CMP  R0, [0]
    JL   target            ; still finishing a dodge
    SPEED 0                ; otherwise stand still

    ; ---------- 2. Find, lead and fire ----------
target:
    SCAN 12
    GET  R0, SCAN_DIST
    CMP  R0, 0
    JL   sweep
    CALL lead_aim          ; R6 = firing solution, turret already told to AIM
    GET  R1, TURRET
    SUB  R6, R1
    NORM R6
    ABS  R6
    CMP  R6, 6
    JG   done              ; turret still swinging into place
    GET  R1, COOLDOWN
    CMP  R1, 0
    JNE  done
    FIRE
    JMP  done
sweep:
    GET  R1, TURRET
    ADD  R1, SWEEP_STEP
    AIM  R1
done:
    WAIT
    JMP  main

; ------------------------------------------------------------------
; lead_aim: R6 = angle to where the scanned enemy will be when a bullet
; fired now reaches it.  lead = velocity * distance / BULLET_SPEED(10)
lead_aim:
    GET  R0, SCAN_DIST
    GET  R1, SCAN_HEADING
    GET  R2, SCAN_SPEED
    MUL  R2, R0            ; speed * distance
    COS  R3, R1
    MUL  R3, R2
    DIV  R3, 10000         ; / 1000 (COS scale) / 10 (bullet speed)
    SIN  R4, R1
    MUL  R4, R2
    DIV  R4, 10000
    GET  R5, SCAN_X
    ADD  R3, R5
    GET  R5, X
    SUB  R3, R5            ; R3 = predicted dx
    GET  R5, SCAN_Y
    ADD  R4, R5
    GET  R5, Y
    SUB  R4, R5            ; R4 = predicted dy
    ATAN2 R6, R4, R3
    AIM  R6
    RET

; ------------------------------------------------------------------
; dodge: move at right angles to the projectile's path, away from it.
; Drives backwards when that needs less turning.
dodge:
    GET  R1, THREAT_ANGLE
    ADD  R1, 180           ; bearing from the projectile to us
    GET  R2, THREAT_HEADING
    SUB  R1, R2
    NORM R1                ; > 0 : we are clockwise of its path
    MOV  R3, R2
    CMP  R1, 0
    JL   dodge_ccw
    ADD  R3, 90
    JMP  dodge_dir
dodge_ccw:
    SUB  R3, 90
dodge_dir:                 ; R3 = escape direction
    GET  R4, HEADING
    MOV  R5, R3
    SUB  R5, R4
    NORM R5
    ABS  R5
    CMP  R5, 90
    JG   dodge_back
    HEAD R3
    SPEED 5
    JMP  dodge_end
dodge_back:
    ADD  R3, 180
    HEAD R3
    SPEED -3
dodge_end:
    GET  R4, TICK
    ADD  R4, DODGE_TICKS
    MOV  [0], R4
    RET
`;

  const HUNTER = `Hunter
.shape wedge
.drive wheels
.turret twin
.color red
.decal flames
.badge paw
.trail sparks
.boom fireworks
.shot rocket
; STRATEGY: aggressive chaser.
; Sweeps a wide scan, charges at the nearest enemy and opens fire as soon
; as the turret lines up. Never dodges: it trusts speed and firepower.

.def CLOSE  80            ; stop charging inside this distance
.def ALIGN  8             ; max turret error (degrees) before firing

main:
    SCAN 60
    GET  R0, SCAN_DIST
    CMP  R0, 0
    JL   search

    ; Target found: point body and turret at it.
    GET  R1, SCAN_ANGLE
    AIM  R1
    HEAD R1
    SPEED 5
    CMP  R0, CLOSE
    JG   fire_check
    SPEED 0                ; close enough; ramming hurts us too

fire_check:
    GET  R2, TURRET
    SUB  R2, R1
    NORM R2
    ABS  R2
    CMP  R2, ALIGN
    JG   end
    GET  R2, COOLDOWN
    CMP  R2, 0
    JNE  end
    FIRE
end:
    WAIT
    JMP  main

search:
    ; Spin the turret and roam, steering away from walls.
    GET  R1, TURRET
    ADD  R1, 45
    AIM  R1
    SPEED 3
    GET  R2, FRONT
    CMP  R2, 50
    JG   end
    TURN 120
    JMP  end
`;

  const DODGER = `Dodger
.shape circle
.drive wheels
.turret short
.color yellow
.decal lightning
.badge bolt
.trail rainbow
.boom confetti
.shot star
; STRATEGY: evasive skirmisher.
; Always on the move: bounces off walls, wanders randomly, swerves away
; from every incoming projectile, and snipes with an independent turret.

.def DODGE_RANGE 220
.def WALL_GAP    60

main:
    ; ---- 1. evade ----
    RADAR
    GET  R0, THREAT_DIST
    CMP  R0, 0
    JL   roam
    CMP  R0, DODGE_RANGE
    JG   roam
    CALL dodge
    JMP  targeting

    ; ---- 2. roam ----
roam:
    SPEED 5
    GET  R0, FRONT
    CMP  R0, WALL_GAP
    JG   wander
    RAND R1, 90            ; wall ahead: turn 90..179 degrees
    ADD  R1, 90
    TURN R1
    JMP  targeting
wander:
    RAND R1, 40            ; about once every 40 ticks...
    CMP  R1, 0
    JNE  targeting
    RAND R1, 120           ; ...change course by -60..59 degrees
    SUB  R1, 60
    TURN R1

    ; ---- 3. fire ----
targeting:
    SCAN 24
    GET  R0, SCAN_DIST
    CMP  R0, 0
    JL   turret_sweep
    GET  R1, SCAN_ANGLE
    AIM  R1
    GET  R2, TURRET
    SUB  R2, R1
    NORM R2
    ABS  R2
    CMP  R2, 10
    JG   end
    GET  R2, COOLDOWN
    CMP  R2, 0
    JNE  end
    FIRE
    JMP  end
turret_sweep:
    GET  R1, TURRET
    SUB  R1, 20
    AIM  R1
end:
    WAIT
    JMP  main

; dodge: steer perpendicular to the projectile, away from its path.
dodge:
    GET  R1, THREAT_ANGLE
    ADD  R1, 180           ; bearing from the projectile to us
    GET  R2, THREAT_HEADING
    SUB  R1, R2
    NORM R1
    CMP  R1, 0
    JL   dodge_ccw
    ADD  R2, 90
    JMP  dodge_go
dodge_ccw:
    SUB  R2, 90
dodge_go:
    HEAD R2
    SPEED 5
    RET
`;

  const ORBITER = `Orbiter
.shape tank
.drive hover
.turret standard
.color purple
.decal stripes
.badge crown
.trail bubbles
.boom fireworks
.shot plasma
; STRATEGY: circle-strafer.
; Locks onto an enemy and orbits it at a preferred distance while firing.
; Moving sideways makes it hard to hit; reverses direction near walls.
;
; R7    = orbit direction: +90 clockwise, -90 counter-clockwise
; [0]   = tick of the last direction flip

.def RANGE       200
.def LOCK_WIDTH  16

    MOV  R7, 90
main:
    SCAN LOCK_WIDTH
    GET  R0, SCAN_DIST
    CMP  R0, 0
    JL   search

    GET  R1, SCAN_ANGLE
    AIM  R1
    ; distance correction = clamp((dist - RANGE) / 3, -60, 60)
    MOV  R2, R0
    SUB  R2, RANGE
    DIV  R2, 3
    MIN  R2, 60
    MAX  R2, -60
    ; heading = bearing + direction, bent inward when too far
    MOV  R3, R1
    ADD  R3, R7
    CMP  R7, 0
    JL   ccw
    SUB  R3, R2
    JMP  steer
ccw:
    ADD  R3, R2
steer:
    HEAD R3
    SPEED 5
    CALL walls
    ; fire when lined up
    GET  R2, TURRET
    SUB  R2, R1
    NORM R2
    ABS  R2
    CMP  R2, 8
    JG   end
    GET  R2, COOLDOWN
    CMP  R2, 0
    JNE  end
    FIRE
    JMP  end

search:
    GET  R1, TURRET
    ADD  R1, 15
    AIM  R1
    SPEED 2
    GET  R4, FRONT
    CMP  R4, 40
    JG   end
    TURN 90
end:
    WAIT
    JMP  main

; walls: if something is close ahead, slow down and flip the orbit
; direction (at most once every 30 ticks).
walls:
    GET  R4, FRONT
    CMP  R4, 40
    JG   walls_done
    SPEED 1
    GET  R5, TICK
    SUB  R5, [0]
    CMP  R5, 30
    JL   walls_done
    NEG  R7
    GET  R5, TICK
    MOV  [0], R5
walls_done:
    RET
`;

  const STACKER = `Stacker
.shape hexagon
.drive wheels
.turret twin
.color blue
.decal checker
.badge 64       ; the stack holds 64 entries
.trail smoke
.boom pixels
.shot shell
; STRATEGY: cautious patrol with a sweeping turret.
; STACK LESSON: CALL/RET share the stack with saved register values.
; Every helper restores its saved registers in reverse order before RET.
; Nested calls reach 11 stack entries, safely below the 64-entry limit.
; A routine may span CPU ticks: its stack remains intact between ticks.
;
; Main keeps two values the whole time: R2 counts completed passes and
; R3 is the cruise speed. The helpers below also use R2 and R3 as scratch,
; so each one PUSHes them first and POPs them back before RET. Watch the
; Stack row in the CPU inspector: those saved values are main's R2 and R3.
; Try it: delete combat's "PUSH R3" and "POP R3" lines, and turret_search
; overwrites the cruise speed with a turret angle. Stacker races off!

.def WALL_GAP 70
.def ALIGN 6

    MOV R2, 0             ; passes completed
    MOV R3, 3             ; cruise speed
main:
    CALL drive
    CALL combat
    INC  R2               ; still main's counter: every helper put R2 back
    WAIT                  ; both routines returned; stack is empty here
    JMP  main

; drive: preserve R0/R1; reads main's cruise speed from R3.
; wall_check returns R0=1 when it has requested an evasive turn.
drive:
    PUSH R0
    PUSH R1
    CALL wall_check
    CMP  R0, 1
    JE   drive_done
    GET  R1, HEALTH
    CMP  R1, 30
    JG   drive_cruise
    SPEED 2               ; cruise more cautiously when damaged
    JMP  drive_done
drive_cruise:
    SPEED R3
drive_done:
    POP  R1               ; last saved register comes back first
    POP  R0
    RET                   ; now the return address is on top again

; wall_check: output R0; preserve R1/R2, including across a nested CALL.
wall_check:
    PUSH R1
    PUSH R2
    GET  R1, FRONT
    GET  R2, SPEED
    ABS  R2
    MUL  R2, 8
    ADD  R2, WALL_GAP      ; leave more turning room at higher speed
    CMP  R1, R2
    JG   wall_clear
    MOV  R0, 1
    CALL steer_away
    JMP  wall_done
wall_clear:
    MOV  R0, 0
wall_done:
    POP  R2
    POP  R1
    RET

; steer_away: preserve R0/R1/R2 so wall_check keeps its return value.
steer_away:
    PUSH R0
    PUSH R1
    PUSH R2
    RAND R1, 90
    ADD  R1, 90
    RAND R0, 2
    CMP  R0, 0
    JE   steer_direction
    NEG  R1
steer_direction:
    GET  R2, HEADING
    ADD  R2, R1
    HEAD R2
    SPEED 1
    POP  R2
    POP  R1
    POP  R0
    RET

; combat: preserve R0..R3 while scanning and calling turret helpers.
combat:
    PUSH R0
    PUSH R1
    PUSH R2
    PUSH R3
    SCAN 45
    GET  R0, SCAN_DIST
    CMP  R0, 0
    JL   turret_search
    GET  R1, SCAN_ANGLE
    CALL fire_if_aligned
    JMP  combat_done
turret_search:
    GET  R3, TURRET
    ADD  R3, 18
    AIM  R3
combat_done:
    POP  R3
    POP  R2
    POP  R1
    POP  R0
    RET

; fire_if_aligned: input R1=bearing; preserve R0/R2.
; angle_error returns its result in R0, which this caller then checks.
fire_if_aligned:
    PUSH R0
    PUSH R2
    AIM  R1
    CALL angle_error
    CMP  R0, ALIGN
    JG   shot_done
    GET  R2, COOLDOWN
    CMP  R2, 0
    JNE  shot_done
    FIRE
shot_done:
    POP  R2
    POP  R0
    RET

; angle_error: input R1=bearing; output R0=absolute turret error.
; R2/R3 are scratch registers, saved so callers need not worry about them.
angle_error:
    PUSH R2
    PUSH R3
    MOV  R2, R1
    GET  R3, TURRET
    SUB  R2, R3
    NORM R2
    ABS  R2
    MOV  R0, R2
    POP  R3
    POP  R2
    RET
`;

  // Starting point for "+ New robot" (covered by the test suite).
  const NEW_ROBOT_TEMPLATE = `NewBot
.shape tank       ; tank, circle, hexagon, wedge
.drive tracks     ; tracks, wheels, hover
.turret standard  ; standard, short, twin
.color auto       ; red, blue, yellow, green, purple, orange, cyan, pink,
                  ; white, gray, lime, indigo, brown
.decal none       ; stripes, flames, lightning, spots, checker
.badge none       ; star, bolt, heart, crown, paw, shield, or 1 to 99
.trail none       ; smoke, sparks, bubbles, rainbow
.boom fire        ; fire, confetti, pixels, fireworks
.shot shell       ; shell, laser, plasma, rocket, star
; Line 1 is the robot's name. Write your program below.
; Open the Reference tab for every instruction and sensor.

main:
    SCAN 30              ; look ahead of the turret
    GET  R0, SCAN_DIST
    CMP  R0, 0
    JL   sweep           ; nobody there
    GET  R1, SCAN_ANGLE
    AIM  R1
    FIRE
    WAIT
    JMP  main
sweep:
    GET  R1, TURRET
    ADD  R1, 20
    AIM  R1
    WAIT
    JMP  main
`;

  BB.NEW_ROBOT_TEMPLATE = NEW_ROBOT_TEMPLATE;

  BB.EXAMPLES = [
    { file: 'sentinel.asm', source: SENTINEL, blurb: 'Stationary sniper: leads targets, sidesteps bullets.' },
    { file: 'hunter.asm', source: HUNTER, blurb: 'Aggressive chaser: charges and fires point-blank.' },
    { file: 'dodger.asm', source: DODGER, blurb: 'Evasive skirmisher: keeps moving, dodges everything.' },
    { file: 'orbiter.asm', source: ORBITER, blurb: 'Circle-strafer: orbits its target while firing.' },
    { file: 'stacker.asm', source: STACKER, blurb: 'Stack tutorial: nested calls, saved registers, cautious patrol.' },
  ];
})(globalThis.BB = globalThis.BB || {});
