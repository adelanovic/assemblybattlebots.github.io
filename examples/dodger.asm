Dodger
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
