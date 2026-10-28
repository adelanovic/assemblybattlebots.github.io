Sentinel
.shape hexagon
.drive tracks
.turret standard
.color green
.decal spots
.badge shield
.boom fire
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
