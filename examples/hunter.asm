Hunter
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
