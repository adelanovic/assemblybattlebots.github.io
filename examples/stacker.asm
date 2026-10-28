Stacker
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
