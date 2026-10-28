Orbiter
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
