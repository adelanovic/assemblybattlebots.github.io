/*
 * snippets.js — Ready-made code patterns for the editor's Insert menu, each
 * with beginner comments. No DOM access: the editor inserts them, and tests
 * check that every one assembles.
 *
 * Labels inside a snippet are renamed (skip -> skip2) when the program
 * already uses them, so inserting the same pattern twice still assembles.
 */
(function (BB) {
  'use strict';

  const SNIPPETS = [
    {
      id: 'loop',
      title: 'Main loop',
      code: `main:
    ; your code here: it runs once every tick
    WAIT
    JMP  main`,
    },
    {
      id: 'if',
      title: 'IF (one choice)',
      code: `    GET  R0, HEALTH      ; read a sensor into a box
    CMP  R0, 30          ; compare it with a number
    JGE  skip            ; NOT below 30? skip the next part
    ; code here runs only when HEALTH is below 30
skip:`,
    },
    {
      id: 'ifelse',
      title: 'IF / ELSE (two choices)',
      code: `    GET  R0, FRONT       ; distance to whatever is ahead
    CMP  R0, 80
    JG   else_part       ; more than 80? jump to the ELSE part
    TURN 90              ; IF: 80 or less, so turn
    JMP  end_if          ; skip the ELSE part
else_part:
    SPEED 4              ; ELSE: more than 80, so drive
end_if:`,
    },
    {
      id: 'repeat',
      title: 'Repeat 5 times',
      code: `    MOV  R5, 0           ; R5 counts how many times
repeat:
    ; code here repeats 5 times
    INC  R5              ; count up by 1
    CMP  R5, 5
    JL   repeat          ; not 5 yet? go round again`,
    },
    {
      id: 'function',
      title: 'Function (CALL and RET)',
      code: `    CALL my_function     ; run the function, then come back here
    HALT                 ; (move the function below your main loop)

; ---- my_function: a chunk of code you can CALL from anywhere ----
my_function:
    ; code here
    RET                  ; go back to the line after the CALL`,
    },
    {
      id: 'scan',
      title: 'Scan and fire',
      code: `    SCAN 20              ; look where the turret points
    GET  R1, SCAN_DIST   ; how far away? -1 = nobody found
    CMP  R1, -1
    JE   look_around     ; nobody: turn the turret instead
    GET  R2, SCAN_ANGLE  ; which way is the enemy?
    AIM  R2              ; point the turret at it
    FIRE
    JMP  scan_done
look_around:
    GET  R2, TURRET
    ADD  R2, 15
    AIM  R2              ; turn the turret a little more
scan_done:`,
    },
    {
      id: 'wall',
      title: 'Wall check',
      code: `    GET  R0, FRONT       ; distance to whatever is ahead
    CMP  R0, 80
    JG   path_clear      ; more than 80 away? carry on
    TURN 90              ; too close: turn away
path_clear:`,
    },
    {
      id: 'dodge',
      title: 'Dodge bullets',
      code: `    RADAR                ; any bullets flying at you?
    GET  R0, THREAT_DIST ; -1 = no danger
    CMP  R0, -1
    JE   no_danger
    TURN 90              ; danger: keep turning...
    SPEED 5              ; ...and drive fast
no_danger:`,
    },
  ];

  /** Labels defined in `text` (upper case, as the assembler compares them). */
  function labelsIn(text) {
    const found = new Set();
    for (const line of text.split('\n')) {
      let code = line.replace(/[;#].*$/, '');
      let m;
      while ((m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(code))) {
        found.add(m[1].toUpperCase());
        code = code.slice(m[0].length);
      }
    }
    return found;
  }

  /** Snippet `id`'s code, with any label that `program` already uses renamed. */
  function snippetFor(id, program = '') {
    const s = SNIPPETS.find((x) => x.id === id);
    if (!s) return null;
    const taken = labelsIn(program);
    let code = s.code;
    for (const label of labelsIn(s.code)) {
      if (!taken.has(label)) continue;
      let n = 2;
      while (taken.has(`${label}${n}`)) n++;
      // Rename in the code part of each line only: a comment like "skip the next part" stays as written.
      const re = new RegExp(`\\b${label}\\b`, 'gi');
      code = code.split('\n').map((line) => {
        const c = line.search(/[;#]/);
        const body = c < 0 ? line : line.slice(0, c), comment = c < 0 ? '' : line.slice(c);
        return body.replace(re, (word) => `${word}${n}`) + comment;
      }).join('\n');
      taken.add(`${label}${n}`);
    }
    return code;
  }

  BB.SNIPPETS = SNIPPETS;
  BB.snippetFor = snippetFor;
})(globalThis.BB = globalThis.BB || {});
