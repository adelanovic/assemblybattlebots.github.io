/*
 * isa.js — Single source of truth for the Battle Bot assembly language.
 *
 * The assembler validates operands against these tables, the VM looks up
 * instruction costs here, and the in-app reference / docs/LANGUAGE.md are
 * generated from them. Keep descriptions aligned with VM and world behaviour.
 */
(function (BB) {
  'use strict';

  /** Simulation constants. Units: arena units, degrees, ticks. */
  const CONFIG = {
    ARENA_W: 800,
    ARENA_H: 600,
    ROBOT_RADIUS: 16,
    MAX_HEALTH: 100,

    CYCLES_PER_TICK: 50,   // identical instruction budget for every robot
    NUM_REGS: 8,           // R0..R7
    MEMORY_SIZE: 256,      // words, addresses 0..255
    STACK_SIZE: 64,        // shared by PUSH/POP and CALL/RET

    MAX_SPEED: 5,          // units per tick, forward
    MAX_REVERSE: -3,       // units per tick, backward
    ACCELERATION: 0.5,     // speed change per tick
    BODY_TURN_RATE: 8,     // degrees per tick
    TURRET_TURN_RATE: 20,  // degrees per tick

    FIRE_COOLDOWN: 15,     // ticks between shots
    BULLET_SPEED: 10,      // units per tick
    BULLET_DAMAGE: 10,

    SCAN_MAX_WIDTH: 90,    // degrees
    SCAN_RANGE_FACTOR: 2400, // scan range = floor(factor / sqrt(width)): 90° reaches 252, 16° 600
    RADAR_RANGE: 250,      // units
    MUD_MAX_SPEED: 2,      // speed cap, both directions, while your centre is in mud

    MAX_TICKS: 6000,       // time limit; highest health wins after this
  };

  /*
   * Operand kinds:
   *   dst    — register (R0..R7) or memory ([5], [R1], [R1+4])
   *   src    — register, memory, number or .def constant
   *   target — label (or absolute instruction index)
   *   sensor — sensor name, see SENSORS below
   */
  const INSTRUCTIONS = [
    // ---- Data movement ----
    { op: 'MOV', args: ['dst', 'src'], group: 'Data', summary: 'dst = src', example: 'MOV R0, [R1+2]' },
    { op: 'PUSH', args: ['src'], group: 'Data', summary: 'Push value onto the stack shared with CALL/RET (max 64 entries). Overflow faults.', example: 'PUSH R3' },
    { op: 'POP', args: ['dst'], group: 'Data', summary: 'Pop the top of the stack into dst. An empty stack faults.', example: 'POP R3' },

    // ---- Arithmetic (32-bit signed integers) ----
    { op: 'ADD', args: ['dst', 'src'], group: 'Arithmetic', summary: 'dst = dst + src', example: 'ADD R0, 5' },
    { op: 'SUB', args: ['dst', 'src'], group: 'Arithmetic', summary: 'dst = dst - src', example: 'SUB R0, R1' },
    { op: 'MUL', args: ['dst', 'src'], group: 'Arithmetic', summary: 'dst = dst * src', example: 'MUL R0, 3' },
    { op: 'DIV', args: ['dst', 'src'], group: 'Arithmetic', summary: 'dst = dst / src, truncated toward zero. Division by zero faults.', example: 'DIV R0, 2' },
    { op: 'MOD', args: ['dst', 'src'], group: 'Arithmetic', summary: 'dst = dst mod src. A nonzero result takes the sign of src; MOD R0, 360 gives 0..359. A zero divisor faults.', example: 'MOD R0, 360' },
    { op: 'INC', args: ['dst'], group: 'Arithmetic', summary: 'dst = dst + 1', example: 'INC R2' },
    { op: 'DEC', args: ['dst'], group: 'Arithmetic', summary: 'dst = dst - 1', example: 'DEC R2' },
    { op: 'NEG', args: ['dst'], group: 'Arithmetic', summary: 'dst = -dst', example: 'NEG R1' },
    { op: 'ABS', args: ['dst'], group: 'Arithmetic', summary: 'dst = |dst|', example: 'ABS R1' },
    { op: 'MIN', args: ['dst', 'src'], group: 'Arithmetic', summary: 'dst = min(dst, src)', example: 'MIN R0, 45' },
    { op: 'MAX', args: ['dst', 'src'], group: 'Arithmetic', summary: 'dst = max(dst, src)', example: 'MAX R0, -45' },
    { op: 'AND', args: ['dst', 'src'], group: 'Arithmetic', summary: 'Bitwise AND', example: 'AND R0, 1' },
    { op: 'OR', args: ['dst', 'src'], group: 'Arithmetic', summary: 'Bitwise OR', example: 'OR R0, 4' },
    { op: 'XOR', args: ['dst', 'src'], group: 'Arithmetic', summary: 'Bitwise XOR', example: 'XOR R0, R0' },
    { op: 'RAND', args: ['dst', 'src'], group: 'Arithmetic', summary: 'dst = random integer in 0..src-1 (src must be > 0). Each robot has its own stream, deterministic per match seed and roster slot.', example: 'RAND R0, 360' },

    // ---- Math helpers (angles in degrees) ----
    { op: 'ATAN2', args: ['dst', 'src', 'src'], group: 'Math', summary: 'dst = angle of vector (dx = 3rd, dy = 2nd) in degrees 0..359, using the arena angle convention.', example: 'ATAN2 R0, R2, R1' },
    { op: 'SIN', args: ['dst', 'src'], group: 'Math', summary: 'dst = round(sin(src degrees) * 1000)', example: 'SIN R1, R0' },
    { op: 'COS', args: ['dst', 'src'], group: 'Math', summary: 'dst = round(cos(src degrees) * 1000)', example: 'COS R1, R0' },
    { op: 'SQRT', args: ['dst', 'src'], group: 'Math', summary: 'dst = floor(sqrt(src)). Negative input faults.', example: 'SQRT R0, R0' },
    { op: 'NORM', args: ['dst'], group: 'Math', summary: 'Wrap an angle into -180..179. Turns "target - current" into the shortest signed turn.', example: 'NORM R0' },

    // ---- Comparison and flow control ----
    { op: 'CMP', args: ['src', 'src'], group: 'Flow', summary: 'Compare the first operand (a) with the second (b). The result persists until another CMP, including across jumps and ticks.', example: 'CMP R0, 100' },
    { op: 'JMP', args: ['target'], group: 'Flow', summary: 'Jump unconditionally.', example: 'JMP loop' },
    { op: 'JE', args: ['target'], group: 'Flow', summary: 'Jump if a == b (last CMP).', example: 'JE found' },
    { op: 'JNE', args: ['target'], group: 'Flow', summary: 'Jump if a != b.', example: 'JNE again' },
    { op: 'JL', args: ['target'], group: 'Flow', summary: 'Jump if a < b.', example: 'JL too_close' },
    { op: 'JLE', args: ['target'], group: 'Flow', summary: 'Jump if a <= b.', example: 'JLE ready' },
    { op: 'JG', args: ['target'], group: 'Flow', summary: 'Jump if a > b.', example: 'JG far' },
    { op: 'JGE', args: ['target'], group: 'Flow', summary: 'Jump if a >= b.', example: 'JGE far' },
    { op: 'CALL', args: ['target'], group: 'Flow', summary: 'Push the return address and jump to a function (subroutine).', example: 'CALL dodge' },
    { op: 'RET', args: [], group: 'Flow', summary: 'Return from a function (subroutine) by popping the return instruction index that CALL saved. It faults if the stack is empty, or if the top entry was saved by PUSH instead (a PUSH without its POP).', example: 'RET' },
    { op: 'NOP', args: [], group: 'Flow', summary: 'Do nothing (costs one cycle).', example: 'NOP' },
    { op: 'WAIT', args: [], group: 'Flow', summary: 'End this robot\'s turn for the current tick. Unused cycles are lost.', example: 'WAIT' },
    { op: 'HALT', args: [], group: 'Flow', summary: 'Stop the CPU until reset or program reload. The body continues following its last speed, heading and turret commands.', example: 'HALT' },

    // ---- Robot control ----
    { op: 'GET', args: ['dst', 'sensor'], group: 'Robot', summary: 'Read a sensor value into dst (see the sensor table).', example: 'GET R0, HEALTH' },
    { op: 'SPEED', args: ['src'], group: 'Robot', summary: 'Set the desired speed (-3..5 units/tick, clamped). The robot accelerates at 0.5 per tick.', example: 'SPEED 5' },
    { op: 'TURN', args: ['src'], group: 'Robot', summary: 'Set the desired heading to current heading + src degrees: positive turns right (clockwise), negative turns left. The body always takes the shorter way round, so TURN 270 turns 90° left, and TURN 180 turns around to the left. It turns at most 8°/tick.', example: 'TURN -90' },
    { op: 'HEAD', args: ['src'], group: 'Robot', summary: 'Set the desired absolute heading in degrees, reached the shorter way round. The body turns at most 8°/tick.', example: 'HEAD 180' },
    { op: 'AIM', args: ['src'], group: 'Robot', summary: 'Set the desired absolute turret angle. The turret turns at most 20°/tick, independently of the body.', example: 'AIM R1' },
    { op: 'FIRE', args: [], group: 'Robot', summary: 'Request one shot after movement and turret rotation this tick, if alive and COOLDOWN is 0. Multiple FIRE instructions in one tick still request only one shot.', example: 'FIRE' },
    { op: 'SCAN', args: ['src'], group: 'Robot', cost: 3, summary: 'Find the nearest living enemy whose body intersects a cone of src degrees (clamped to 1..90) around the current turret. Narrow cones reach farther: range = floor(2400 / sqrt(width)), so 90° reaches 252 units, 16° 600 and 4° 1200. Obstacles block the center-to-center view. The cone uses the turret\'s direction when SCAN runs: an AIM earlier in the same tick has not turned the turret yet. Updates SCAN_* immediately, including SCAN_RANGE; if nothing is found, SCAN_DIST is -1 and the other SCAN_* values are 0.', example: 'SCAN 20' },
    { op: 'RADAR', args: [], group: 'Robot', cost: 3, summary: 'Find the nearest enemy projectile within 250 units whose velocity points toward you. Obstacles do not block radar. Updates THREAT_* immediately; if none is found, THREAT_DIST is -1 and the other THREAT_* values are 0. Approaching does not guarantee a collision.', example: 'RADAR' },
  ];

  const SENSORS = [
    { name: 'X', desc: 'Your center x position, rounded (0 = left arena edge).' },
    { name: 'Y', desc: 'Your center y position, rounded (0 = top arena edge).' },
    { name: 'HEADING', desc: 'Your current body heading, 0..359.' },
    { name: 'SPEED', desc: 'Your current speed (rounded).' },
    { name: 'HEALTH', desc: 'Remaining health, rounded up, 0..100.' },
    { name: 'COOLDOWN', desc: 'Ticks until you can fire again (0 = ready).' },
    { name: 'TURRET', desc: 'Your current turret angle, 0..359.' },
    { name: 'SCAN_DIST', desc: 'Rounded center-to-center distance from the last SCAN, or -1 if none.' },
    { name: 'SCAN_ANGLE', desc: 'Absolute angle from you to that enemy (0 if the last SCAN found nothing).' },
    { name: 'SCAN_X', desc: 'That enemy\'s x position (0 if none).' },
    { name: 'SCAN_Y', desc: 'That enemy\'s y position (0 if none).' },
    { name: 'SCAN_HEADING', desc: 'That enemy\'s heading, to aim ahead of it (0 if none).' },
    { name: 'SCAN_SPEED', desc: 'That enemy\'s speed, rounded (0 if none).' },
    { name: 'THREAT_DIST', desc: 'Distance to the projectile found by the last RADAR, or -1.' },
    { name: 'THREAT_ANGLE', desc: 'Absolute angle from you to that projectile (0 if none).' },
    { name: 'THREAT_HEADING', desc: 'Direction that projectile is traveling (0 if none).' },
    { name: 'FRONT', desc: 'Rounded distance your whole circular body can travel along its current heading before touching a wall or obstacle. Other robots are not included.' },
    { name: 'LAST_HIT', desc: 'Ticks since you were last hit by a projectile, or -1 if never.' },
    { name: 'TICK', desc: 'Current simulation tick.' },
    { name: 'ENEMIES', desc: 'Number of enemy robots still alive (teammates excluded).' },
    { name: 'ARENA_W', desc: 'Arena width (800).' },
    { name: 'ARENA_H', desc: 'Arena height (600).' },
    { name: 'ALLIES', desc: 'Number of living teammates (always 0 in free-for-all).' },
    { name: 'SCAN_RANGE', desc: 'Center-to-center reach of the last SCAN, set by its width, or 0 before the first SCAN.' },
    { name: 'MUD', desc: '1 if your center is in mud (speed capped at 2 either way), otherwise 0.' },
  ];
  SENSORS.forEach((s, i) => { s.id = i; });

  const INSTRUCTION_MAP = Object.create(null);
  for (const ins of INSTRUCTIONS) {
    if (ins.cost === undefined) ins.cost = 1;
    INSTRUCTION_MAP[ins.op] = ins;
  }
  const SENSOR_MAP = Object.create(null);
  for (const s of SENSORS) SENSOR_MAP[s.name] = s;

  const APPEARANCE = {
    shape: { default: 'tank', choices: ['tank', 'circle', 'hexagon', 'wedge'] },
    drive: { default: 'tracks', choices: ['tracks', 'wheels', 'hover'] },
    turret: { default: 'standard', choices: ['standard', 'short', 'twin'] },
    // auto = the game picks (by roster slot). The names match World.COLORS, in order.
    color: { default: 'auto', choices: ['auto', 'red', 'blue', 'yellow', 'green', 'purple', 'orange', 'cyan', 'pink', 'white', 'gray', 'lime', 'indigo', 'brown'] },
    decal: { default: 'none', choices: ['none', 'stripes', 'flames', 'lightning', 'spots', 'checker'] },
    // `numbers`: a number from 1 to this is accepted too (team numbers, jersey style).
    badge: { default: 'none', choices: ['none', 'star', 'bolt', 'heart', 'crown', 'paw', 'shield'], numbers: 99 },
    trail: { default: 'none', choices: ['none', 'smoke', 'sparks', 'bubbles', 'rainbow'] },
    boom: { default: 'fire', choices: ['fire', 'confetti', 'pixels', 'fireworks'] }, // how it explodes when destroyed
    shot: { default: 'shell', choices: ['shell', 'laser', 'plasma', 'rocket', 'star'] }, // how its bullets look
  };

  const LANGUAGE_NOTES = [
    'Line 1 is the robot\'s name (required, truncated to 24 characters with a warning). The whole trimmed line is the name; do not add an inline comment. Leading ; or # markers are stripped. Code starts on line 2.',
    'Optional appearance header below the name: `.shape tank`, `.drive tracks`, `.turret standard`, `.color green`, `.decal stripes`, `.badge star` (or a number from 1 to 99), `.trail smoke`, `.boom confetti`, `.shot laser`. Each accepts a preset and may appear once, before any label, constant or instruction. Comments and blank lines are allowed between header directives. Appearance is cosmetic and uses no CPU cycles.',
    'From line 2 onward, comments start with `;` or `#` and continue to the end of the line. Blank lines are ignored. Mnemonics, registers, sensors, labels and constants are case-insensitive. Separate operands with commas.',
    'Labels end with a colon (`loop:`) and may share a line with an instruction. Names use letters, digits and underscores, starting with a letter or underscore. Labels and constants cannot share names or use instruction/register names.',
    'Constants: `.def NAME value` (`.const` and `.equ` are aliases). The value must be a numeric literal. Constants may be referenced before their definition and used as source values or memory addresses/offsets, but not as jump targets or sensor operands.',
    'Numbers are signed decimal (`-12`) or hexadecimal (`0x1F`). Literals and constants must fit -2147483648..2147483647. Values stored in registers, memory and the stack wrap to signed 32-bit integers; overflow does not fault.',
    'Registers `R0`..`R7` and all 256 memory words (`[0]`..`[255]`) start at 0. Address memory as `[12]`, `[R1]`, `[R1+4]`, `[R1-4]` or with a constant in place of the address/offset. Effective addresses outside 0..255 fault when accessed.',
    'When execution runs past the last instruction it wraps to the first, so a program is an implicit loop.',
    `Each robot gets at most ${CONFIG.CYCLES_PER_TICK} cycles per tick. Most instructions cost 1 cycle; SCAN and RADAR cost 3. An instruction that does not fit waits until the next tick. WAIT yields unused cycles; budget exhaustion resumes at the next pending instruction.`,
    'Angles: 0° points right (east), 90° points down (south), increasing clockwise. Positions use screen coordinates with (0,0) at the top-left.',
    'Runtime errors such as division by zero or a stack overflow fault the robot. Its CPU stops and the robot keeps drifting with its last orders. Other robots are unaffected.',
  ];

  BB.CONFIG = CONFIG;
  /** True if `value` is allowed for appearance setting `spec`: one of its presets, or (for .badge) a number like "7". */
  const appearanceAllows = (spec, value) => spec.choices.includes(value)
    || (!!spec.numbers && /^[1-9]\d*$/.test(String(value)) && Number(value) <= spec.numbers);

  BB.ISA = { INSTRUCTIONS, INSTRUCTION_MAP, SENSORS, SENSOR_MAP, LANGUAGE_NOTES, APPEARANCE, appearanceAllows };
})(globalThis.BB = globalThis.BB || {});
