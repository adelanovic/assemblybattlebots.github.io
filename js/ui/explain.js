/*
 * explain.js — Plain-language help for Simple view, worded like the Student
 * Field Guide (registers are "boxes", cycles are "coins", labels are
 * "bookmarks"). No DOM access: the editor tooltips, the CPU inspector and the
 * trace use these strings, and tests load this file in Node.
 */
(function (BB) {
  'use strict';

  const INSTRUCTIONS = {
    MOV: 'Copy the second value into the first. MOV R1, 90 puts 90 into R1.',
    PUSH: 'Save a number on top of the stack, like adding a plate to a pile.',
    POP: 'Take the top number off the stack and put it in a box.',
    ADD: 'Add the second value to the first. ADD R0, 5 adds 5 to R0.',
    SUB: 'Take the second value away from the first.',
    MUL: 'Multiply the first value by the second. MUL R0, 3 triples R0.',
    DIV: 'Divide, with no remainder: 7 ÷ 2 gives 3. Dividing by 0 crashes your program!',
    MOD: 'Keep only the remainder of a division. MOD R0, 360 keeps R0 from 0 to 359.',
    INC: 'Count up: add 1.',
    DEC: 'Count down: subtract 1.',
    NEG: 'Flip the sign: 5 becomes -5.',
    ABS: 'Make it positive: -20 becomes 20.',
    MIN: 'Keep the smaller of the two. MIN R0, 45 means "never above 45".',
    MAX: 'Keep the bigger of the two. MAX R0, -45 means "never below -45".',
    AND: 'Bonus for curious coders: works on the 1s and 0s (bits) inside a number.',
    OR: 'Bonus for curious coders: works on the 1s and 0s (bits) inside a number.',
    XOR: 'Bonus for curious coders: works on the 1s and 0s (bits) inside a number.',
    RAND: 'Pick a random number from 0 up to one less than the second value. RAND R0, 360 picks any direction.',
    ATAN2: 'Find the angle that points toward a spot. Give it how far down (dy), then how far right (dx).',
    SIN: 'Sine of an angle, times 1000 (no decimals allowed!).',
    COS: 'Cosine of an angle, times 1000 (no decimals allowed!).',
    SQRT: 'Square root, rounded down.',
    NORM: 'Squeeze an angle into -180 to 179. It shows the shortest way to turn: negative = left, positive = right.',
    CMP: 'Compare two numbers. It doesn\'t change anything: it just remembers which one is bigger, for the next jump.',
    JMP: 'Always jump to the bookmark (label).',
    JE: 'Jump if the last CMP found the two numbers equal.',
    JNE: 'Jump if the last CMP found the two numbers different.',
    JL: 'Jump if the first number in the last CMP was smaller.',
    JLE: 'Jump if the first number in the last CMP was smaller or equal.',
    JG: 'Jump if the first number in the last CMP was bigger.',
    JGE: 'Jump if the first number in the last CMP was bigger or equal.',
    CALL: 'Jump to a subroutine and remember where you came from. Every CALL needs a RET.',
    RET: 'Go back to the line right after the CALL.',
    NOP: 'Do nothing. It just uses up one coin.',
    WAIT: '"I\'m done for this tick." Ends your turn so the game can move everything.',
    HALT: 'Stop your program for good. Your robot keeps following its last orders.',
    GET: 'Read a sensor into a box. GET R0, HEALTH asks "how much health do I have?"',
    SPEED: 'Drive at this speed: -3 (backward) up to 5 (full speed). The robot speeds up a little each tick.',
    TURN: 'Turn this many degrees from where you face now. + turns right, - turns left.',
    HEAD: 'Turn to face an exact direction: 0 = right, 90 = down, 180 = left, 270 = up.',
    AIM: 'Point the turret at an exact direction: 0 = right, 90 = down, 180 = left, 270 = up.',
    FIRE: 'Fire, if the turret is ready. After firing it needs 15 ticks to reload.',
    SCAN: 'Look for the nearest enemy in a cone around the turret, like a flashlight. Narrow cones see farther.',
    RADAR: 'Look for a bullet flying at you (within 250 units).',
  };

  const SENSORS = {
    X: 'Where I am, left to right (0 to 800).',
    Y: 'Where I am, top to bottom (0 to 600).',
    HEADING: 'Which way my body is facing (0 to 359°).',
    SPEED: 'How fast I\'m moving right now.',
    HEALTH: 'How much health I have left (0 to 100).',
    COOLDOWN: 'Ticks until I can fire again. 0 means ready!',
    TURRET: 'Which way my turret is pointing (0 to 359°).',
    SCAN_DIST: 'How far away the enemy my SCAN found is. -1 means nobody was found.',
    SCAN_ANGLE: 'Which way the enemy my SCAN found is.',
    SCAN_X: 'Where the enemy my SCAN found is, left to right.',
    SCAN_Y: 'Where the enemy my SCAN found is, top to bottom.',
    SCAN_HEADING: 'Which way the enemy my SCAN found is driving.',
    SCAN_SPEED: 'How fast the enemy my SCAN found is going.',
    THREAT_DIST: 'How far away the bullet my RADAR found is. -1 means no danger.',
    THREAT_ANGLE: 'Which way the bullet my RADAR found is.',
    THREAT_HEADING: 'Which way the bullet my RADAR found is flying.',
    FRONT: 'How far I can drive straight ahead before I hit something.',
    LAST_HIT: 'Ticks since a bullet last hit me (-1 if never).',
    TICK: 'The match clock.',
    ENEMIES: 'How many enemies are still alive.',
    ARENA_W: 'How wide the arena is (800).',
    ARENA_H: 'How tall the arena is (600).',
    ALLIES: 'How many teammates are alive.',
    SCAN_RANGE: 'How far my last SCAN reached.',
    MUD: '1 if I\'m in mud, 0 if not.',
  };

  const REGISTER = 'A box that holds one number. Your robot has 8 of them: R0 to R7.';

  /** Jump words: [when it jumps, when it doesn't]. */
  const COND = {
    JE: ['equal to', 'not equal to'], JNE: ['not equal to', 'equal to'],
    JL: ['less than', 'not less than'], JLE: ['less than or equal to', 'greater than'],
    JG: ['greater than', 'not greater than'], JGE: ['greater than or equal to', 'less than'],
  };

  const VERBS = {
    MOV: 'Copy', ADD: 'Add', SUB: 'Subtract', MUL: 'Multiply', DIV: 'Divide', MOD: 'Remainder',
    INC: 'Count up', DEC: 'Count down', NEG: 'Flip the sign', ABS: 'Make it positive',
    MIN: 'Keep the smaller', MAX: 'Keep the bigger', AND: 'Bits', OR: 'Bits', XOR: 'Bits',
    RAND: 'Random pick', ATAN2: 'Angle toward a spot', SIN: 'Sine', COS: 'Cosine',
    SQRT: 'Square root', NORM: 'Shortest turn', POP: 'Take from the stack',
  };

  const DIRECTIONS = { 0: 'right', 90: 'down', 180: 'left', 270: 'up' };
  const direction = (deg) => {
    const d = ((deg % 360) + 360) % 360;
    return DIRECTIONS[d] ? `${deg}° (${DIRECTIONS[d]})` : `${deg}°`;
  };

  /**
   * Plain sentence for one VM trace entry. `cmp` is the latest CMP entry
   * earlier in the same trace, or null, so jumps can say why they jumped.
   */
  function traceNote(t, cmp) {
    if (t.fault) return `Crash! ${t.fault}`;
    switch (t.op) {
      case 'CMP': return `Compare ${t.x} with ${t.y}: ${t.x} is ${t.x < t.y ? 'less than' : t.x > t.y ? 'greater than' : 'equal to'} ${t.y}`;
      case 'JMP': return `Jump to line ${t.to}`;
      case 'CALL': return `Run the subroutine at line ${t.to}, then come back`;
      case 'RET': return `Subroutine done: back to line ${t.to}`;
      case 'WAIT': return 'Done for this tick';
      case 'HALT': return 'Program stopped for good';
      case 'NOP': return 'Do nothing';
      case 'GET': return `Read ${t.sensor}: ${t.dst} is now ${t.value}`;
      case 'SPEED': return `Drive at speed ${t.value}`;
      case 'TURN': return `Turn ${Math.abs(t.value)}° ${t.value < 0 ? 'left' : 'right'}`;
      case 'HEAD': return `Turn to face ${direction(t.value)}`;
      case 'AIM': return `Point the turret at ${direction(t.value)}`;
      case 'PUSH': return `Save ${t.value} on the stack`;
      case 'SCAN': return t.found < 0 ? `Look in a ${t.value}° cone: nobody found` : `Look in a ${t.value}° cone: enemy ${t.found} away!`;
      case 'RADAR': return t.found < 0 ? 'No bullets coming' : `A bullet is coming, ${t.found} away!`;
      case 'FIRE': return t.cooldown > 0 ? `Turret still reloading (${t.cooldown} more ticks)` : 'Fire!';
    }
    if (COND[t.op]) {
      const [yes, no] = COND[t.op];
      if (!cmp) return t.taken ? `The last CMP said yes, so jump to line ${t.to}` : 'The last CMP said no, so keep going';
      return t.taken ? `${cmp.x} is ${yes} ${cmp.y}, so jump to line ${t.to}` : `${cmp.x} is ${no} ${cmp.y}, so keep going`;
    }
    if (VERBS[t.op]) return `${VERBS[t.op]}: ${t.dst} is now ${t.value}`;
    return t.note;
  }

  /** Plain notes for a whole trace, in order. */
  function traceNotes(trace) {
    let cmp = null;
    return trace.map((t) => {
      const note = traceNote(t, cmp);
      if (t.op === 'CMP') cmp = t;
      return note;
    });
  }

  BB.explain = {
    instruction: (op) => INSTRUCTIONS[op] || null,
    sensor: (name) => SENSORS[name] || null,
    REGISTER,
    traceNote,
    traceNotes,
  };
})(globalThis.BB = globalThis.BB || {});
