#!/usr/bin/env node
// Minimal dependency-free test suite: node tests/run-tests.js
'use strict';
const assert = require('assert');
const BB = require('../tools/load-core')();

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

/** Run a program on a VM with a fake I/O and return the VM. */
function runVM(src, budget = 1000, ioOverrides = {}) {
  const res = BB.assemble(src);
  assert.deepStrictEqual(res.errors, [], 'unexpected assembly errors');
  const calls = [];
  const io = Object.assign({
    sense: () => 7, random: () => 0,
    speed: (v) => calls.push(['speed', v]), turn: (v) => calls.push(['turn', v]),
    head: (v) => calls.push(['head', v]), aim: (v) => calls.push(['aim', v]),
    fire: () => calls.push(['fire']), scan: (w) => calls.push(['scan', w]), radar: () => calls.push(['radar']),
  }, ioOverrides);
  const vm = new BB.VM(res.program, io);
  vm.calls = calls;
  vm.run(budget);
  return vm;
}

const errorsOf = (src) => BB.assemble(src).errors;

console.log('Assembler');
test('name is taken from line 1', () => {
  assert.strictEqual(BB.assemble('Robo Bob\nNOP').name, 'Robo Bob');
});
test('missing name is an error', () => {
  assert.match(errorsOf('\nNOP')[0].message, /Line 1/);
});
test('unknown instruction suggests a fix, with correct line number', () => {
  const e = errorsOf('Bot\nNOP\n  MOOV R0, 1');
  assert.strictEqual(e[0].line, 3);
  assert.match(e[0].message, /Did you mean MOV/);
});
test('wrong operand count', () => {
  assert.match(errorsOf('Bot\nADD R0')[0].message, /ADD needs 2 values, like "ADD R0, 5", but this line gives 1/);
  assert.match(errorsOf('Bot\nFIRE R0')[0].message, /FIRE doesn't take any values/);
});
test('common beginner slips get a message that says what to type', () => {
  const msg = (src) => BB.assemble(src).errors.map((e) => e.message).join(' ');
  assert.match(msg('T\nSPEED 2.5'), /whole numbers, so "2\.5" won't work\. Try 2 or 3/);
  assert.match(msg('T\n.def X 1.5\nNOP'), /whole numbers/);
  assert.match(msg('T\n// hello\nNOP'), /Comments start with ; or #, like "; hello"/);
  assert.match(msg('T\nMOV R0, #5'), /Numbers don't need a # in front.*Write "MOV R0, 5"/);
  assert.match(msg('T\nSPEED #5'), /Numbers don't need a # in front.*Write "SPEED 5"/, 'the only value');
  for (const fine of ['MOV R0, 5 ; options, #1 best', 'MOV R0, 5 # note 2', 'AIM R1 # 45 degrees', 'FIRE #1 shot']) {
    assert.deepStrictEqual(BB.assemble(`T\n${fine}\nHALT`).errors, [], `a real comment: ${fine}`);
  }
  assert.match(msg('T\nmain: JMP R0'), /needs a label to jump to.*can't jump to a register/);
  assert.match(msg('T\nMOV R0, “5”'), /Values don't go in quotes: write 5/);
  assert.match(msg('T\nMOV R0, 5； hi'), /isn't a plain ";"/);
  assert.match(msg('T\nMOV R0, [-4]'), /Memory slots go from \[0\] to \[255\], so \[-4\]/);
  assert.match(msg('T\nMOV R0, [4+R1]'), /the register comes first: write \[R1\+4\]/);
});
test('second-review messages: // anywhere, misspelled settings, two-register memory, RET after a stolen return', () => {
  const msg = (src) => BB.assemble(src).errors.map((e) => e.message).join(' ');
  assert.match(msg('T\nmain: NOP\nJMP main // back'), /"\/\/" doesn't start a comment here.*like "JMP main ; back"/);
  assert.match(msg('T\nWAIT // done'), /like "WAIT ; done"/);
  assert.deepStrictEqual(BB.assemble('T\nMOV R0, 5 ; a // b\nHALT').errors, [], '// inside a real comment is fine');
  assert.match(msg('T\n.colour red\nWAIT'), /Unknown setting "\.colour"\. Did you mean \.color\?.*\.shot/);
  assert.match(msg('T\nMOV R0, [R1+R2]'), /can only use one/);
  assert.match(msg('T\nMOV R0, [5-R1]'), /can't subtract a register/);
  assert.match(msg('T\nMOV R0, [5+R1]'), /write \[R1\+5\]/);
  const crash = (src) => { const vm = new BB.VM(BB.assemble(src).program, { sense: () => 0 }); vm.run(100); return vm.fault; };
  assert.match(crash('T\nPUSH 5\nCALL f\nHALT\nf: POP R1\nRET'), /The POP on line 5 took the place to go back to/);
  assert.match(crash('T\nCALL f\nHALT\nf: POP R1\nRET'), /RET has nowhere to go back to\. The POP on line 4/);
  assert.match(crash('T\nCALL f\nHALT\nf: PUSH R1\nRET'), /Every PUSH in a function needs a POP before RET/, 'the PUSH mistake keeps its own message');
});
test('invisible characters: a zero-width space can stand for a space, emoji names stay whole, a BOM is silent', () => {
  for (const line of ['MOV​R0, 5', 'MO​V R0, 5', 'loop:​WAIT']) {
    assert.deepStrictEqual(BB.assemble(`T\n${line}\nHALT`).errors, [], JSON.stringify(line));
  }
  const family = '\u{1F468}‍\u{1F469}‍\u{1F467} Fam';
  assert.strictEqual(BB.assemble(`${family}\nHALT`).name, family);
  assert.deepStrictEqual(BB.assemble('﻿Bot\nHALT').warnings, []);
});
test('invisible characters from pasted documents are skipped, with a warning', () => {
  const res = BB.assemble('T\nMOV R0,​ 5\nHALT');
  assert.deepStrictEqual(res.errors, []);
  assert.match(res.warnings[0].message, /invisible character/);
  assert.strictEqual(res.warnings[0].line, 2);
});
test('a constant plus a number is a fixed memory address', () => {
  const vm = runVM('T\n.def BASE 10\nMOV [BASE+4], 7\nMOV R0, [14]\nHALT');
  assert.strictEqual(vm.regs[0], 7);
  assert.match(errorsOf('T\n.def BASE 250\nMOV R0, [BASE+10]')[0].message, /\[260\] would crash/);
});
test('undefined label', () => {
  assert.match(errorsOf('Bot\nJMP nowhere')[0].message, /Unknown label/);
});
test('duplicate label', () => {
  assert.match(errorsOf('Bot\na:\nA: NOP')[0].message, /"A" is already used on line 2\. .*upper and lower case count as the same name/);
  assert.match(errorsOf('Bot\n.def A 1\n.def a 2\nNOP')[0].message, /"a" is already used on line 2/);
});
test('immediate cannot be a destination', () => {
  assert.match(errorsOf('Bot\nMOV 5, R0')[0].message, /must be a register or memory/);
});
test('bad register', () => {
  assert.match(errorsOf('Bot\nMOV R9, 1')[0].message, /Registers are R0..R7/);
});
test('sensor used as a value gets a GET hint', () => {
  assert.match(errorsOf('Bot\nMOV R0, HEALTH')[0].message, /GET R0, HEALTH/);
});
test('unknown sensor', () => {
  assert.match(errorsOf('Bot\nGET R0, HELTH')[0].message, /Did you mean HEALTH/);
});
test('empty program', () => {
  assert.match(errorsOf('Bot\n; nothing')[0].message, /no instructions/);
});
test('multiple errors are all reported', () => {
  assert.strictEqual(errorsOf('Bot\nFOO\nBAR\nMOV R0').length, 3);
});
test('beginner mistakes get specific, correct help', () => {
  const msg = (src) => BB.assemble(src).errors.map((e) => e.message).join(' ');
  assert.match(msg('T\nGET R0, 5'), /must be a sensor name, such as HEALTH/);
  assert.match(msg('T\nGET R0, R1'), /must be a sensor name/);
  assert.doesNotMatch(msg('T\nGET R0, 5'), /Did you mean/);
  assert.match(msg('T\nx: MOV R0, x'), /Labels can only be used as jump targets/);
  assert.doesNotMatch(msg('T\nx: MOV R0, x'), /GET/);
  assert.match(msg('T\nIF R0 > 5'), /no IF: compare with CMP/);
  assert.match(msg('T\nSHOOT'), /Use FIRE/);
  assert.match(msg('T\nMOV R0, 5 // five'), /Comments start with ; or #/);
  assert.match(msg('T\nMOV R0, [R1'), /missing its closing \]/);
  assert.match(msg('T\nMOV R0,,5'), /extra comma/);
  assert.match(msg('T\nMOV R0, 5,'), /extra comma/);
  assert.match(msg('T\nSPED 5'), /Did you mean SPEED\?/);
  assert.match(msg('T\nmain:\nJMP mian'), /Did you mean MAIN\?/);
  const named = BB.assemble('Bot ; my robot\nWAIT');
  assert.deepStrictEqual([named.name, named.errors.length], ['Bot ; my robot', 0]);
  assert.match(named.warnings[0].message, /Put comments on line 2 or later/);
});
test('more beginner slips get a specific fix, and code that always crashes is caught first', () => {
  const msg = (src) => BB.assemble(src).errors.map((e) => e.message).join(' ');
  const warn = (src) => BB.assemble(src).warnings.map((e) => e.message).join(' ');
  // A label without its colon: one clear error, not "Did you mean MIN?" plus an "Unknown label" at the jump.
  const colonless = errorsOf('T\nmain\n    SPEED 5\n    JMP main');
  assert.strictEqual(colonless.length, 1);
  assert.match(colonless[0].message, /"main" is used as a label, so it needs a colon at the end: write "main:"/);
  assert.match(msg('T\nloop\n    JMP loop'), /needs a colon/, 'even a word with its own beginner tip');
  assert.match(msg('T\nmain\n    WAIT'), /Did you mean MIN\? Or, if it's a label, add a colon/);
  assert.match(msg('T\nbanana'), /If it's a label, add a colon at the end: "banana:"/);
  // Spaces where commas belong.
  assert.match(msg('T\nMOV R0 5'), /Did you forget a comma\? Write "MOV R0, 5"/);
  assert.match(msg('T\nGET R0 HEALTH'), /Write "GET R0, HEALTH"/);
  assert.match(msg('T\nCMP R0 < 5'), /Put a comma between operands/);
  assert.match(msg('T\nMOV R0\uFF0C 5'), /The "\uFF0C" isn't a plain comma: type the , key instead/);
  // "=" from other languages.
  assert.match(msg('T\nR0 = 5'), /no "="\. Use MOV, like "MOV R0, 5"/);
  assert.match(msg('T\nR1 += 2'), /Use ADD, like "ADD R1, 2"/);
  // Dashes pasted from a document instead of a minus sign.
  assert.match(msg('T\nTURN \u201390'), /copied from a document, not a minus sign\. Type the - key instead: "-90"/);
  assert.match(msg('T\nMOV R0, [R1\u20134]'), /Type the - key instead: "\[R1-4\]"/);
  assert.match(msg('T\n.def BACK \u22123'), /Type the - key instead: "\.def BACK -3"/);
  // Directives in the wrong shape or place.
  assert.match(msg('T\nloop: .shape tank\n    WAIT'), /\.shape must appear in the appearance header/);
  assert.match(msg('T\n.def FAST, 4\n    SPEED 4'), /\.def doesn't use commas\. Write "\.def FAST 4"/);
  // Crashes that would happen every time are errors before the match.
  assert.match(msg('T\nDIV R0, 0'), /DIV by 0 would crash your robot/);
  assert.match(msg('T\n.def NONE 0\nMOD R0, NONE'), /MOD by 0 would crash your robot/);
  assert.match(msg('T\nRAND R0, 0'), /RAND needs a number bigger than 0, like "RAND R0, 360"/);
  assert.match(msg('T\nSQRT R0, -4'), /SQRT of a negative number would crash/);
  assert.match(msg('T\nMOV R0, [300]'), /Memory slots go from \[0\] to \[255\], so \[300\] would crash/);
  assert.deepStrictEqual(errorsOf('T\nMOV R1, 300\nMOV R0, [R1]'), [], 'an address in a register is checked when it runs');
  // Warnings explain a surprise but still let the code run.
  for (const [src, re] of [
    ['T\nSPEED 10', /"SPEED 10" drives at 5: SPEED goes from -3 to 5/],
    ['T\n.def FAST 9\nSPEED FAST', /"SPEED FAST" \(FAST is 9\) drives at 5/],
    ['T\nSCAN 360', /"SCAN 360" looks 90° wide/],
    ['T\nSCAN 0', /looks 1° wide/],
    ['T\nJMP 3\nWAIT\nWAIT\nWAIT', /"JMP 3" goes to instruction number 3 \(counting from 0\), not line 3/],
  ]) {
    const res = BB.assemble(src);
    assert.deepStrictEqual([res.errors.length, res.program.length > 0], [0, true], src);
    assert.match(warn(src), re, src);
  }
  assert.strictEqual(warn('T\nSPEED 5\nSCAN 90\nSPEED -3\nSCAN 1'), '', 'the limits themselves are fine');
});
test('code on the name line gets a warning; ordinary names do not', () => {
  const warn = (src) => BB.assemble(src).warnings.map((w) => w.message).join(' ');
  for (const line of ['main:', 'SPEED 5', 'GET R0, HEALTH', '.shape tank', 'JMP main', 'loop: WAIT']) {
    assert.match(warn(`${line}\nmain:\n    WAIT\n    JMP main`), /Line 1 is only your robot's name, so ".+" won't run as code/, line);
  }
  for (const name of ['Rookie', 'Fire Ant', 'Turn Left', 'Wait', 'Mission 1: drive', 'Head Hunter', 'Call Me Maybe', 'R2D2']) {
    assert.doesNotMatch(warn(`${name}\nWAIT`), /won't run as code/, name);
  }
  const lost = errorsOf('main:\n    SPEED 5\n    WAIT\n    JMP main');
  assert.match(lost[0].message, /Unknown label "main"\. Line 1 is your robot's name, so the "main:" there doesn't count as a label/);
});

test('every example assembles cleanly', () => {
  for (const ex of BB.EXAMPLES) assert.deepStrictEqual(errorsOf(ex.source), [], ex.file);
});
test('the "+ New robot" template assembles cleanly', () => {
  assert.deepStrictEqual(errorsOf(BB.NEW_ROBOT_TEMPLATE), []);
  assert.match(BB.NEW_ROBOT_TEMPLATE.trimEnd(), /JMP\s+main$/, 'loops back on purpose, not by running off the end');
});
test('a label named after an instruction is one error, not one per jump', () => {
  const e = errorsOf('Bot\nJMP turn\nJL turn\nturn: NOP');
  assert.strictEqual(e.length, 1);
  assert.strictEqual(e[0].line, 4);
  assert.match(e[0].message, /is an instruction/);
});

console.log('VM');
test('arithmetic, constants and memory', () => {
  const vm = runVM(`T
.def K 5
MOV R0, K
MUL R0, 3
SUB R0, 1
MOV R1, 2
MOV [R1+3], R0
MOV R2, [5]
DIV R2, 4
MOV R3, -7
MOD R3, 360
HALT`);
  assert.strictEqual(vm.regs[0], 14);
  assert.strictEqual(vm.mem[5], 14);
  assert.strictEqual(vm.regs[2], 3);
  assert.strictEqual(vm.regs[3], 353);
});
test('compare, conditional jumps and loops', () => {
  const vm = runVM(`T
MOV R0, 0
loop:
INC R0
CMP R0, 10
JL loop
HALT`);
  assert.strictEqual(vm.regs[0], 10);
});
test('CALL / RET and the stack', () => {
  const vm = runVM(`T
CALL f
MOV R1, 1
HALT
f: PUSH 42
POP R2
RET`);
  assert.deepStrictEqual([vm.regs[1], vm.regs[2], vm.halted], [1, 42, true]);
});
test('math helpers', () => {
  const vm = runVM(`T
ATAN2 R0, 10, 0
ATAN2 R1, -1, 0
COS R2, 60
SQRT R3, 50
MOV R4, 270
NORM R4
HALT`);
  assert.deepStrictEqual([...vm.regs.slice(0, 5)], [90, 270, 500, 7, -90]);
});
test('instruction budget is enforced (infinite loop)', () => {
  const vm = runVM('T\nloop: JMP loop', 50);
  assert.strictEqual(vm.totalCycles, 50);
  assert.strictEqual(vm.halted, false);
});
test('WAIT yields the rest of the tick', () => {
  const vm = runVM('T\nINC R0\nWAIT', 50);
  assert.strictEqual(vm.regs[0], 1);
});
test('RET can no longer jump to a made-up address like a PUSHed -1', () => {
  const vm = runVM('T\nPUSH -1\nRET', 2);
  assert.strictEqual(vm.faultLine, 3);
  assert.match(vm.fault, /RET found a value saved by PUSH/);
});
test('a fault records the source line for the editor marker', () => {
  const vm = runVM('T\nMOV R0, 1\n\nDIV R0, R1');
  assert.strictEqual(vm.faultLine, 4);
});
test('counts record how often each instruction ran', () => {
  const vm = runVM('T\nloop: INC R0\n\nCMP R0, 3\nJL loop\nHALT');
  assert.deepStrictEqual([...vm.counts], [3, 3, 3, 1]);
});
test('a breakpoint stops before its line, then resumes past it on the next run', () => {
  const vm = new BB.VM(BB.assemble('T\nINC R0\nINC R1\nWAIT').program, {});
  vm.breakLines = new Set([3]);
  vm.run(50);
  assert.deepStrictEqual([vm.breakHit, vm.currentLine, vm.regs[0], vm.regs[1]], [3, 3, 1, 0]);
  vm.run(50); // runs line 3 without stopping again, then WAITs
  assert.deepStrictEqual([vm.breakHit, vm.regs[0], vm.regs[1]], [0, 1, 1]);
  vm.run(50); // stops again on the next pass
  assert.deepStrictEqual([vm.breakHit, vm.regs[0], vm.regs[1]], [3, 2, 1]);
});
test('a breakpoint on the first line of a tick still stops every pass', () => {
  const vm = new BB.VM(BB.assemble('T\nINC R0\nWAIT').program, {});
  vm.breakLines = new Set([2]);
  assert.strictEqual(vm.run(50), 0);
  assert.deepStrictEqual([vm.breakHit, vm.regs[0]], [2, 0]);
  vm.run(50);
  assert.deepStrictEqual([vm.breakHit, vm.regs[0]], [0, 1]);
  vm.run(50);
  assert.deepStrictEqual([vm.breakHit, vm.regs[0]], [2, 1]);
});
test('trace notes what each instruction did, and why the turn ended', () => {
  const traced = (src, budget = 50) => {
    const vm = new BB.VM(BB.assemble(src).program, { speed() {} });
    vm.trace = [];
    vm.run(budget);
    return vm;
  };
  let vm = traced('T\n.def LIMIT 2\nloop: INC R0 ; count\nCMP R0, LIMIT\nJL loop\nMOV [R0+1], R0\nSPEED R0\nWAIT');
  assert.deepStrictEqual(vm.trace.map((t) => t.note),
    ['R0 = 1', '1 < 2', 'jump to line 3', 'R0 = 2', '2 = 2', 'no jump', '[3] = 2', 'value 2', 'end of turn']);
  assert.deepStrictEqual([vm.trace[0].line, vm.trace[0].asm, vm.trace[1].asm, vm.lastStop], [3, 'INC R0', 'CMP R0, LIMIT', 'wait']);
  vm = traced('T\nCALL f\nHALT\nf: RET');
  assert.deepStrictEqual([vm.trace.map((t) => t.note), vm.lastStop], [['call line 4', 'return to line 3', 'CPU stopped'], 'halt']);
  vm = traced('T\nl: JMP l', 5);
  assert.deepStrictEqual([vm.trace.length, vm.trace[0].note, vm.lastStop], [5, 'jump to line 2', 'budget']);
  vm = traced('T\nDIV R0, R1');
  assert.deepStrictEqual([vm.trace.map((t) => t.note), vm.lastStop], [['division by zero.'], 'fault']);
  vm = new BB.VM(BB.assemble('T\nINC R0\nWAIT').program, {});
  vm.run(50);
  assert.strictEqual(vm.trace, null, 'off unless enabled');
});
test('program wraps around at the end', () => {
  const vm = runVM('T\nINC R0', 10);
  assert.strictEqual(vm.regs[0], 10);
});
test('division by zero faults with line number', () => {
  const vm = runVM('T\nMOV R0, 1\nDIV R0, R1');
  assert.ok(vm.halted);
  assert.match(vm.fault, /Line 3: division by zero/);
});
test('AND, OR and XOR work bit by bit', () => {
  const vm = runVM('T\nMOV R0, 12\nAND R0, 10\nMOV R1, 12\nOR R1, 10\nMOV R2, 12\nXOR R2, 10\nMOV R3, -1\nXOR R3, 5\nHALT');
  assert.deepStrictEqual([...vm.regs.slice(0, 4)], [8, 14, 6, -6]);
});
test('stack overflow faults', () => {
  const vm = runVM('T\nf: CALL f');
  assert.match(vm.fault, /stack overflow/);
});
test('RET onto a PUSHed value faults at once instead of jumping to it', () => {
  const vm = runVM('T\nmain: CALL f\nHALT\nf: PUSH R1\nRET');
  assert.match(vm.fault, /Line 5: RET found a value saved by PUSH/);
  const ok = runVM('T\nmain: CALL f\nHALT\nf: PUSH R1\nPOP R1\nRET');
  assert.ok(ok.halted && !ok.fault, 'a matching POP before RET is fine');
});
test('out-of-range memory faults', () => {
  const vm = runVM('T\nMOV R0, 300\nMOV [R0], 1');
  assert.match(vm.fault, /out of range/);
});
test('robot actions go through io', () => {
  const vm = runVM('T\nSPEED 5\nAIM 90\nFIRE\nGET R0, HEALTH\nHALT');
  assert.deepStrictEqual(vm.calls, [['speed', 5], ['aim', 90], ['fire']]);
  assert.strictEqual(vm.regs[0], 7);
});

console.log('World');
const compile = (src, id) => { const r = BB.assemble(src); return { id, name: r.name, program: r.program, appearance: r.appearance }; };
test('a faulty / looping robot does not affect others', () => {
  const looper = compile('Looper\nl: JMP l', 0);
  const crasher = compile('Crasher\nDIV R0, R1', 1);
  const mover = compile('Mover\nSPEED 5\nWAIT', 2);
  const w = new BB.World({ entries: [looper, crasher, mover], seed: 3 });
  const start = { x: w.robots[2].x, y: w.robots[2].y };
  for (let i = 0; i < 30; i++) w.step();
  assert.ok(w.robots[1].vm.fault);
  assert.ok(!w.robots[0].vm.fault);
  assert.ok(Math.hypot(w.robots[2].x - start.x, w.robots[2].y - start.y) > 20, 'mover should have moved');
});
test('every robot gets the same budget per tick', () => {
  const a = compile('A\nl: JMP l', 0), b = compile('B\nl: INC R0\nJMP l', 1);
  const w = new BB.World({ entries: [a, b], seed: 1 });
  for (let i = 0; i < 10; i++) w.step();
  assert.strictEqual(w.robots[0].vm.totalCycles, 10 * BB.CONFIG.CYCLES_PER_TICK);
  assert.strictEqual(w.robots[1].vm.totalCycles, 10 * BB.CONFIG.CYCLES_PER_TICK);
});
test('firing at a stationary target destroys it and ends the match', () => {
  const marksman = compile(`Marksman
l: SCAN 6
GET R0, SCAN_DIST
CMP R0, 0
JL spin
GET R1, SCAN_ANGLE
AIM R1
FIRE
WAIT
JMP l
spin: GET R1, TURRET
ADD R1, 6
AIM R1
WAIT
JMP l`, 0);
  const dummy = compile('Dummy\nWAIT', 1);
  // Seed search: ensure the two have line of sight at some point; they are static so pick a seed that works.
  let won = false;
  for (let seed = 1; seed <= 10 && !won; seed++) {
    const w = new BB.World({ entries: [marksman, dummy], seed });
    while (!w.over) w.step();
    won = w.winner && w.winner.name === 'Marksman' && !w.robots[1].alive;
  }
  assert.ok(won);
});
test('simulation is deterministic for a seed', () => {
  const entries = BB.EXAMPLES.map((e, i) => compile(e.source, i));
  const run = () => { const w = new BB.World({ entries, seed: 42 }); for (let i = 0; i < 800; i++) w.step(); return w.robots.map((r) => [r.x, r.y, r.health]); };
  assert.deepStrictEqual(run(), run());
});
test('example free-for-all always terminates with a result', () => {
  const entries = BB.EXAMPLES.map((e, i) => compile(e.source, i));
  for (let seed = 1; seed <= 10; seed++) {
    const w = new BB.World({ entries, seed });
    while (!w.over) w.step();
    assert.ok(w.tick <= BB.CONFIG.MAX_TICKS);
    for (const r of w.robots) assert.strictEqual(r.vm.fault, null, `${r.name} faulted: ${r.vm.fault}`);
  }
});

/** A world on the open arena with `robots` placed by hand: [{ src, x, y, heading, speed, health, team }]. */
function placed(robots) {
  const w = new BB.World({ entries: robots.map((r, i) => ({ ...compile(r.src || `R${i}\nl: WAIT\nJMP l`, i), team: r.team ?? null })), arena: 'open' });
  robots.forEach((p, i) => {
    const r = w.robots[i];
    Object.assign(r, { x: p.x, y: p.y });
    r.heading = r.targetHeading = r.turret = r.targetTurret = p.heading || 0;
    r.speed = r.targetSpeed = p.speed || 0;
    if (p.health !== undefined) r.health = p.health;
  });
  return w;
}
const sensor = (w, r, name) => w.sense(r, BB.ISA.SENSOR_MAP[name].id);

test('.color: first come, first served; auto robots step aside; teams keep team colors', () => {
  const { COLORS, COLOR_NAMES } = BB.World;
  assert.deepStrictEqual(BB.ISA.APPEARANCE.color.choices, ['auto', ...COLOR_NAMES], 'every choice has a color, in order');
  const entry = (src, id, team = null) => ({ ...compile(src, id), team });
  const nameOf = (r) => COLOR_NAMES[COLORS.indexOf(r.color)];
  const w = new BB.World({ entries: [entry('A\nWAIT', 0), entry('B\n.color red\nWAIT', 1), entry('C\n.color red\nWAIT', 2), entry('D\nWAIT', 3)], arena: 'open' });
  assert.deepStrictEqual(w.robots.map(nameOf), ['blue', 'red', 'yellow', 'green'], 'B claims red; A (auto) and C move to the next free color');
  assert.ok(w.log.some((l) => l.text === 'C chose red, but B already has it, so C is yellow.'), 'the loser is told why');
  const plain = new BB.World({ entries: [0, 1, 2].map((i) => entry(`R${i}\nWAIT`, i)), arena: 'open' });
  assert.deepStrictEqual(plain.robots.map(nameOf), ['red', 'blue', 'yellow'], 'no choices: the same slot colors as always');
  const teams = new BB.World({ entries: [entry('A\n.color pink\nWAIT', 0, 0), entry('B\nWAIT', 1, 1)], arena: 'open' });
  assert.deepStrictEqual(teams.robots.map((r) => r.color), [BB.World.TEAM_COLORS[0][0], BB.World.TEAM_COLORS[1][0]]);
  assert.ok(teams.log.some((l) => /\.color is ignored/.test(l.text)));
  // Mid-match Apply: take a newly chosen color only if it is free.
  const r0 = w.robots[0];
  r0.appearance = { ...r0.appearance, color: 'purple' };
  w.recolor(r0);
  assert.strictEqual(nameOf(r0), 'purple');
  r0.appearance = { ...r0.appearance, color: 'red' };
  w.recolor(r0);
  assert.strictEqual(nameOf(r0), 'purple', 'red is B\'s');
});
test('driving into a wall costs floor(|speed| / 2) health and stops the robot', () => {
  const { ARENA_W: W, ROBOT_RADIUS: R, MAX_HEALTH } = BB.CONFIG;
  for (const [speed, lost] of [[5, 2], [3, 1], [1, 0]]) {
    const w = placed([{ x: W - R - 0.5, y: 300, heading: 0, speed }]);
    w.step();
    assert.strictEqual(w.robots[0].health, MAX_HEALTH - lost, `speed ${speed}`);
    assert.strictEqual(w.robots[0].speed, 0);
  }
});
test('ramming costs both robots 1 health, but only when they close faster than 1 unit a tick', () => {
  const { ROBOT_RADIUS: R, MAX_HEALTH } = BB.CONFIG;
  const bump = (speed) => {
    const w = placed([{ x: 300, y: 300, heading: 0, speed }, { x: 300 + 2 * R + 0.5, y: 300, heading: 180, speed }]);
    w.step();
    return w.robots.map((r) => MAX_HEALTH - r.health);
  };
  assert.deepStrictEqual(bump(2), [1, 1], 'closing at 4');
  assert.deepStrictEqual(bump(0.4), [0, 0], 'closing at 0.8: a gentle touch');
});
test('time limit: highest health wins, equal health is a draw, teams compare total health', () => {
  const end = (robots) => { const w = placed(robots); w.tick = BB.CONFIG.MAX_TICKS - 1; w.step(); return w; };
  const won = end([{ x: 100, y: 100, health: 40 }, { x: 600, y: 500, health: 70 }]);
  assert.ok(won.over && won.winner === won.robots[1]);
  const tie = end([{ x: 100, y: 100, health: 50 }, { x: 600, y: 500, health: 50 }]);
  assert.ok(tie.over && tie.winner === null, 'equal health: draw');
  const teams = end([{ x: 100, y: 100, health: 90, team: 0 }, { x: 100, y: 500, health: 10, team: 0 },
    { x: 700, y: 100, health: 60, team: 1 }, { x: 700, y: 500, health: 60, team: 1 }]);
  assert.strictEqual(teams.winnerTeam, 1, '100 vs 120 total: team B, though team A has the healthiest robot');
});
test('LAST_HIT counts ticks since the last shot hit, and is -1 before any', () => {
  const w = placed([{ x: 100, y: 300 }, { x: 600, y: 300 }]);
  const [me, other] = w.robots;
  assert.strictEqual(sensor(w, me, 'LAST_HIT'), -1);
  w.damage(me, 10, other, 'wall');
  assert.strictEqual(sensor(w, me, 'LAST_HIT'), -1, 'only shots count');
  w.damage(me, 10, other, 'shot');
  for (let i = 0; i < 7; i++) w.step();
  assert.strictEqual(sensor(w, me, 'LAST_HIT'), 7);
});
test('SCAN reports the found robot\'s heading and speed', () => {
  const w = placed([{ x: 200, y: 300, heading: 0 }, { x: 400, y: 300, heading: 90, speed: 3 }]);
  w.doScan(w.robots[0], 10);
  assert.deepStrictEqual(['SCAN_DIST', 'SCAN_HEADING', 'SCAN_SPEED'].map((s) => sensor(w, w.robots[0], s)), [200, 90, 3]);
});

test('FRONT is not 0 when touching an obstacle corner while facing away from it', () => {
  const box = { x: 100, y: 100, w: 50, h: 50 }, R = BB.CONFIG.ROBOT_RADIUS, a = -135 * BB.geo.DEG;
  // A hair inside the corner's circle, as rounding leaves a robot pushed out of the corner.
  const ox = 100 + Math.cos(a) * (R - 1e-9), oy = 100 + Math.sin(a) * (R - 1e-9);
  assert.strictEqual(BB.geo.sweptCircleRect(ox, oy, Math.cos(a), Math.sin(a), R, box), Infinity, 'facing away');
  assert.strictEqual(BB.geo.sweptCircleRect(ox, oy, -Math.cos(a), -Math.sin(a), R, box), 0, 'facing the corner');
});

console.log('Arenas');
const SEEDS = Array.from({ length: 500 }, (_, i) => i + 1);
const randomMap = (seed) => BB.World.makeObstacles('random', seed);
test('random arenas are reproducible from the seed and vary between seeds', () => {
  assert.deepStrictEqual(randomMap(7), randomMap(7));
  const distinct = new Set(SEEDS.slice(0, 50).map((s) => JSON.stringify(randomMap(s))));
  assert.ok(distinct.size > 45, `only ${distinct.size} distinct maps`);
});
test('random arenas are point-symmetric (every obstacle has a mirrored twin)', () => {
  const { ARENA_W: W, ARENA_H: H } = BB.CONFIG;
  for (const s of SEEDS) {
    const m = randomMap(s);
    assert.ok(m.length >= 4, `seed ${s}: only ${m.length} obstacles`);
    for (const o of m) {
      assert.ok(m.some((t) => t.x === W - o.x - o.w && t.y === H - o.y - o.h && t.w === o.w && t.h === o.h), `seed ${s}: no twin`);
    }
  }
});
test('random arenas respect thickness and coverage limits', () => {
  const { ARENA_W: W, ARENA_H: H } = BB.CONFIG;
  for (const s of SEEDS) {
    const m = randomMap(s);
    for (const o of m) assert.ok(o.w >= 20 && o.h >= 20, `seed ${s}: thin obstacle`);
    const area = m.reduce((a, o) => a + o.w * o.h, 0);
    assert.ok(area / (W * H) <= 0.11, `seed ${s}: coverage ${area / (W * H)}`);
  }
});
test('random arenas have no sealed-off areas (flood fill of robot positions)', () => {
  const { ARENA_W: W, ARENA_H: H, ROBOT_RADIUS: R } = BB.CONFIG;
  const STEP = 4;
  const cols = Math.floor(W / STEP), rows = Math.floor(H / STEP);
  for (const s of SEEDS) {
    const m = randomMap(s);
    const free = new Uint8Array(cols * rows);
    let total = 0, start = -1;
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const x = i * STEP + STEP / 2, y = j * STEP + STEP / 2;
      if (x < R || y < R || x > W - R || y > H - R) continue;
      if (m.some((o) => BB.geo.circleRectPush(x, y, R, o))) continue;
      free[j * cols + i] = 1; total++;
      if (start < 0) start = j * cols + i;
    }
    const seen = new Uint8Array(cols * rows);
    const queue = [start]; seen[start] = 1;
    let reached = 0;
    while (queue.length) {
      const c = queue.pop(); reached++;
      const i = c % cols, j = (c - i) / cols;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di, nj = j + dj, n = nj * cols + ni;
        if (ni >= 0 && nj >= 0 && ni < cols && nj < rows && free[n] && !seen[n]) { seen[n] = 1; queue.push(n); }
      }
    }
    assert.strictEqual(reached, total, `seed ${s}: ${total - reached} unreachable cells`);
  }
});
test('robots spawn clear of obstacles on random arenas', () => {
  const entries = BB.EXAMPLES.map((e, i) => compile(e.source, i));
  for (const s of SEEDS.slice(0, 100)) {
    const w = new BB.World({ entries, seed: s, arena: 'random' });
    for (const r of w.robots) {
      assert.ok(w.obstacles.every((o) => !BB.geo.circleRectPush(r.x, r.y, BB.CONFIG.ROBOT_RADIUS, o)), `seed ${s}: ${r.name} spawned in an obstacle`);
    }
  }
});
test('open arena has no obstacles, classic is unchanged', () => {
  assert.strictEqual(BB.World.makeObstacles('open', 1).length, 0);
  assert.deepStrictEqual(BB.World.makeObstacles('classic', 99), BB.World.DEFAULT_OBSTACLES);
});

console.log('Teams');
const teamEntry = (src, id, team) => ({ ...compile(src, id), team });
test('team B spawns as the mirror image of team A', () => {
  const ex = BB.EXAMPLES.map((e) => e.source);
  for (const arena of ['classic', 'random', 'open']) {
    for (const seed of [1, 2, 3, 4, 5]) {
      const entries = [0, 1, 2, 3, 4, 5].map((i) => teamEntry(ex[i % 4], i, i < 3 ? 0 : 1));
      const w = new BB.World({ entries, seed, arena });
      const a = w.robots.filter((r) => r.team === 0), b = w.robots.filter((r) => r.team === 1);
      a.forEach((r, i) => {
        assert.ok(r.x < BB.CONFIG.ARENA_W / 2, `${arena}/${seed}: team A robot not on the left`);
        assert.ok(Math.abs(b[i].x - (BB.CONFIG.ARENA_W - r.x)) < 1e-9 && Math.abs(b[i].y - (BB.CONFIG.ARENA_H - r.y)) < 1e-9,
          `${arena}/${seed}: robot ${i} not mirrored`);
        assert.strictEqual(b[i].heading, BB.geo.normAngle(r.heading + 180));
      });
    }
  }
});
test('teammates are invisible to SCAN and excluded from ENEMIES; ALLIES counts them', () => {
  const probe = `Probe
SCAN 90
GET R0, SCAN_DIST
GET R1, ENEMIES
GET R2, ALLIES
WAIT`;
  const w = new BB.World({ entries: [teamEntry(probe, 0, 0), teamEntry('Mate\nWAIT', 1, 0), teamEntry('Foe\nWAIT', 2, 1)], seed: 1, arena: 'open' });
  const [me, mate, foe] = w.robots;
  Object.assign(me, { x: 100, y: 300, turret: 0, targetTurret: 0 });
  Object.assign(mate, { x: 200, y: 300 });   // straight ahead
  Object.assign(foe, { x: 100, y: 550 });    // straight down: outside the cone
  w.step();
  assert.deepStrictEqual([me.vm.regs[0], me.vm.regs[1], me.vm.regs[2]], [-1, 1, 1]);
});
test('no friendly fire, and RADAR ignores teammates\' shots', () => {
  const marksman = 'Marksman\nFIRE\nWAIT';
  const watcher = 'Watcher\nRADAR\nGET R0, THREAT_DIST\nMAX R1, R0\nWAIT';
  const w = new BB.World({ entries: [teamEntry(marksman, 0, 0), teamEntry(watcher, 1, 0), teamEntry('Foe\nWAIT', 2, 1)], seed: 1, arena: 'open' });
  const [s, mate, foe] = w.robots;
  Object.assign(s, { x: 100, y: 300, heading: 0, targetHeading: 0, turret: 0, targetTurret: 0 });
  Object.assign(mate, { x: 250, y: 300 });
  Object.assign(foe, { x: 400, y: 300 });    // behind the teammate, same line
  mate.vm.regs[1] = -1;
  for (let i = 0; i < 60; i++) w.step();
  assert.strictEqual(mate.health, BB.CONFIG.MAX_HEALTH, 'teammate took damage');
  assert.strictEqual(mate.vm.regs[1], -1, 'teammate saw its own side\'s bullets on RADAR');
  assert.ok(foe.health < BB.CONFIG.MAX_HEALTH, 'bullets should pass the teammate and hit the enemy');
});
test('last team standing wins, even with a teammate down', () => {
  const ex = BB.EXAMPLES.map((e) => e.source);
  for (const seed of [1, 2, 3]) {
    const entries = [0, 1, 2, 3].map((i) => teamEntry(ex[i], i, i < 2 ? 0 : 1));
    const w = new BB.World({ entries, seed });
    while (!w.over) w.step();
    if (w.winnerTeam === null) continue;
    assert.ok(w.robots.some((r) => r.alive && r.team === w.winnerTeam) || w.tick >= BB.CONFIG.MAX_TICKS);
    assert.ok(w.robots.every((r) => !r.alive || r.team === w.winnerTeam) || w.tick >= BB.CONFIG.MAX_TICKS);
    assert.strictEqual(w.winner, null);
  }
});
test('a team match with only one team is practice mode', () => {
  const w = new BB.World({ entries: [teamEntry('A\nWAIT', 0, 0), teamEntry('B\nWAIT', 1, 0)], seed: 1 });
  assert.strictEqual(w.competitive, false);
  for (let i = 0; i < 20; i++) w.step();
  assert.strictEqual(w.over, false);
});

console.log('Fuzzing (fixed seeds, so failures reproduce)');
const fuzzRng = BB.geo.makeRng(20261021);
const fuzzPick = (a) => a[Math.floor(fuzzRng() * a.length)];
const fuzzInt = (lo, hi) => lo + Math.floor(fuzzRng() * (hi - lo + 1));
const isInt32 = (v) => Number.isInteger(v) && v >= -2147483648 && v <= 2147483647;

/** A random program that assembles: every instruction, odd operands, jumps anywhere. */
function fuzzProgram(n) {
  const src = ['R0', 'R1', 'R7', '[R1]', '[R2+3]', '[5]', '[R0]', '0', '1', '-1', '360', '2147483647', '-2147483648'];
  const dst = ['R0', 'R1', 'R7', '[R1]', '[R2+3]', '[5]', '[R0]'];
  const lines = ['Fuzz'];
  for (let i = 0; i < n; i++) {
    const spec = fuzzPick(BB.ISA.INSTRUCTIONS);
    const args = spec.args.map((k) => (k === 'dst' ? fuzzPick(dst) : k === 'src' ? fuzzPick(src)
      : k === 'sensor' ? fuzzPick(BB.ISA.SENSORS).name : `L${fuzzInt(0, n)}`));
    // A literal that always crashes (DIV R0, 0) is an assembly error; a register can still be 0 at run time.
    const crashes = { DIV: (v) => v === 0, MOD: (v) => v === 0, RAND: (v) => v <= 0, SQRT: (v) => v < 0 }[spec.op];
    if (crashes && /^-?\d+$/.test(args[1]) && crashes(Number(args[1]))) args[1] = 'R1';
    lines.push(`L${i}: ${spec.op} ${args.join(', ')}`);
  }
  lines.push(`L${n}: WAIT`);
  return lines.join('\n');
}

test('assembler never throws and reports sane line numbers for random token soup', () => {
  const tokens = ['MOV', 'JMP', 'R0', 'R9', '[', ']', ',', ':', 'loop:', '.def', '5', '-0x1F', ';', 'GET', 'HEALTH', '[R1+2]', '.shape', '99999999999', '//', '\u{1F916}'];
  for (let i = 0; i < 1500; i++) {
    const src = ['Fuzz', ...Array.from({ length: fuzzInt(0, 6) }, () => Array.from({ length: fuzzInt(0, 5) }, () => fuzzPick(tokens)).join(fuzzPick([' ', ', ', ''])))].join('\n');
    const res = BB.assemble(src);
    const n = src.split('\n').length;
    for (const e of res.errors.concat(res.warnings)) assert.ok(e.line >= 1 && e.line <= n && e.message, JSON.stringify(src));
    assert.ok(!res.errors.length || !res.program.length);
  }
});

test('VM keeps 32-bit registers, its stack limit and the cycle budget on random programs', () => {
  const io = { sense: () => 7, random: (n) => Math.floor(fuzzRng() * n), speed() {}, turn() {}, head() {}, aim() {}, fire() {}, scan() {}, radar() {} };
  for (let i = 0; i < 1500; i++) {
    const src = fuzzProgram(fuzzInt(1, 20));
    const res = BB.assemble(src);
    assert.deepStrictEqual(res.errors, [], src);
    const vm = new BB.VM(res.program, io);
    vm.trace = [];
    for (let t = 0; t < 5; t++) {
      assert.ok(vm.run(50) <= 50, src);
      assert.ok([...vm.regs].every(isInt32), src);
      assert.ok(vm.stack.length <= BB.CONFIG.STACK_SIZE, src);
      assert.ok(!vm.fault || !/internal error/.test(vm.fault), `${vm.fault}\n${src}`);
      assert.ok(Number.isInteger(vm.currentLine), src);
    }
  }
});

test('random matches keep every robot finite, in the arena, out of obstacles, with int32 sensors', () => {
  const R = BB.CONFIG.ROBOT_RADIUS;
  for (let i = 0; i < 25; i++) {
    const n = fuzzInt(2, 8);
    const entries = Array.from({ length: n }, (_, k) => compile(fuzzRng() < 0.5 ? fuzzPick(BB.EXAMPLES).source : fuzzProgram(fuzzInt(3, 15)), k));
    const seed = fuzzInt(1, 1e6), arena = fuzzPick(['classic', 'random', 'open']);
    const w = new BB.World({ entries, seed, arena });
    for (let t = 0; t < 800 && !w.over; t++) {
      w.step();
      for (const r of w.robots) {
        const where = `match ${i} (seed ${seed}, ${arena}) tick ${w.tick} ${r.name}`;
        assert.ok(['x', 'y', 'heading', 'turret', 'speed', 'health'].every((f) => Number.isFinite(r[f])), where);
        assert.ok(r.x >= R - 1e-6 && r.x <= w.width - R + 1e-6 && r.y >= R - 1e-6 && r.y <= w.height - R + 1e-6, `${where} at ${r.x},${r.y}`);
        assert.ok(r.health >= 0 && r.health <= BB.CONFIG.MAX_HEALTH, where);
        if (r.alive) for (const o of w.obstacles) { const p = BB.geo.circleRectPush(r.x, r.y, R, o); assert.ok(!p || p.depth <= 0.5, `${where} inside an obstacle`); }
        for (const s of BB.ISA.SENSORS) assert.ok(isInt32(w.sense(r, s.id)), `${where} ${s.name}`);
      }
      w.drainEvents();
    }
  }
});

console.log('Regression checks');
test('constants enforce signed 32-bit limits for every directive', () => {
  for (const directive of ['.def', '.const', '.equ']) {
    for (const value of ['2147483648', '-2147483649', '0x100000000', '9'.repeat(400)]) {
      const errors = errorsOf(`T\n${directive} K ${value}\nMOV R0, K`);
      assert.ok(errors.some((e) => e.line === 2 && /32 bits/.test(e.message)), `${directive} ${value}`);
    }
    const vm = runVM(`T\n${directive} LOW -2147483648\n${directive} HIGH 2147483647\nMOV R0, LOW\nMOV R1, HIGH\nCMP R1, HIGH\nHALT`);
    assert.deepStrictEqual([...vm.regs.slice(0, 2)], [-2147483648, 2147483647]);
    assert.strictEqual(vm.cmp, 0);
  }
});

test('robot separation keeps bodies inside all four arena walls', () => {
  const R = BB.CONFIG.ROBOT_RADIUS;
  for (const positions of [
    [[R, 300], [R + 24, 300]],
    [[800 - R, 300], [800 - R - 24, 300]],
    [[400, R], [400, R + 24]],
    [[400, 600 - R], [400, 600 - R - 24]],
  ]) {
    const w = new BB.World({ entries: [compile('A\nWAIT', 0), compile('B\nWAIT', 1)], arena: 'open' });
    w.robots.forEach((r, i) => Object.assign(r, { x: positions[i][0], y: positions[i][1] }));
    for (let tick = 0; tick < 10; tick++) {
      w.step();
      for (const r of w.robots) {
        assert.ok(r.x >= R && r.x <= w.width - R, `x=${r.x}`);
        assert.ok(r.y >= R && r.y <= w.height - R, `y=${r.y}`);
      }
    }
  }
});

test('robot separation cannot push a body into an obstacle', () => {
  const obstacle = { x: 100, y: 200, w: 20, h: 100 };
  const w = new BB.World({ entries: [compile('A\nWAIT', 0), compile('B\nWAIT', 1)], obstacles: [obstacle] });
  Object.assign(w.robots[0], { x: 136, y: 250 });
  Object.assign(w.robots[1], { x: 160, y: 250 });
  for (let tick = 0; tick < 10; tick++) {
    w.step();
    for (const r of w.robots) assert.strictEqual(BB.geo.circleRectPush(r.x, r.y, BB.CONFIG.ROBOT_RADIUS, obstacle), null);
  }
});

test('single-robot CLI runs and tournaments terminate with practice results', () => {
  const { spawnSync } = require('child_process');
  const path = require('path');
  for (const rounds of [1, 2]) {
    const result = spawnSync(process.execPath, ['tools/headless.js', '--rounds', String(rounds), 'examples/sentinel.asm'], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 10000,
    });
    assert.ifError(result.error);
    assert.strictEqual(result.status, 0, result.stderr);
    if (rounds === 1) assert.match(result.stdout, /\[\s*6000\] Practice run finished/);
    else assert.match(result.stdout, /\(practice\)\s+2/);
    assert.doesNotMatch(result.stdout, /\(draw\)/);
  }
});

// Exercise UI controller methods with DOM/storage stubs, without rendering.
const fs = require('fs');
const path = require('path');
const scriptVm = require('vm');
require('../js/ui/explain.js'); // pure strings, used by the app's Simple view
require('../js/ui/snippets.js'); // the editor's Insert menu patterns
require('../js/ui/assist.js'); // autocomplete and Ctrl+/ logic

test('autocomplete offers the right kind of word for where the caret is', () => {
  const prog = 'Bot\n.def RANGE 200\nmain:\n    GET R0, FRONT\nloop: WAIT\n';
  const offer = (tail) => {
    const src = prog + tail, caret = src.indexOf('|'), text = src.replace('|', '');
    const r = BB.assist.completions(text, caret);
    return r ? r.items.map((i) => i.text) : [];
  };
  assert.deepStrictEqual(offer('    SC|'), ['SCAN']);
  assert.deepStrictEqual(offer('here: JM|'), ['JMP'], 'after a label');
  assert.deepStrictEqual(offer('    GET R1, HE|'), ['HEADING', 'HEALTH'], 'sensors after GET');
  assert.strictEqual(offer('    GET R1, SCAN_|').length, 7);
  assert.deepStrictEqual(offer('    JMP l|'), ['loop'], 'your labels after a jump');
  assert.deepStrictEqual(offer('    CALL ma|'), ['main']);
  assert.deepStrictEqual(offer('    MOV R1, RA|'), ['RANGE'], 'constants as values');
  assert.strictEqual(offer('    MOV R1, [R|').length, 8, 'registers inside [ ]');
  for (const quiet of ['    s|', '    ; SC|', '    SC|AN 10', '    SCAN|', '.de|']) assert.deepStrictEqual(offer(quiet), [], quiet);
  assert.strictEqual(BB.assist.completions('Bo', 2), null, 'not on the name line');
  const scan = BB.assist.completions('T\n    SC', 8).items[0];
  assert.deepStrictEqual([scan.insert, /flashlight/.test(scan.detail)], ['SCAN ', true], 'inserts a space after; plain note');
});

test('Ctrl+/ comments lines out and back in, skipping blank lines and the name', () => {
  const t = 'Bot\nmain:\n    SCAN 10\n\n    FIRE\n    WAIT';
  const out = BB.assist.toggleComments(t, t.indexOf('SCAN'), t.indexOf('FIRE') + 2);
  assert.strictEqual(out.text, 'Bot\nmain:\n    ; SCAN 10\n\n    ; FIRE\n    WAIT');
  assert.strictEqual(BB.assist.toggleComments(out.text, out.from, out.to).text, t, 'toggling twice restores it');
  assert.strictEqual(BB.assist.toggleComments(t, 0, 3).text, t, 'the name line is never commented');
  const mixed = 'Bot\n    ; SCAN 10\n    FIRE';
  assert.strictEqual(BB.assist.toggleComments(mixed, 4, mixed.length).text, 'Bot\n    ; ; SCAN 10\n    ; FIRE', 'a mix is commented, not uncommented');
  const whole = BB.assist.toggleComments(t, t.indexOf('main'), t.indexOf('main'));
  assert.strictEqual(whole.text, 'Bot\n; main:\n    SCAN 10\n\n    FIRE\n    WAIT', 'no selection: just the caret line');
  assert.deepStrictEqual(BB.assemble(out.text).errors, [], 'commented code still assembles');
});

test('Tab / Shift+Tab indent and outdent the selected lines, skipping blank lines and the name', () => {
  const t = 'Bot\nmain:\n    SCAN 10\n\n\tFIRE\nWAIT';
  const out = BB.assist.indentLines(t, 0, t.indexOf('FIRE'), false);
  assert.strictEqual(out.text, 'Bot\n    main:\n        SCAN 10\n\n    \tFIRE\nWAIT');
  const back = BB.assist.indentLines(t, t.indexOf('main'), t.length, true);
  assert.strictEqual(back.text, 'Bot\nmain:\nSCAN 10\n\nFIRE\nWAIT', 'outdent removes up to 4 spaces or one tab');
  const ind = BB.assist.indentLines(t, t.indexOf('main'), t.indexOf('WAIT'), false);
  assert.strictEqual(BB.assist.indentLines(ind.text, ind.from, ind.to, true).text, t.replace('\tFIRE', '\tFIRE'), 'indent then outdent restores it');
});

test('every Insert-menu snippet assembles, alone and inserted twice into one program', () => {
  for (const s of BB.SNIPPETS) {
    assert.deepStrictEqual(BB.assemble(`T\n${BB.snippetFor(s.id, '')}\nWAIT`).errors, [], s.id);
  }
  let prog = 'T\nmain:\n';
  for (let round = 0; round < 2; round++) for (const s of BB.SNIPPETS) prog += `${BB.snippetFor(s.id, prog)}\n`;
  assert.deepStrictEqual(BB.assemble(`${prog}    WAIT\n    JMP main`).errors, [], 'labels renamed so nothing clashes');
  const twice = BB.snippetFor('if', BB.snippetFor('if', ''));
  assert.match(twice, /JGE {2}skip2/);
  assert.match(twice, /; NOT below 30\? skip the next part/, 'comments are not renamed');
  assert.strictEqual(BB.snippetFor('nope', ''), null);
});
test('the Insert menu knows where code may go, and when it could never run there', () => {
  const A = BB.assist;
  const template = BB.NEW_ROBOT_TEMPLATE.split('\n');
  assert.strictEqual(A.headerEnd(BB.NEW_ROBOT_TEMPLATE), template.findIndex((l) => l.startsWith('.shot')), 'below all nine appearance settings');
  assert.strictEqual(A.headerEnd('Bot\n.color red\n.boom confetti\nmain:\n    WAIT'), 2, 'the newer settings count as header too');
  assert.strictEqual(A.headerEnd('Bot\nmain:\n    WAIT'), 0, 'no header: just below the name');
  assert.strictEqual(A.headerEnd('Bot\n; a comment\n.shape circle\n\nmain:'), 2);
  const prog = 'Bot\nmain:\n    SPEED 3\n    JMP main\n    FIRE\nfunc:\n    RET\n    FIRE\n    HALT\n    WAIT';
  assert.strictEqual(A.deadAfter(prog, 4), 'JMP main', 'right after a JMP');
  assert.strictEqual(A.deadAfter(prog, 5), null, 'a label can be jumped to');
  assert.strictEqual(A.deadAfter(prog, 7), 'RET');
  assert.strictEqual(A.deadAfter(prog, 9), 'HALT');
  assert.strictEqual(A.deadAfter(prog, 2), null, 'just below a label');
  assert.strictEqual(A.deadAfter('Bot\nmain:\n    CMP R0, 1\n    JG main\n    FIRE', 4), null, 'after a conditional jump');
  assert.strictEqual(A.deadAfter('Bot\nl: JMP   l   ; spin\n\n    ; note\n    FIRE', 4), 'JMP l', 'blank and comment lines are skipped');
  // After inserting, the cursor waits on a fresh indented line: under the "code here" comment, or after the pattern.
  for (const s of BB.SNIPPETS) {
    const { code, cursor } = BB.snippetToInsert(s.id, '');
    const lines = code.slice(0, cursor).split('\n');
    assert.strictEqual(lines[lines.length - 1], '    ', `${s.id}: an indented blank line`);
    if (/code here/.test(s.code)) assert.ok(BB.isSnippetPlaceholder(lines[lines.length - 2]), `${s.id}: right under its "code here" comment`);
    else assert.strictEqual(cursor, code.length, `${s.id}: right after the pattern`);
    assert.deepStrictEqual(BB.assemble(`T\n${code}\nWAIT`).errors, [], s.id);
  }
  assert.strictEqual(BB.isSnippetPlaceholder('    ; <- add the firing line here'), false, 'mission hints are not replaced');
});
test('shipped programs assemble without warnings', () => {
  const programs = [...BB.EXAMPLES.map((e) => [e.file, e.source]), ['template', BB.NEW_ROBOT_TEMPLATE]];
  for (const m of BB.MISSIONS) {
    for (const k of ['starter', 'solution', 'withDodge']) if (m[k]) programs.push([`${m.id} ${k}`, m[k]]);
    for (const d of m.dummies || []) programs.push([`${m.id} dummy`, d.source]);
  }
  for (const s of BB.SNIPPETS) programs.push([`snippet ${s.id}`, `T\n${BB.snippetFor(s.id, '')}\nWAIT`]);
  for (const [name, src] of programs) assert.deepStrictEqual(BB.assemble(src).warnings, [], name);
});
test('every asm example in the README and LANGUAGE.md assembles without errors or warnings', () => {
  const fs = require('fs'), path = require('path');
  for (const doc of ['README.md', 'docs/LANGUAGE.md']) {
    const text = fs.readFileSync(path.join(__dirname, '..', doc), 'utf8').replace(/\r\n/g, '\n');
    for (const [, src] of text.matchAll(/```asm\n([\s\S]*?)```/g)) {
      const res = BB.assemble(src);
      assert.deepStrictEqual([res.errors, res.warnings], [[], []], `${doc}:\n${src}`);
    }
  }
});
const uiBB = { ...BB };
// Capture the controller rather than booting the page and animation loop.
scriptVm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/ui/app.js'), 'utf8').replace('BB.app = new App();', 'BB.App = App;'), {
  BB: uiBB,
  window: { addEventListener(event, callback) { if (event === 'DOMContentLoaded') callback(); } },
  requestAnimationFrame() {},
  performance: { now: () => 0 },
  confirm: () => true, // "Are you sure?" dialogs answer yes
});

function uiHarness(mode = 'ffa') {
  const app = Object.create(uiBB.App.prototype);
  const source = 'A\nINC R0\nWAIT';
  const entry = { id: 0, source, draft: source, compiled: BB.assemble(source), runningSource: source, team: 'A', breakpoints: new Set() };
  app.entries = [entry];
  app.selectedId = 0;
  app.mode = mode;
  app.world = new BB.World({ entries: [compile(source, 0), compile('B\nWAIT', 1)], arena: 'open' });
  app.persist = app.checkDraft = app.renderRoster = app.updatePanels = () => {};
  app.flash = (message) => { app.message = message; };
  app.editor = { setBreakpoints(lines) { this.breakpoints = [...lines]; } };
  return app;
}

test('damaged saved robots are skipped or repaired, never shown as "[object Object]"', () => {
  // app.js runs in its own context, so copy its arrays before comparing them strictly.
  const clean = (e) => { const r = uiBB.App.cleanSavedEntry(e); return r && { ...r, breakpoints: [...r.breakpoints] }; };
  for (const junk of [null, 5, 'text', {}, { source: 42 }, { filename: 'a.asm' }]) assert.strictEqual(clean(junk), null, JSON.stringify(junk));
  const fixed = clean({ filename: { oops: 1 }, source: 'A\nWAIT', draft: 7, team: 'Z', breakpoints: [3, 'x', 2.5, 4] });
  assert.deepStrictEqual(fixed, { filename: 'robot.asm', source: 'A\nWAIT', draft: undefined, team: null, breakpoints: [3, 4] });
  const good = { filename: 'b.asm', source: 'B\nWAIT', draft: 'B\nNOP', team: 'A', breakpoints: [2] };
  assert.deepStrictEqual(clean(good), good, 'a healthy save is kept as is');
});

test('the CPU inspector shows memory slots the program names, and any that hold a value', () => {
  const app = uiHarness();
  const vm = new BB.VM(BB.assemble('T\nMOV R1, 40\nMOV [R1+2], 9\nMOV R0, [3]\nHALT').program, {});
  assert.strictEqual(app.memoryRow(vm, 'tip'), '<div class="kv memory"><span title="tip"><i>[3]</i>0</span></div>', 'before running: just the named slot');
  vm.run(50);
  assert.match(app.memoryRow(vm, 'tip'), /<i>\[3\]<\/i>0<\/span><span title="tip"><i>\[42\]<\/i>9</, 'after: [42] holds 9');
  assert.strictEqual(app.memoryRow(new BB.VM(BB.assemble('T\nHALT').program, {}), 'tip'), '', 'no memory used: no row');
  const busy = new BB.VM(BB.assemble('T\nHALT').program, {});
  for (let i = 0; i < 20; i++) busy.mem[i] = 1;
  assert.match(app.memoryRow(busy, 'tip'), /\+8 more/, 'capped at 12 slots');
});

test('invalid Apply preserves the applied program and reports rejection', () => {
  for (const tick of [0, 1]) {
    const app = uiHarness();
    if (tick) app.world.step();
    const entry = app.selected, source = entry.source, compiled = entry.compiled;
    const robot = app.robotFor(entry.id), cpu = robot.vm;
    entry.draft = 'A\nBOGUS';
    app.applyDraft();
    assert.strictEqual(entry.source, source);
    assert.strictEqual(entry.compiled, compiled);
    assert.strictEqual(entry.runningSource, source);
    assert.strictEqual(robot.vm, cpu);
    assert.strictEqual(entry.draft, 'A\nBOGUS');
    assert.match(app.message, /Not applied.*previously applied code/);
    const previous = cpu.regs[0];
    app.world.step();
    assert.strictEqual(cpu.regs[0], previous + 1);
  }
});

test('valid Apply still hot-swaps the CPU and preserves the body', () => {
  const app = uiHarness();
  app.world.step();
  const robot = app.robotFor(0), oldCpu = robot.vm;
  const body = [robot.x, robot.y, robot.health];
  app.selected.draft = 'A\nMOV R0, 42\nWAIT';
  app.applyDraft();
  assert.notStrictEqual(robot.vm, oldCpu);
  assert.deepStrictEqual([robot.x, robot.y, robot.health], body);
  app.world.step();
  assert.strictEqual(robot.vm.regs[0], 42);
});

test('program reloads keep duplicate robot names distinct', () => {
  const w = new BB.World({ entries: [compile('Twin\nWAIT', 0), compile('Twin\nWAIT', 1)], arena: 'open' });
  const [a, b] = w.robots;
  w.renameRobot(b, 'Twin');
  assert.strictEqual(b.name, 'Twin (2)');
  w.renameRobot(a, 'Other');
  assert.strictEqual(a.name, 'Other');
  w.renameRobot(a, 'Twin');
  assert.strictEqual(a.name, 'Twin');
  w.renameRobot(b, 'Other');
  assert.strictEqual(b.name, 'Other');
});

test('hot-swap renames through the world, keeping a duplicate suffix', () => {
  const app = uiHarness();
  app.world = new BB.World({ entries: [compile('A\nWAIT', 0), compile('A\nWAIT', 1)], arena: 'open' });
  app.entries[0].id = 1;
  app.selectedId = 1;
  app.world.step();
  app.selected.draft = 'A\nMOV R0, 1\nWAIT';
  app.applyDraft();
  assert.deepStrictEqual(app.world.robots.map((r) => r.name), ['A', 'A (2)']);
});

test('CRLF sources are stored with LF so they match the editor textarea', () => {
  const app = uiHarness();
  app.nextId = 5;
  const e = app.addEntry('win.asm', 'Win\r\nINC R0\r\nWAIT\r\n', { select: false, draft: 'Win\rWAIT' });
  assert.strictEqual(e.source, 'Win\nINC R0\nWAIT\n');
  assert.strictEqual(e.draft, 'Win\nWAIT');
  const plain = app.addEntry('win2.asm', 'Win\r\nWAIT', { select: false });
  assert.strictEqual(plain.draft, plain.source);
  assert.deepStrictEqual(plain.compiled.errors, []);
});

test('breakpoints pause the match before the line and resume past it', () => {
  const app = uiHarness();
  const robot = app.robotFor(0);
  app.toggleBreakpoint(3);
  app.stepOnce();
  assert.match(app.message, /about to run line 3/);
  assert.deepStrictEqual([robot.vm.regs[0], robot.vm.breakHit, robot.vm.resumeLine], [1, 0, 3]);
  app.message = null;
  app.stepOnce(); // runs the WAIT on line 3
  assert.strictEqual(app.message, null);
  app.stepOnce(); // INC again, then stops before line 3
  assert.match(app.message, /about to run line 3/);
  assert.strictEqual(robot.vm.regs[0], 2);
});

test('trace facts let Simple view explain comparisons, jumps and sensor reads', () => {
  const src = 'T\nGET R0, HEALTH\nCMP R0, 30\nJL low\nSCAN 20\nRADAR\nFIRE\nWAIT\nlow: SPEED 5';
  const sense = (id) => ({ HEALTH: 80, SCAN_DIST: 230, THREAT_DIST: -1, COOLDOWN: 4 })[BB.ISA.SENSORS[id].name];
  const vm = new BB.VM(BB.assemble(src).program, { sense, scan() {}, radar() {}, fire() {} });
  vm.trace = [];
  vm.run(50);
  const t = vm.trace;
  assert.deepStrictEqual([t[0].sensor, t[0].dst, t[0].value], ['HEALTH', 'R0', 80]);
  assert.deepStrictEqual([t[1].x, t[1].y, t[2].taken, t[2].to], [80, 30, false, 5]);
  assert.deepStrictEqual([t[3].found, t[3].note, t[4].found, t[5].cooldown], [230, 'found at 230', -1, 4]);
  assert.deepStrictEqual(BB.explain.traceNotes(t), [
    'Read HEALTH: R0 is now 80',
    'Compare 80 with 30: 80 is greater than 30',
    '80 is not less than 30, so keep going',
    'Look in a 20° cone: enemy 230 away!',
    'No bullets coming',
    'Turret still reloading (4 more ticks)',
    'Done for this tick',
  ]);
});

test('plain notes for jumps without a CMP in the same tick, crashes and angles', () => {
  const X = BB.explain;
  assert.strictEqual(X.traceNote({ op: 'JE', taken: true, to: 9 }, null), 'The last CMP said yes, so jump to line 9');
  assert.strictEqual(X.traceNote({ op: 'JGE', taken: true, to: 4 }, { x: 3, y: 3 }), '3 is greater than or equal to 3, so jump to line 4');
  assert.match(X.traceNote({ op: 'DIV', fault: 'division by zero.' }, null), /^Crashed: it tried to divide by zero/);
  assert.strictEqual(X.traceNote({ op: 'HEAD', value: 270 }, null), 'Turn to face 270° (up)');
  assert.strictEqual(X.traceNote({ op: 'TURN', value: -45 }, null), 'Turn 45° left');
  for (const ins of BB.ISA.INSTRUCTIONS) assert.ok(X.instruction(ins.op), `plain help for ${ins.op}`);
  for (const s of BB.ISA.SENSORS) assert.ok(X.sensor(s.name), `plain help for ${s.name}`);
});

test('trace notes say what TURN, SCAN and SPEED really do', () => {
  const note = (op, value, extra = {}) => BB.explain.traceNote({ op, value, ...extra }, null);
  assert.strictEqual(note('TURN', 90), 'Turn 90° right');
  assert.strictEqual(note('TURN', 270), 'Turn 90° left (the shorter way round)');
  assert.strictEqual(note('TURN', -270), 'Turn 90° right (the shorter way round)');
  assert.strictEqual(note('TURN', 180), 'Turn around: 180°, to the left');
  assert.strictEqual(note('TURN', -180), 'Turn around: 180°, to the left');
  assert.strictEqual(note('TURN', 360), 'No turn: 360° goes all the way round');
  assert.strictEqual(note('TURN', 0), 'No turn (0°)');
  assert.strictEqual(note('SPEED', 3), 'Drive at speed 3');
  assert.strictEqual(note('SPEED', 10), 'Drive at speed 5 (the fastest)');
  assert.strictEqual(note('SPEED', -10), 'Drive at speed -3 (the fastest backward)');
  assert.strictEqual(note('SCAN', 360, { found: -1 }), 'Look in a 90° cone (the widest): nobody found');
  assert.strictEqual(note('SCAN', 0, { found: 120 }), 'Look in a 1° cone (the narrowest): enemy 120 away!');
  // And the engine agrees: TURN 270 and TURN 180 turn left, TURN 360 doesn't turn at all.
  for (const [deg, way] of [[270, -1], [180, -1], [-270, 1], [360, 0], [90, 1]]) {
    const w = new BB.World({ entries: [compile(`T\nTURN ${deg}\nl: WAIT\nJMP l`, 0)], arena: 'open' });
    const r = w.robots[0], before = r.heading;
    w.step();
    const turned = Math.round(BB.geo.angleDiff(r.heading, before));
    assert.ok(way === 0 ? turned === 0 : Math.sign(turned) === way, `TURN ${deg} turned ${turned}`);
  }
});

test('Reference claims match the engine (turning, SCAN timing, misses, collisions)', () => {
  const world = (srcs, teams) => new BB.World({ entries: srcs.map((s, i) => ({ ...compile(s, i), team: teams && teams[i] })), arena: 'open' });
  const put = (r, x, y, h) => { r.x = x; r.y = y; r.heading = r.targetHeading = r.turret = r.targetTurret = h; };
  // TURN takes the shorter way: 270 and 180 both turn left.
  for (const [deg, want] of [[90, 16], [180, 344], [270, 344], [-270, 16]]) {
    const w = world([`T\nTURN ${deg}\nl: WAIT\nJMP l`]); put(w.robots[0], 400, 300, 0);
    w.step(); w.step();
    assert.strictEqual(Math.round(w.robots[0].heading), want, `TURN ${deg}`);
  }
  // SCAN uses the turret direction before this tick's AIM turns it; a miss zeroes the other SCAN_* values.
  const s = world(['S\nAIM 180\nSCAN 10\nGET R0, SCAN_DIST\nGET R1, SCAN_ANGLE\nGET R2, SCAN_X\nl: WAIT\nJMP l', 'F\nl: WAIT\nJMP l']);
  put(s.robots[0], 400, 300, 0); put(s.robots[1], 200, 300, 0);
  s.step();
  assert.deepStrictEqual([...s.robots[0].vm.regs.slice(0, 3)], [-1, 0, 0]);
  // Walls cost half the speed, rounded down.
  for (const [spd, dmg] of [[1, 0], [2, 1], [3, 1], [4, 2], [5, 2]]) {
    const w = world([`W\nSPEED ${spd}\nl: WAIT\nJMP l`]); put(w.robots[0], 700, 300, 0);
    for (let t = 0; t < 200; t++) w.step();
    assert.strictEqual(100 - w.robots[0].health, dmg, `wall at speed ${spd}`);
  }
  // Pushing into an enemy hurts both every tick; slow bumps and teammates do not.
  const ram = (spd, teams) => {
    const w = world([`A\nSPEED ${spd}\nl: WAIT\nJMP l`, 'B\nl: WAIT\nJMP l'], teams); put(w.robots[0], 300, 300, 0); put(w.robots[1], 400, 300, 180);
    for (let t = 0; t < 60; t++) w.step();
    return [100 - w.robots[0].health, 100 - w.robots[1].health];
  };
  const [a, b] = ram(5);
  assert.ok(a > 10 && a === b, `pushing an enemy: ${a}, ${b}`);
  assert.deepStrictEqual(ram(1), [0, 0]);
  assert.deepStrictEqual(ram(5, [0, 0]), [0, 0]);
});

test('every real VM crash gets a plain explanation, with its line', () => {
  const crash = (src) => { const vm = runVM(src, 2000); return vm.fault; };
  const cases = [
    ['T\nDIV R0, R1', /line 2: it tried to divide by zero/],
    ['T\nMOD R0, R1', /MOD by zero is impossible/],
    ['T\nl: CALL l', /too many CALLs without a RET/],
    ['T\nRET', /RET ran without a CALL first/],
    ['T\nPOP R0', /nothing was PUSHed first/],
    ['T\nMOV R1, 300\nMOV R0, [R1]', /tried to use \[300\]/],
    ['T\nMOV R1, -1\nSQRT R0, R1', /SQRT of a negative number/],
    ['T\nRAND R0, R1', /RAND needs a number bigger than 0/],
  ];
  for (const [src, re] of cases) assert.match(BB.explain.fault(crash(src)), re, src);
});

test('a crash ends a mission at once, naming the line', () => {
  const def = BB.MISSIONS[0];
  const w = BB.buildMission(def, BB.assemble('Oops\nMOV R0, 5\nDIV R0, R1'));
  w.step();
  assert.ok(w.over);
  assert.match(w.mission.result.text, /crashed on line 3/);
});

test('a mission still ends with a result when the player destroys every opponent', () => {
  // Dodge: the student adds an attack. The match must not end as a plain "wins" with no mission result.
  const def = BB.MISSIONS.find((m) => m.id === 'dodge');
  const boss = BB.MISSIONS.find((m) => m.id === 'boss');
  const w = BB.buildMission(def, BB.assemble(boss.solution));
  for (let t = 0; t <= def.maxTicks && !w.over; t++) w.step();
  assert.ok(!w.robots[1].alive, 'the turret was destroyed');
  assert.deepStrictEqual(w.mission.result, { ok: true, text: 'You destroyed the turret. That works too!' });
  assert.ok(!w.winner, 'the mission, not the match rules, decided the end');
});

test('every mission has a second hint, and following it literally passes', () => {
  const M = (id) => BB.MISSIONS.find((m) => m.id === id);
  const lines = (s) => s.split('\n');
  const code = (l) => l.split(';')[0].trim();
  const replaceLine = (src, match, add) => { const a = lines(src), i = a.findIndex(match); assert.ok(i >= 0); a.splice(i, 1, ...add); return a.join('\n'); };
  const insertAfter = (src, match, add) => { const a = lines(src), i = a.findIndex(match); assert.ok(i >= 0); a.splice(i + 1, 0, ...add); return a.join('\n'); };
  const m10 = lines(M('boss').starter);
  const attackFn = m10.slice(m10.findIndex((l) => l.startsWith('attack:')), m10.findIndex((l) => l.startsWith('; ---- dodge'))).join('\n').trimEnd();
  // Each line is what the hint2 text tells a student to do.
  const follow = {
    drive: (s) => s.replace('SPEED 0', 'SPEED 5'),
    angles: (s) => s.replace('HEAD 0', 'HEAD 270'),
    aim: (s) => s.replace('AIM 0', 'AIM 315'),
    scan: (s) => replaceLine(s, (l) => l.includes('<- add the firing line'), ['    FIRE']),
    dodge: (s) => insertAfter(s, (l) => l.includes('DANGER!'), ['    TURN 90', '    SPEED 5']),
    park: (s) => replaceLine(s.replace('CMP  R0, 0 ', 'CMP  R0, 500'), (l) => l.includes('<- far enough?'), ['    JGE park']),
    sweep: (s) => replaceLine(s, (l) => l.includes('<- add 30 to R1'), ['    ADD R1, 30']),
    laps: (s) => replaceLine(s, (l) => l.includes('<- add a line that adds 1'), ['    INC R5']),
    call: (s) => replaceLine(s, (l) => l.includes('<- something is missing'), ['    RET']),
    boss: (s) => replaceLine(s, (l) => l.includes('<- add your two dodge lines'), ['    TURN 90', '    SPEED 5']),
    explore: (s) => insertAfter(insertAfter(s, (l) => code(l) === 'GET  R0, FRONT', ['    CMP R0, 80', '    JG clear', '    TURN 90']), (l) => l.includes('<- if R0 is less than 80'), ['clear:']),
    follow: (s) => replaceLine(replaceLine(s, (l) => l.includes('<- IF: jump'), ['    JG far']), (l) => l.includes('<- skip the "far" part'), ['    JMP done']),
    coords: (s) => replaceLine(s, (l) => l.includes('<- turn dy and dx'), ['    ATAN2 R4, R3, R2']),
    lead: (s) => s.replace('.def LEAD 0 ', '.def LEAD 10'),
    graduate: (s) => replaceLine(replaceLine(s, (l) => l.includes('<- copy the lines from Mission 11'),
      ['    SPEED 3', '    GET R0, FRONT', '    CMP R0, 80', '    JG move_done', '    TURN 90', 'move_done:']), (l) => l.includes('Leave out WAIT'), [])
      .replace('attack:\n    RET\n', attackFn + '\n'),
  };
  for (const m of BB.MISSIONS) {
    assert.ok(m.hint && m.hint2, `${m.id} has both hints`);
    const c = BB.assemble(follow[m.id](m.starter));
    assert.deepStrictEqual(c.errors, [], m.id);
    for (const seed of [1, 2, 3]) {
      const w = BB.buildMission(m, c, seed);
      for (let t = 0; t <= m.maxTicks && !w.over; t++) w.step();
      assert.ok(w.mission.result && w.mission.result.ok, `${m.id} seed ${seed}: ${w.mission.result && w.mission.result.text}`);
    }
  }
});

test('Start and Step run the code in the editor, never its old version', () => {
  const app = uiHarness();
  app.world.step(); // mid-match, so applying hot-swaps instead of resetting
  const e = app.selected, robot = app.robotFor(0);
  e.draft = 'A\nMOV R3, 77\nWAIT';
  app.stepOnce();
  assert.strictEqual(e.source, e.draft, 'the edit was applied');
  assert.strictEqual(robot.vm.regs[3], 77, 'and it ran');
  e.draft = 'A\nSPED 5';
  const tick = app.world.tick;
  app.stepOnce();
  assert.strictEqual(app.world.tick, tick, 'broken code does not run');
  assert.match(app.message, /Your code has errors/);
  assert.notStrictEqual(e.source, e.draft, 'and is not applied');
});

test('applying a comment-only edit mid-match keeps the robot\'s CPU running', () => {
  const app = uiHarness();
  const e = app.selected, robot = app.robotFor(0);
  for (let i = 0; i < 3; i++) app.world.step();
  const cpu = robot.vm, r0 = cpu.regs[0];
  e.draft = 'A\n; a new comment\n    INC R0   ; count\nWAIT';
  app.applyDraft();
  assert.strictEqual(robot.vm, cpu, 'same CPU');
  assert.strictEqual(robot.vm.regs[0], r0, 'registers kept');
  assert.strictEqual(robot.vm.program[0].line, 3, 'new line numbers');
  assert.match(app.message, /kept going/);
  e.draft = 'A\nINC R1\nWAIT';
  app.applyDraft();
  assert.notStrictEqual(robot.vm, cpu, 'a real code change still reloads');
});

test('an unfinished mission edit comes back as a draft and never empties the arena', () => {
  const app = uiHarness();
  const def = BB.MISSIONS.find((m) => m.id === 'coords');
  const broken = def.starter.replace('; <- turn dy and dx', 'ATAN4 ; <- turn dy and dx');
  const applied = def.solution;
  const load = (saved) => {
    app.missionState = { done: [], code: saved === undefined ? {} : { coords: saved }, fails: {} };
    const r = app.missionCodeFor(def);
    assert.deepStrictEqual(BB.assemble(r.source).errors, [], 'the arena code always assembles');
    return { source: r.source, draft: r.draft }; // a plain object from this realm, for deepStrictEqual
  };
  assert.deepStrictEqual(load(), { source: def.starter, draft: def.starter }, 'nothing saved: the starter');
  assert.deepStrictEqual(load(applied), { source: applied, draft: applied }, 'old save, valid: run it');
  assert.deepStrictEqual(load(broken), { source: def.starter, draft: broken }, 'old save, unfinished: starter runs, edit kept');
  assert.deepStrictEqual(load({ source: applied, draft: broken }), { source: applied, draft: broken }, 'last applied code runs, edit kept');
  assert.deepStrictEqual(load({ source: broken, draft: 5 }), { source: def.starter, draft: def.starter }, 'damaged save falls back');
  assert.deepStrictEqual(load(null), { source: def.starter, draft: def.starter });
});

test('failed mission attempts are counted, unlocking more help', () => {
  const app = uiHarness();
  const def = BB.MISSIONS[0];
  app.mission = def;
  app.missionState = { done: [], code: {}, fails: {} };
  app.renderMissionBar = app.renderMissions = () => {};
  for (let attempt = 0; attempt < 2; attempt++) {
    app.world = BB.buildMission(def, BB.assemble(def.starter));
    app.missionReported = false;
    while (!app.world.over) app.world.step();
    app.checkMissionResult();
  }
  assert.strictEqual(app.missionState.fails[def.id], 2);
  assert.deepStrictEqual([...app.missionState.done], []);
});

test('every mission: starter assembles but does not pass, solution passes in time', () => {
  const ids = new Set();
  for (const def of BB.MISSIONS) {
    assert.ok(!ids.has(def.id), `duplicate mission id ${def.id}`);
    ids.add(def.id);
    for (const which of ['starter', 'solution']) {
      const c = BB.assemble(def[which]);
      assert.deepStrictEqual(c.errors, [], `${def.id} ${which}`);
      const w = BB.buildMission(def, c);
      assert.deepStrictEqual([w.robots[0].x, w.robots[0].y, w.robots[0].entryId], [def.start.x, def.start.y, BB.MISSION_ENTRY_ID]);
      for (let i = 0; i <= def.maxTicks && !w.over; i++) w.step();
      assert.ok(w.mission.result, `${def.id} ${which} ends by maxTicks`);
      assert.strictEqual(w.mission.result.ok, which === 'solution', `${def.id} ${which}: ${w.mission.result.text}`);
    }
  }
});

test('mission units list every mission exactly once, in order', () => {
  const listed = BB.MISSION_UNITS.flatMap((u) => u.ids);
  assert.deepStrictEqual(listed, BB.MISSIONS.map((m) => m.id));
});

test('unit 2 missions explain what went wrong, not just that it did', () => {
  const M = (id) => BB.MISSIONS.find((m) => m.id === id);
  const play = (id, edit) => {
    const def = M(id);
    const w = BB.buildMission(def, BB.assemble(edit(def.solution)));
    for (let t = 0; t <= def.maxTicks && !w.over; t++) w.step();
    return w.mission.result;
  };
  assert.match(play('park', (s) => s.replace('CMP  R0, 500', 'CMP  R0, 600')).text, /parked at x = 6\d\d\. The zone goes from x = 480/);
  assert.ok(play('park', (s) => s.replace('CMP  R0, 500', 'CMP  R0, 590')).ok, 'stopping near the far edge still fits');
  assert.match(play('sweep', (s) => s.replace('ADD  R1, 30', 'SUB  R1, 30')).text, /too many misses/);
  assert.ok(play('sweep', (s) => s.replace('ADD  R1, 30', 'ADD  R1, 15')).ok, 'smaller steps still work');
  assert.match(play('laps', (s) => s.replace('CMP  R5, 180', 'CMP  R5, 60')).text, /stopped after 1\.0 laps\. The goal is 3/);
  assert.ok(play('laps', (s) => s.replace('INC  R5', 'ADD  R5, 1')).ok, 'ADD R5, 1 counts too');
  assert.match(play('call', (s) => s.replace('    RET', '')).text, /Every CALL needs a RET/);
  assert.match(play('call', (s) => s.replace('MOV  R1, 45', 'MOV  R1, 90')).text, /comes back now, so check the angles/);
  assert.match(play('boss', (s) => s.replace('    TURN 90\n    SPEED 5\n', '')).text, /Too many hits/);
  assert.ok(play('boss', (s) => s.replace('TURN 90', 'TURN -90')).ok, 'turning the other way also dodges');
  // The hint says to reuse the Mission 5 answer, so any reasonable one must beat the boss.
  for (const turn of [30, 45, 90, -90, 180]) for (const speed of [3, 4, 5]) {
    assert.ok(play('boss', (s) => s.replace('TURN 90\n    SPEED 5', `TURN ${turn}\n    SPEED ${speed}`)).ok, `TURN ${turn}, SPEED ${speed}`);
  }
});

test('unit 3: sensible answers pass, mistakes get feedback that points the right way', () => {
  const M = (id) => BB.MISSIONS.find((m) => m.id === id);
  const play = (id, src, seed = 1) => {
    const def = M(id), w = BB.buildMission(def, BB.assemble(src), seed);
    for (let t = 0; t <= def.maxTicks && !w.over; t++) w.step();
    return w.mission.result;
  };
  const ex = M('explore').solution;
  for (const [gap, turn] of [[40, 90], [80, 90], [120, 90], [80, -90], [80, 45]]) {
    assert.ok(play('explore', ex.replace('CMP  R0, 80', `CMP  R0, ${gap}`).replace('TURN 90', `TURN ${turn}`)).ok, `explore gap ${gap} turn ${turn}`);
  }
  assert.match(play('explore', M('explore').starter).text, /Stuck against something\? Check FRONT/);
  assert.match(play('explore', ex.replace('SPEED 3', 'SPEED 2').replace('CMP  R0, 80', 'CMP  R0, 60')).text, /Drive a little faster/);
  // Driving in circles covers the distance without using FRONT.
  for (const [speed, turn] of [[5, 90], [3, 3]]) {
    assert.match(play('explore', `E\nloop:\n    SPEED ${speed}\n    TURN ${turn}\n    WAIT\n    JMP loop`).text, /going round in circles/, `circle ${speed}/${turn}`);
  }

  const fo = M('follow').solution;
  for (const d of [60, 100, 140]) assert.ok(play('follow', fo.replace('CMP  R1, 100', `CMP  R1, ${d}`)).ok, `follow at ${d}`);
  assert.match(play('follow', M('follow').starter).text, /Is "JMP done" there/, 'no jumps: both speeds run');
  assert.match(play('follow', fo.replace('    JMP  done\n', '')).text, /Is "JMP done" there/);
  for (const sp of [2, 4]) assert.ok(!play('follow', fo.replace(/    CMP  R1, 100[\s\S]*?done:\n/, `    SPEED ${sp}\n`)).ok, `no IF / ELSE, always SPEED ${sp}`);
  const parkNear = 'F\nmain:\n    GET  R0, X\n    CMP  R0, 480\n    JGE  p\n    SPEED 4\n    WAIT\n    JMP  main\np:\n    SPEED 0\n    WAIT\n    JMP  p';
  assert.match(play('follow', parkNear).text, /stayed close \d+% of the time\. The goal is 85%/, 'parking in one spot');

  const scanner = BB.MISSIONS.find((m) => m.id === 'scan').solution;
  for (let seed = 1; seed <= 10; seed++) {
    assert.ok(play('coords', M('coords').solution, seed).ok, `coords seed ${seed}`);
    assert.ok(!play('coords', M('coords').starter, seed).ok, `coords starter seed ${seed}`);
    assert.ok(!play('coords', scanner, seed).ok, `coords: SCAN can't see the stealth target, seed ${seed}`);
  }
  assert.match(play('coords', M('coords').solution.replace('ATAN2 R4, R3, R2', 'ATAN2 R4, R2, R3')).text, /Eight misses/);

  const lead = (n) => play('lead', M('lead').starter.replace('.def LEAD 0 ', `.def LEAD ${n}`));
  for (const n of [0, 4, 6]) assert.match(lead(n).text, /passed behind the target: try a bigger LEAD/, `LEAD ${n}`);
  for (const n of [8, 10, 12, 14]) assert.ok(lead(n).ok, `LEAD ${n} should pass`);
  for (const n of [16, 20]) assert.match(lead(n).text, /passed in front of the target: try a smaller LEAD/, `LEAD ${n}`);

  const gr = M('graduate');
  assert.ok(play('graduate', gr.withDodge).ok, 'adding the dodge still wins');
  assert.ok(!play('graduate', gr.solution.replace('    CALL move\n', '')).ok, 'attacking without moving loses');
  // Rival can lose health to walls, so out-lasting it without ever firing must not count as a win.
  const noAttack = gr.solution.replace(/attack:[\s\S]*?\n {4}RET\nturn_turret:[\s\S]*?RET/, 'attack:\n    RET');
  assert.notStrictEqual(noAttack, gr.solution, 'the attack function was removed');
  assert.match(play('graduate', noAttack).text, /Rival was never hit/, 'moving without attacking fails');
});

test('Mission control keeps the target\'s coordinates in memory, even after a program reload', () => {
  const def = BB.MISSIONS.find((m) => m.id === 'coords');
  const w = BB.buildMission(def, BB.assemble('Idle\nWAIT'), 42);
  const me = w.robots[0], t = w.robots[1];
  assert.deepStrictEqual([me.vm.mem[0], me.vm.mem[1]], [Math.round(t.x), Math.round(t.y)], 'ready before the first tick');
  assert.strictEqual(w.mission.labels[0].text, `(${Math.round(t.x)}, ${Math.round(t.y)})`);
  me.vm = new BB.VM(BB.assemble(def.solution).program, w.makeIO(me)); // like pressing Apply mid-mission
  w.step();
  assert.deepStrictEqual([me.vm.mem[0], me.vm.mem[1]], [Math.round(t.x), Math.round(t.y)]);
  const other = BB.buildMission(def, BB.assemble('Idle\nWAIT'), 43).robots[1];
  assert.ok(other.x !== t.x || other.y !== t.y, 'a new seed moves the target');
});

test('Dodge accepts any turn-and-drive answer but not half of one', () => {
  const def = BB.MISSIONS.find((m) => m.id === 'dodge');
  const run = (body) => {
    const w = BB.buildMission(def, BB.assemble(`D\nmain:\n    RADAR\n    GET R0, THREAT_DIST\n    CMP R0, -1\n    JE safe\n${body}safe:\n    WAIT\n    JMP main`));
    while (!w.over) w.step();
    return w.mission.result.ok;
  };
  for (const body of ['    TURN -90\n    SPEED 5\n', '    TURN 45\n    SPEED 5\n', '    TURN 90\n    SPEED 3\n']) assert.ok(run(body), body);
  for (const body of ['    SPEED 5\n', '    TURN 90\n']) assert.ok(!run(body), body);
});

test('a mission result is reported once and a pass is remembered', () => {
  const app = uiHarness();
  const def = BB.MISSIONS[0];
  app.mission = def;
  app.missionState = { done: [], code: {} };
  app.renderMissionBar = app.renderMissions = () => {};
  app.world = BB.buildMission(def, BB.assemble(def.solution));
  app.missionReported = false;
  app.running = true;
  while (!app.world.over) app.world.step();
  app.checkMissionResult();
  app.checkMissionResult();
  assert.deepStrictEqual([[...app.missionState.done], app.running], [[def.id], false]);
  assert.match(app.message, /Mission complete/);
});

test('in a mission, applying changed code starts the attempt again, so a correct fix passes', () => {
  const app = uiHarness();
  const def = BB.MISSIONS.find((m) => m.id === 'laps');
  app.missionState = { done: [], code: {}, fails: {} };
  app.renderMissionBar = app.renderMissions = () => {};
  app.renderer = { clearEffects() {} };
  app.mission = def;
  app.missionEntry = app.makeEntry('laps.asm', def.starter, { id: BB.MISSION_ENTRY_ID });
  app.selectedId = BB.MISSION_ENTRY_ID;
  app.resetMatch();
  const e = app.missionEntry;
  for (let i = 0; i < 50; i++) app.world.step();
  e.draft = `${e.source}\n; just a note`;
  app.applyDraft();
  assert.strictEqual(app.world.tick, 50, 'comments only: the attempt carries on');
  for (let i = 0; i < 50; i++) app.world.step();
  // Mid-attempt, the starter has already driven 1.6 laps. Continuing would fail the fix with "4.7 laps".
  e.draft = def.solution;
  app.running = true;
  app.applyDraft();
  assert.deepStrictEqual([app.world.tick, app.running], [0, true], 'a fresh attempt, still running');
  assert.match(app.message, /mission starts again with your new code/);
  while (!app.world.over) app.world.step();
  assert.ok(app.world.mission.result.ok, app.world.mission.result.text);
});

test('Step after the end says how to play again', () => {
  const app = uiHarness();
  app.world.over = true;
  app.stepOnce();
  assert.match(app.message, /The match is over\. Press ▶ Rematch/);
  app.mission = BB.MISSIONS[0];
  app.stepOnce();
  assert.match(app.message, /This attempt is over\. Press ▶ Try again/);
});

test('missions say what to change when time runs out', () => {
  const play = (id, src) => {
    const def = BB.MISSIONS.find((m) => m.id === id);
    const w = BB.buildMission(def, BB.assemble(src || def.starter));
    while (!w.over) w.step();
    return w.mission.result;
  };
  for (const [id, src, re] of [
    ['drive', null, /never moved\. Change SPEED 0 to a bigger number/],
    ['drive', 'R\nmain:\n    SPEED -2\n    WAIT\n    JMP main', /drove backward, away from the goal/],
    ['drive', 'R\nmain:\n    SPEED 1\n    WAIT\n    JMP main', /Try a bigger SPEED/],
    ['angles', null, /faced right, but the goal is up\. Which HEAD number points up\?/],
    ['aim', null, /shots missed\. Your turret points at 0°/],
    ['aim', 'A\nmain:\n    AIM 315\n    WAIT\n    JMP main', /never fired/],
    ['scan', null, /never fired\. Keep FIRE on the line right after AIM R2/],
    ['coords', 'N\nmain:\n    WAIT\n    JMP main', /never fired/],
    ['lead', 'P\nmain:\n    WAIT\n    JMP main', /never fired/],
  ]) {
    const result = play(id, src);
    assert.ok(!result.ok, id);
    assert.match(result.text, re, `${id}: ${result.text}`);
  }
});

test('Reset mission progress clears progress, hints and mission code, but keeps the robots', () => {
  const app = uiHarness();
  app.missionState = { done: ['drive'], code: { drive: { source: 'X', draft: 'X' } }, fails: { drive: 3 } };
  app.renderMissions = () => {};
  app.resetMissionProgress();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(app.missionState)), { done: [], code: {}, fails: {} });
  assert.strictEqual(app.entries.length, 1, 'the roster stays');
  assert.match(app.message, /Mission progress reset/);
});

test('editor hover help is plain in Simple view, technical otherwise, with live values', () => {
  const app = uiHarness();
  app.simple = true;
  assert.match(app.helpFor('cmp'), /just remembers which one is bigger/);
  assert.match(app.helpFor('SCAN'), /3 coins/);
  assert.match(app.helpFor('HEALTH'), /How much health I have left[\s\S]*Right now: <b>100<\/b>/);
  app.world.step();
  assert.match(app.helpFor('r0'), /A box that holds one number[\s\S]*Right now: <b>1<\/b>/);
  assert.strictEqual(app.helpFor('loop'), null);
  assert.match(app.helpFor('scan'), /data-ref="ins:SCAN"[^>]*>More in Reference/);
  assert.match(app.helpFor('health'), /data-ref="sensor:HEALTH"/);
  assert.match(app.helpFor('R3'), /data-ref="sec:basics"/);
  app.simple = false;
  assert.ok(app.helpFor('CMP').includes(BB.ISA.INSTRUCTION_MAP.CMP.summary.slice(0, 30)));
  assert.match(app.helpFor('SCAN'), /3 cycles/);
});

test('hover help reads words where they are written (directives, presets, labels, constants)', () => {
  const src = 'Bot\n.turret standard\n.def X 5\n.def FAST 4\nfront: GET R0, TURRET ; turret\n    SPEED FAST\n    ADD R1, X\n    JMP front';
  const at = (row, word, from = 0) => BB.assist.wordContext(src, row, src.split('\n')[row].indexOf(word, from));
  const role = (...a) => { const c = at(...a); return c && c.role; };
  assert.deepStrictEqual({ ...at(1, 'turret') }, { role: 'directive', word: 'turret', key: 'turret' });
  assert.deepStrictEqual({ ...at(1, 'standard') }, { role: 'preset', word: 'standard', key: 'turret' });
  assert.strictEqual(role(2, 'def'), 'directive');
  assert.deepStrictEqual({ ...at(2, 'X') }, { role: 'constant', word: 'X', value: '5' });
  assert.strictEqual(role(4, 'front'), 'label');
  assert.strictEqual(role(4, 'GET'), 'instruction');
  assert.strictEqual(role(4, 'R0'), 'register');
  assert.strictEqual(role(4, 'TURRET'), 'sensor');
  assert.strictEqual(at(4, 'turret', 20), null); // in a comment
  assert.strictEqual(role(5, 'FAST'), 'constant');
  assert.strictEqual(role(6, 'X'), 'constant'); // a constant, not the X sensor
  assert.strictEqual(role(7, 'front'), 'label'); // a label, not the FRONT sensor
  assert.strictEqual(at(0, 'Bot'), null); // the name line

  const app = uiHarness();
  app.editor.value = src;
  const hover = (row, word) => app.helpFor(word, { line: row + 1, index: src.split('\n')[row].indexOf(word) });
  assert.match(hover(1, 'turret'), /appearance[\s\S]*twin[\s\S]*data-ref="sec:appearance"/);
  assert.doesNotMatch(hover(1, 'turret'), /sensor/);
  assert.match(hover(1, 'standard'), /appearance/);
  assert.match(hover(6, 'X'), /constant[\s\S]*<b>5<\/b>/);
  assert.match(hover(4, 'TURRET'), /sensor[\s\S]*data-ref="sensor:TURRET"/);
  assert.match(hover(7, 'front'), /label/);
  app.simple = true;
  assert.match(hover(2, 'def'), /Uses no coins/);
  app.simple = false;
  assert.match(hover(2, 'def'), /Uses no cycles/);
});

test('Step records a trace for the selected robot only', () => {
  const app = uiHarness();
  app.stepOnce();
  const [mine, other] = app.world.robots;
  assert.deepStrictEqual(Array.from(mine.vm.trace, (t) => [t.line, t.asm, t.note]), [[2, 'INC R0', 'R0 = 1'], [3, 'WAIT', 'end of turn']]);
  assert.strictEqual(other.vm.trace, null);
});

test('robots that cannot spawn randomly still start clear of obstacles', () => {
  // Walls everywhere except a 70x70 pocket: random tries almost never land in it.
  const obstacles = [
    { x: 0, y: 0, w: 300, h: 600 }, { x: 370, y: 0, w: 430, h: 600 },
    { x: 300, y: 0, w: 70, h: 250 }, { x: 300, y: 320, w: 70, h: 280 },
  ];
  for (const seed of [1, 2, 3]) {
    const w = new BB.World({ entries: [compile('A\nWAIT', 0)], obstacles, seed });
    const r = w.robots[0];
    for (const o of obstacles) assert.strictEqual(BB.geo.circleRectPush(r.x, r.y, BB.CONFIG.ROBOT_RADIUS, o), null, `seed ${seed}: ${r.x},${r.y}`);
  }
});

test('long names are truncated without splitting an emoji', () => {
  const res = BB.assemble(`${'A'.repeat(23)}🤖🤖\nWAIT`);
  assert.strictEqual(res.name, `${'A'.repeat(23)}🤖`);
  assert.strictEqual(res.warnings.length, 1);
  assert.strictEqual(BB.assemble(`${'A'.repeat(23)}🤖\nWAIT`).warnings.length, 0, '24 characters fit');
});

test('breakpoints move with the code as it is edited', () => {
  const app = uiHarness();
  const e = app.selected;
  const src = 'A\nmain:\n    INC R0\n    INC R1\n    WAIT\n    JMP main';
  const edit = (before, after, marks) => {
    e.breakpoints = new Set(marks);
    app.moveBreakpoints(e, before, after);
    return [...e.breakpoints];
  };
  const insertAbove = src.replace('main:', '; note\n; more\nmain:');
  assert.deepStrictEqual(edit(src, insertAbove, [4]), [6], 'two lines inserted above');
  assert.deepStrictEqual(edit(src, src.replace('    INC R0\n', ''), [4]), [3], 'a line deleted above');
  assert.deepStrictEqual(edit(src, src.replace('INC R1', 'INC R2'), [4]), [4], 'typing on the breakpoint line keeps it');
  assert.deepStrictEqual(edit(src, src.replace('    INC R1\n', ''), [4]), [], 'deleting the breakpoint line drops it');
  assert.deepStrictEqual(edit(src, src + '\n; tail', [3, 4]), [3, 4], 'edits below change nothing');
  assert.deepStrictEqual(app.editor.breakpoints, [3, 4], 'the gutter follows');
});

test('breakpoints pause only while the editor matches the applied code', () => {
  const app = uiHarness();
  const e = app.selected;
  e.breakpoints = new Set([3]);
  app.syncDebugger();
  assert.ok(app.robotFor(0).vm.breakLines, 'active when draft = applied code');
  e.draft = e.source + '\n; unapplied edit';
  app.syncDebugger();
  assert.strictEqual(app.robotFor(0).vm.breakLines, null, 'paused while editing');
});

test('breakpoints only go on instruction lines and follow the applied code', () => {
  const app = uiHarness();
  const e = app.selected;
  app.toggleBreakpoint(1);
  assert.match(app.message, /lines with an instruction/);
  app.toggleBreakpoint(2);
  app.toggleBreakpoint(3);
  assert.deepStrictEqual([...e.breakpoints], [2, 3]);
  app.toggleBreakpoint(2);
  assert.deepStrictEqual([...e.breakpoints], [3]);
  app.toggleBreakpoint(2);
  app.world.step();
  e.draft = 'A\nINC R0\n\nWAIT';
  app.applyDraft();
  assert.deepStrictEqual([...e.breakpoints], [2], 'line 3 is now blank');
  assert.deepStrictEqual(app.editor.breakpoints, [2]);
});

test('Step rejects incomplete teams and allows ready teams and solo practice', () => {
  for (const mode of ['2v2', '3v3']) {
    const app = uiHarness(mode);
    app.stepOnce();
    assert.strictEqual(app.world.tick, 0);
    assert.match(app.message, /working robots on each team/);
    app.entries = Array.from({ length: 2 * app.teamSize }, (_, i) => ({
      ...app.entries[0], id: i, team: i < app.teamSize ? 'A' : 'B',
    }));
    app.stepOnce();
    assert.strictEqual(app.world.tick, 1);
  }
  const app = uiHarness();
  app.world = new BB.World({ entries: [compile('Solo\nWAIT', 0)] });
  app.stepOnce();
  assert.strictEqual(app.world.tick, 1);
  assert.strictEqual(app.world.over, false);
});

test('FRONT measures body clearance at rounded obstacle corners and diagonal walls', () => {
  const obstacle = { x: 100, y: 200, w: 20, h: 100 };
  const w = new BB.World({ entries: [compile('A\nWAIT', 0)], obstacles: [obstacle] });
  const r = w.robots[0];
  for (const [x, y, heading, expected] of [
    [84, 190, 0, 16 - Math.sqrt(156)],
    [136, 190, 180, 16 - Math.sqrt(156)],
    [84, 310, 0, 16 - Math.sqrt(156)],
    [136, 310, 180, 16 - Math.sqrt(156)],
    [80, 250, 0, 4],
  ]) {
    Object.assign(r, { x, y, heading });
    const distance = w.freeDistance(r);
    assert.ok(Math.abs(distance - expected) < 1e-8, `clearance=${distance}, expected=${expected}`);
    const dx = Math.cos(heading * BB.geo.DEG), dy = Math.sin(heading * BB.geo.DEG);
    assert.strictEqual(BB.geo.circleRectPush(x + dx * (distance - 1e-4), y + dy * (distance - 1e-4), 16, obstacle), null);
    assert.ok(BB.geo.circleRectPush(x + dx * (distance + 1e-4), y + dy * (distance + 1e-4), 16, obstacle));
  }
  // A bounding-box expansion would incorrectly report a nearby corner here.
  Object.assign(r, { x: 84, y: 180, heading: 0 });
  assert.strictEqual(w.freeDistance(r), 700);
  Object.assign(r, { x: 84, y: 250, heading: 180 });
  assert.strictEqual(w.freeDistance(r), 68, 'touching an obstacle behind us should allow driving away');
  w.obstacles = [];
  Object.assign(r, { x: 100, y: 100, heading: 225 });
  assert.ok(Math.abs(w.freeDistance(r) - 84 * Math.sqrt(2)) < 1e-8);
});

test('collision solver separates crowds at walls, obstacles and coincident positions', () => {
  const obstacle = { x: 100, y: 200, w: 20, h: 100 };
  for (const setup of [
    { positions: [[16, 300], [40, 300]], obstacles: [] },
    { positions: Array.from({ length: 6 }, (_, i) => [16 + i * 24, 300]), obstacles: [] },
    { positions: [[136, 250], [160, 250], [184, 250]], obstacles: [obstacle] },
    { positions: [[300, 300], [300, 300], [300, 300]], obstacles: [] },
    { positions: [[16, 16], [35, 35], [50, 16]], obstacles: [] },
  ]) {
    const w = new BB.World({ entries: setup.positions.map((_, i) => compile(`Bot${i}\nWAIT`, i)), obstacles: setup.obstacles });
    w.robots.forEach((r, i) => Object.assign(r, { x: setup.positions[i][0], y: setup.positions[i][1] }));
    w.step();
    for (const r of w.robots) {
      assert.ok(r.x >= 16 && r.x <= 784 && r.y >= 16 && r.y <= 584);
      for (const o of w.obstacles) {
        const overlap = BB.geo.circleRectPush(r.x, r.y, 16, o);
        assert.ok(!overlap || overlap.depth < 1e-6);
      }
      for (const other of w.robots) if (other !== r) {
        assert.ok(Math.hypot(r.x - other.x, r.y - other.y) >= 32 - 1e-6, 'robot overlap remains');
      }
    }
  }
});

test('iterative collision correction charges ram damage once and preserves friendly safety', () => {
  for (const friendly of [false, true]) {
    const entries = [0, 1].map((id) => ({ ...compile(`Bot${id}\nWAIT`, id), team: friendly ? 0 : undefined }));
    const w = new BB.World({ entries, arena: 'open' });
    Object.assign(w.robots[0], { x: 16, y: 300, heading: 0, targetHeading: 0 });
    Object.assign(w.robots[1], { x: 43, y: 300, heading: 180, targetHeading: 180, speed: 2, targetSpeed: 2 });
    w.step();
    assert.deepStrictEqual(w.robots.map((r) => r.health), friendly ? [100, 100] : [99, 99]);
    assert.strictEqual(w.events.filter((e) => e.type === 'bump').length, friendly ? 0 : 1);
  }
});

test('RAND streams are per robot: an opponent\'s random calls never change yours', () => {
  const draws = (opponentSrc, seed = 5) => {
    const w = new BB.World({ entries: [compile('Me\nRAND R0, 1000000\nWAIT', 0), compile(opponentSrc, 1)], arena: 'open', seed });
    const seen = [];
    for (let t = 0; t < 20; t++) { w.step(); seen.push(w.robots[0].vm.regs[0]); }
    return seen;
  };
  const quiet = draws('Quiet\nWAIT');
  assert.deepStrictEqual(draws('Noisy\nRAND R1, 7\nRAND R1, 7\nRAND R1, 7\nWAIT'), quiet);
  assert.deepStrictEqual(draws('Quiet\nWAIT'), quiet, 'same seed replays the same draws');
  assert.notDeepStrictEqual(draws('Quiet\nWAIT', 6), quiet, 'a different seed gives different draws');
  const w = new BB.World({ entries: [0, 1].map((id) => compile(`Twin\nRAND R0, 1000000\nWAIT`, id)), arena: 'open', seed: 5 });
  w.step();
  assert.notStrictEqual(w.robots[0].vm.regs[0], w.robots[1].vm.regs[0], 'roster slots get distinct streams');
});

test('SCAN reach shrinks with cone width and is reported by SCAN_RANGE', () => {
  const probe = (width, foeX) => {
    const w = new BB.World({ entries: [compile(`Probe\nGET R2, SCAN_RANGE\nSCAN ${width}\nGET R0, SCAN_DIST\nGET R1, SCAN_RANGE\nWAIT`, 0), compile('Foe\nWAIT', 1)], arena: 'open' });
    Object.assign(w.robots[0], { x: 20, y: 300, turret: 0, targetTurret: 0 });
    Object.assign(w.robots[1], { x: foeX, y: 300 });
    w.step();
    return [...w.robots[0].vm.regs.slice(0, 3)];
  };
  assert.deepStrictEqual(BB.World.scanRange(90), 252);
  assert.deepStrictEqual(BB.World.scanRange(16), 600);
  assert.deepStrictEqual(probe(90, 20 + 252), [252, 252, 0], 'exactly at range is seen; SCAN_RANGE starts at 0');
  assert.deepStrictEqual(probe(90, 20 + 253), [-1, 252, 0], 'just past a wide cone\'s reach');
  assert.deepStrictEqual(probe(16, 20 + 500), [500, 600, 0], 'a narrow cone sees farther');
  assert.deepStrictEqual(probe(500, 20 + 253), [-1, 252, 0], 'width clamps to 90 before the range is computed');
});

test('mud caps speed while the center is inside, and MUD reports it', () => {
  const patch = { x: 200, y: 250, w: 100, h: 100 };
  const w = new BB.World({ entries: [compile('Racer\nSPEED 5\nGET R0, MUD\nGET R1, SPEED\nWAIT', 0)], obstacles: [], mud: [patch] });
  const r = w.robots[0];
  Object.assign(r, { x: 100, y: 300, heading: 0, targetHeading: 0, speed: 5, targetSpeed: 5 });
  const trace = [];
  for (let t = 0; t < 100; t++) { const from = r.x; w.step(); trace.push({ from, speed: r.speed, mud: r.vm.regs[0] }); }
  // The cap uses where the robot starts the tick: it can arrive at full speed, then bogs down.
  for (const s of trace) {
    if (BB.geo.pointInRect(s.from, 300, patch)) assert.ok(s.speed <= BB.CONFIG.MUD_MAX_SPEED, `speed ${s.speed} in mud from x=${s.from}`);
  }
  assert.ok(trace.filter((s) => BB.geo.pointInRect(s.from, 300, patch)).length >= 45, 'crossing 100 units of mud takes ~50 ticks');
  assert.ok(trace.some((s) => s.mud === 1) && trace.some((s) => s.mud === 0), 'MUD toggles on and off');
  assert.strictEqual(trace[trace.length - 1].speed, 5, 'full speed again after leaving the mud');
  // Reversing is capped too.
  Object.assign(r, { x: 250, y: 300, speed: -3, targetSpeed: -3 });
  w.robots[0].vm = new BB.VM(BB.assemble('Back\nWAIT').program, w.makeIO(r));
  w.step();
  assert.strictEqual(r.speed, -BB.CONFIG.MUD_MAX_SPEED);
});

test('mud is mirrored, clear of obstacles, and absent on Open or with explicit obstacles', () => {
  const W = BB.CONFIG.ARENA_W, H = BB.CONFIG.ARENA_H;
  const entries = [compile('A\nWAIT', 0), compile('B\nWAIT', 1)];
  const key = (m) => `${m.x},${m.y},${m.w},${m.h}`;
  for (let seed = 1; seed <= 50; seed++) {
    const w = new BB.World({ entries, seed, arena: 'random' });
    assert.ok(w.mud.length >= 2, `seed ${seed}: no mud`);
    const set = new Set(w.mud.map(key));
    for (const m of w.mud) {
      assert.ok(set.has(key({ x: W - m.x - m.w, y: H - m.y - m.h, w: m.w, h: m.h })), `seed ${seed}: unmirrored mud`);
      for (const o of w.obstacles) {
        const overlap = m.x < o.x + o.w && o.x < m.x + m.w && m.y < o.y + o.h && o.y < m.y + m.h;
        assert.ok(!overlap, `seed ${seed}: mud overlaps an obstacle`);
      }
    }
    assert.deepStrictEqual(w.obstacles, BB.World.makeObstacles('random', seed), 'mud leaves obstacle layouts unchanged');
  }
  assert.deepStrictEqual(new BB.World({ entries, arena: 'classic' }).mud, BB.World.DEFAULT_MUD);
  assert.deepStrictEqual(new BB.World({ entries, arena: 'open' }).mud, []);
  assert.deepStrictEqual(new BB.World({ entries, obstacles: [] }).mud, []);
});

test('wall damage from being shoved by an enemy is credited to the pusher', () => {
  const entries = [0, 1].map((id) => compile(`Bot${id}\nWAIT`, id));
  const w = new BB.World({ entries, arena: 'open' });
  Object.assign(w.robots[0], { x: 17, y: 300, heading: 0, targetHeading: 0, speed: 4, targetSpeed: 4, health: 2 });
  Object.assign(w.robots[1], { x: 40, y: 300, heading: 180, targetHeading: 180, speed: 5, targetSpeed: 5 });
  w.step();
  assert.strictEqual(w.robots[0].alive, false);
  assert.strictEqual(w.robots[1].stats.damageDealt, 2, 'ram damage plus the wall damage');
  assert.ok(w.log.some((l) => l.kind === 'death' && /by Bot1, shoved into a wall/.test(l.text)));
});

const speedAt = (x) => uiBB.App.SPEEDS.indexOf(x); // slider position of a playback speed
function playbackHarness(speedIndex = speedAt(1)) {
  const app = uiHarness();
  app.world = new BB.World({ entries: [compile('Solo\nWAIT', 0)], arena: 'open' });
  Object.assign(app, { running: true, acc: 0, lastFrameTime: null, lastPanelUpdate: 0, speedIndex,
    renderer: { addEvents() {}, draw() {} } });
  return app;
}

test('playback advances equally at 30, 60, 120 and 144 Hz for fractional and fast speeds', () => {
  for (const [speedIndex, ticks] of [[speedAt(0.1), 6], [speedAt(0.75), 45], [speedAt(1), 60], [speedAt(60), 3600]]) {
    for (const hz of [30, 60, 120, 144]) {
      const app = playbackHarness(speedIndex);
      app.frame(0);
      for (let frame = 1; frame <= hz; frame++) app.frame(frame * 1000 / hz);
      assert.strictEqual(app.world.tick, ticks, `speed index ${speedIndex}, ${hz}Hz`);
    }
  }
});

test('playback pause/resume ignores suspended time and bounds stall catch-up', () => {
  const app = playbackHarness();
  app.frame(0);
  app.frame(1000 / 60);
  assert.strictEqual(app.world.tick, 1);
  app.toggleRun();
  app.frame(60000);
  assert.strictEqual(app.world.tick, 1);
  app.toggleRun();
  app.frame(60010);
  app.frame(60010 + 1000 / 60);
  assert.strictEqual(app.world.tick, 2);
  const fast = playbackHarness(speedAt(60));
  fast.frame(0);
  fast.frame(60000);
  assert.strictEqual(fast.world.tick, 200);
  fast.frame(60000 + 1000 / 60);
  assert.strictEqual(fast.world.tick, 260, 'stall backlog should be discarded');
});

test('CLI rejects malformed and missing integer options before reading robot files', () => {
  const { spawnSync } = require('child_process');
  for (const option of ['--rounds', '--seed', '--teams']) {
    for (const value of ['nope', '0', '-1', '1.5', '2junk', '9007199254740992', undefined]) {
      const args = ['tools/headless.js', option];
      if (value !== undefined) args.push(value, 'missing-robot.asm');
      const result = spawnSync(process.execPath, args, { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 5000 });
      assert.ifError(result.error);
      assert.strictEqual(result.status, 2, `${option} ${value}: ${result.stderr}`);
      assert.match(result.stderr, /requires a positive integer/);
      assert.doesNotMatch(result.stderr, /ENOENT/);
      assert.strictEqual(result.stdout, '');
    }
  }
  const overflow = spawnSync(process.execPath, ['tools/headless.js', '--seed', '4294967295', '--rounds', '2', 'missing-robot.asm'], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 5000,
  });
  assert.strictEqual(overflow.status, 2);
  assert.match(overflow.stderr, /seed range/);
});

test('appearance presets are optional, case-insensitive metadata with unchanged instruction indices', () => {
  const plain = { color: 'auto', decal: 'none', badge: 'none', trail: 'none', boom: 'fire', shot: 'shell' }; // the paint-job options left at their defaults
  assert.deepStrictEqual(BB.assemble('A\nWAIT').appearance, { shape: 'tank', drive: 'tracks', turret: 'standard', ...plain });
  const code = 'main: INC R0\nWAIT\nJMP main';
  const baseline = BB.assemble(`A\n${code}`).program.map(({ op, args, cost }) => ({ op, args, cost }));
  for (const shape of BB.ISA.APPEARANCE.shape.choices) for (const drive of BB.ISA.APPEARANCE.drive.choices) for (const turret of BB.ISA.APPEARANCE.turret.choices) {
    const result = BB.assemble(`A\n.SHAPE ${shape.toUpperCase()} ; hull\n\n# comment\n.drive ${drive}\n.turret ${turret}\n${code}`);
    assert.deepStrictEqual(result.errors, []);
    assert.deepStrictEqual(result.appearance, { shape, drive, turret, ...plain });
    assert.deepStrictEqual(result.program.map(({ op, args, cost }) => ({ op, args, cost })), baseline);
    assert.strictEqual(result.program[0].line, 7);
  }
});

test('appearance errors preserve source lines and reject invalid, repeated and late headers', () => {
  for (const [source, line] of [
    ['A\n.shape triangle\nWAIT', 2], ['A\n.drive\nWAIT', 2], ['A\n.turret twin extra\nWAIT', 2],
    ['A\n.shape circle\n.shape wedge\nWAIT', 3], ['A\nWAIT\n.drive hover', 3],
    ['A\n.def K 1\n.shape circle\nWAIT', 3], ['A\nmain:\n.turret twin\nWAIT', 3],
    ['A\nmain: .shape circle\nWAIT', 2], ['A\n.constructor whatever\nWAIT', 2],
    ['A\n.__proto__ whatever\nWAIT', 2],
  ]) {
    const result = BB.assemble(source);
    assert.ok(result.errors.some((error) => error.line === line), source);
    assert.deepStrictEqual(result.program, []);
  }
  assert.match(errorsOf('A\n.shape circle')[0].message, /no instructions/);
});

test('cosmetic presets leave complete seeded match outcomes and physics unchanged', () => {
  for (const arena of ['classic', 'random', 'open']) for (const seed of [1, 7, 42]) {
    const run = (customize) => {
      const entries = BB.EXAMPLES.map((ex, id) => {
        let source = ex.source;
        if (customize) source = source
          .replace(/^\.shape .*$/m, `.shape ${['circle', 'hexagon', 'wedge', 'tank'][id % 4]}`)
          .replace(/^\.drive .*$/m, `.drive ${['hover', 'wheels', 'tracks', 'wheels'][id % 4]}`)
          .replace(/^\.turret .*$/m, '.turret twin');
        return compile(source, id);
      });
      const world = new BB.World({ entries, seed, arena });
      while (!world.over) world.step();
      return { tick: world.tick, winner: world.winner && world.winner.entryId,
        robots: world.robots.map((r) => ({ x: r.x, y: r.y, health: r.health, stats: r.stats, regs: [...r.vm.regs], cooldown: r.cooldown, fault: r.vm.fault })) };
    };
    assert.deepStrictEqual(run(true), run(false), `${arena}/${seed}`);
  }
});

test('appearance hot-swaps and survives duplication without changing the robot body', () => {
  const app = uiHarness();
  app.world.step();
  const robot = app.robotFor(0), body = [robot.x, robot.y, robot.health];
  app.selected.draft = 'A\n.shape wedge\n.drive hover\n.turret twin\n.decal flames\n.badge 7\n.trail sparks\nWAIT';
  app.applyDraft();
  assert.deepStrictEqual({ ...robot.appearance }, { shape: 'wedge', drive: 'hover', turret: 'twin', color: 'auto', decal: 'flames', badge: '7', trail: 'sparks', boom: 'fire', shot: 'shell' });
  assert.deepStrictEqual([robot.x, robot.y, robot.health], body);
  app.nextId = 2;
  app.resetMatch = () => {};
  app.duplicateEntry(0);
  assert.strictEqual(app.entries.length, 2);
  assert.deepStrictEqual(app.entries[1].compiled.appearance, { ...robot.appearance });
  assert.strictEqual(app.entries[1].source, app.entries[0].source);
});

test('all appearance combinations render normal, damaged, flashing and wreck states', () => {
  const renderingBB = { ...BB };
  for (const file of ['terrain.js', 'renderer.js']) {
    scriptVm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/ui', file), 'utf8'), { BB: renderingBB });
  }
  const renderer = Object.create(renderingBB.Renderer.prototype);
  renderer.robotFx = new Map();
  let calls = 0;
  const context = new Proxy({}, { get(target, key) {
    if (String(key).startsWith('create')) return () => ({ addColorStop() {} });
    return (...args) => { calls++; for (const value of args) if (typeof value === 'number') assert.ok(Number.isFinite(value)); };
  } });
  for (const shape of BB.ISA.APPEARANCE.shape.choices) for (const drive of BB.ISA.APPEARANCE.drive.choices) for (const turret of BB.ISA.APPEARANCE.turret.choices) {
    const source = `A\n.shape ${shape}\n.drive ${drive}\n.turret ${turret}\nWAIT`;
    const world = new BB.World({ entries: [compile(source, 0)] });
    const robot = world.robots[0];
    for (const health of [100, 20]) {
      robot.health = health;
      renderer.fx(robot.id).flash = 4;
      renderer.fx(robot.id).muzzle = 3;
      renderer.drawRobot(context, robot, true, 1000);
    }
    renderer.drawWreck(context, robot);
  }
  assert.ok(calls > 1000);
});

test('every decal, badge and trail draws with finite numbers, and trails only use spare particle budget', () => {
  const renderingBB = { ...BB };
  for (const file of ['terrain.js', 'renderer.js']) {
    scriptVm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/ui', file), 'utf8'), { BB: renderingBB, performance: { now: () => 0 } });
  }
  const renderer = Object.create(renderingBB.Renderer.prototype);
  renderer.robotFx = new Map();
  renderer.particles = [];
  const context = new Proxy({}, { get(target, key) {
    if (String(key).startsWith('create')) return () => ({ addColorStop() {} });
    if (key === 'measureText') return (s) => ({ width: String(s).length * 6 });
    return (...args) => { for (const value of args) if (typeof value === 'number') assert.ok(Number.isFinite(value), `${String(key)}(${args})`); };
  } });
  const { decal, badge, trail } = BB.ISA.APPEARANCE;
  for (const shape of BB.ISA.APPEARANCE.shape.choices) for (const d of decal.choices) for (const b of [...badge.choices, '7', '42']) {
    const world = new BB.World({ entries: [compile(`A\n.shape ${shape}\n.decal ${d}\n.badge ${b}\nWAIT`, 0)] });
    renderer.drawRobot(context, world.robots[0], false, 1000);
    renderer.drawLabel(context, world.robots[0], 1000);
  }
  // A badge number survives from the assembler into a new match (not only a mid-match Apply).
  assert.strictEqual(new BB.World({ entries: [compile('A\n.badge 07\nWAIT', 0)] }).robots[0].appearance.badge, '7');
  for (const bad of ['0', '100', '-3', '1e2']) assert.match(BB.assemble(`A\n.badge ${bad}\nWAIT`).errors[0].message, /number from 1 to 99/, bad);
  for (const t of trail.choices) {
    const world = new BB.World({ entries: [compile(`A\n.trail ${t}\nWAIT`, 0)], arena: 'open' });
    world.robots[0].speed = 5;
    renderer.particles = [];
    for (let i = 0; i < 60; i++) renderer.emitTrails(world, i * 16);
    assert.ok(t === 'none' ? renderer.particles.length === 0 : renderer.particles.length > 20, `${t}: ${renderer.particles.length} particles`);
    for (let i = 0; i < 50; i++) renderer.drawParticles(context);
    assert.strictEqual(renderer.particles.length, 0, `${t}: particles fade out`);
  }
  // Every .boom style: the destroyed robot's choice reaches the renderer, draws, and fades out.
  for (const boom of BB.ISA.APPEARANCE.boom.choices) {
    const w = new BB.World({ entries: [compile(`A\n.boom ${boom}\nWAIT`, 0), compile('B\nWAIT', 1)], arena: 'open' });
    w.damage(w.robots[0], 999, w.robots[1], 'shot');
    const events = w.drainEvents();
    assert.strictEqual(events.find((e) => e.type === 'explode').boom, boom);
    renderer.particles = [];
    renderer.scars = [];
    renderer.addScar = () => {};
    renderer.addEvents(events.filter((e) => e.type === 'explode'));
    assert.ok(renderer.particles.length >= 10, `${boom}: ${renderer.particles.length} particles`);
    for (let i = 0; i < 120; i++) renderer.drawParticles(context);
    assert.strictEqual(renderer.particles.length, 0, `${boom}: fades out`);
  }
  // Every .shot style: bullets carry it from the moment they're fired, draw, and fly exactly the same.
  const flights = BB.ISA.APPEARANCE.shot.choices.map((shot) => {
    const w = new BB.World({ entries: [compile(`A\n.shot ${shot}\nFIRE\nl: WAIT\nJMP l`, 0), compile('B\nl: WAIT\nJMP l', 1)], arena: 'open' });
    w.step();
    assert.strictEqual(w.projectiles[0].shot, shot);
    renderer.particles = [];
    for (let i = 0; i < 5; i++) { w.step(); for (const p of w.projectiles) renderer.drawProjectile(context, p, true); }
    renderer.drawParticles(context);
    return w.projectiles.map((p) => [p.x, p.y, p.vx, p.vy]);
  });
  for (const f of flights) assert.deepStrictEqual(f, flights[0], 'same path whatever it looks like');
  // Focus mode: the selected robot's bullets are 'mine', others 'other'; nothing focused if it isn't in the match.
  {
    const w = new BB.World({ entries: [compile('A\nFIRE\nl: WAIT\nJMP l', 10), compile('B\nFIRE\nl: WAIT\nJMP l', 11)], arena: 'open' });
    w.step();
    const [a, b] = w.projectiles;
    assert.deepStrictEqual([renderer.bulletFocus(w, a, 10), renderer.bulletFocus(w, b, 10)], ['mine', 'other']);
    assert.strictEqual(renderer.bulletFocus(w, a, null), null);
    renderer.focus = true;
    renderer.drawFocusedProjectile(context, a, true, 'mine');
    renderer.drawFocusedProjectile(context, b, true, 'other');
    renderer.focus = false;
  }
  // Calm effects: the same shot and hit make far fewer particles, and no casing.
  const busyness = (calm) => {
    renderer.calm = calm;
    renderer.particles = [];
    renderer.casings = [];
    renderer.addEvents([
      { type: 'fire', x: 100, y: 100, robot: 0, rx: 90, ry: 100, angle: 0 },
      { type: 'hit', x: 200, y: 100, color: '#ff5c5c' },
      { type: 'bump', x: 150, y: 150 },
    ]);
    const shell = { id: 1, owner: 0, color: '#ff5c5c', shot: 'shell', x: 50, y: 50, vx: 10, vy: 0 };
    for (let i = 0; i < 40; i++) renderer.drawProjectile(context, shell, true);
    return { particles: renderer.particles.length, casings: renderer.casings.length };
  };
  // Mud tracks are batched: hundreds of segments still draw in a few dozen strokes.
  {
    let strokes = 0;
    const counting = new Proxy({}, { get(target, key) {
      if (key === 'stroke') return () => { strokes++; };
      return () => {};
    } });
    renderer.tracks = Array.from({ length: 900 }, (_, i) => ({ x1: i % 800, y1: 300, x2: i % 800 + 3, y2: 300, heading: 0,
      drive: ['tracks', 'wheels', 'hover'][i % 3], tick: 1000 - (i % 400) }));
    renderer.drawTracks(counting, 1100);
    assert.ok(renderer.tracks.length > 500 && strokes <= 6 * (4 + 4 + 1), `${strokes} strokes for ${renderer.tracks.length} segments`);
    renderer.tracks = [];
  }
  const loud = busyness(false), calm = busyness(true);
  renderer.calm = false;
  assert.strictEqual(calm.casings, 0, 'no ejected casing');
  assert.ok(loud.casings === 1 && calm.particles * 3 < loud.particles, `calm ${calm.particles} vs ${loud.particles} particles`);
  // A busy screen (explosions) leaves no room for trails.
  const world = new BB.World({ entries: [compile('A\n.trail smoke\nWAIT', 0)], arena: 'open' });
  world.robots[0].speed = 5;
  renderer.particles = Array.from({ length: 300 }, () => ({ kind: 'smoke', x: 0, y: 0, vx: 0, vy: 0, size: 1, life: 99, max: 99 }));
  renderer.emitTrails(world, 0);
  assert.strictEqual(renderer.particles.length, 300);
});

test('renderer effects use event-time state, land clear of the hull and freeze while paused', () => {
  const renderingBB = { ...BB };
  for (const file of ['terrain.js', 'renderer.js']) {
    scriptVm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/ui', file), 'utf8'), { BB: renderingBB, performance });
  }
  const renderer = Object.create(renderingBB.Renderer.prototype);
  Object.assign(renderer, { robotFx: new Map(), particles: [], scars: [], ignited: [], tracks: [], casings: [], decals: null });
  const context = new Proxy({}, { get(target, key) {
    if (String(key).startsWith('create')) return () => ({ addColorStop() {} });
    return (...args) => { for (const value of args) if (typeof value === 'number') assert.ok(Number.isFinite(value)); };
  } });
  const world = new BB.World({ entries: [compile('A\nWAIT', 0), compile('B\nWAIT', 1)], arena: 'classic' });
  renderer.world = world;
  const [a, b] = world.robots;
  // Events carry the state at the time of the shot; by the time they are drained both robots have moved on.
  Object.assign(a, { x: 600, y: 500, turret: 135 });
  Object.assign(b, { x: 700, y: 100, heading: 0 });
  const tree = BB.World.DEFAULT_OBSTACLES[0];
  renderer.addEvents([
    { type: 'fire', x: 120, y: 100, robot: 0, rx: 100, ry: 100, angle: 0 },
    { type: 'hit', x: 300, y: 286, robot: 1, rx: 300, ry: 300, heading: 90, color: '#ffffff' },
    { type: 'spark', x: tree.x + tree.w / 2, y: tree.y + tree.h / 2 },
    { type: 'spark', x: 0, y: 300 },
    { type: 'explode', x: 400, y: 500, color: '#ffffff' },
    { type: 'bump', x: 10, y: 10 },
  ]);
  const casing = renderer.casings[0];
  assert.ok(Math.abs(Math.hypot(casing.x - 100, casing.y - 100) - 9) < 1e-9, 'casing ejects from the robot where it fired');
  const dent = renderer.fx(1).dents[0];
  assert.ok(Math.abs(dent.x + 9) < 1e-9 && Math.abs(dent.y) < 1e-9, 'a hit from behind dents the rear of the hull');
  const kinds = new Set(renderer.particles.map((p) => p.kind));
  for (const kind of ['smoke', 'chip', 'dust', 'spark', 'flash', 'ring']) assert.ok(kinds.has(kind), `missing ${kind} particles`);
  assert.deepStrictEqual(renderer.scars.map((s) => s.kind).sort(), ['char', 'crater']);

  // Paused (no ticks): shells leave no smoke and casings stay put.
  const shell = { x: 200, y: 200, vx: 10, vy: 0, color: '#ff0000' };
  const before = renderer.particles.length;
  for (let i = 0; i < 50; i++) renderer.drawProjectile(context, shell, false);
  assert.strictEqual(renderer.particles.length, before);
  const at = { x: casing.x, y: casing.y, life: casing.life };
  renderer.drawCasings(context, 0);
  assert.deepStrictEqual({ x: casing.x, y: casing.y, life: casing.life }, at);
  renderer.drawCasings(context, 60);
  assert.ok(Math.hypot(casing.x - 100, casing.y - 100) > BB.CONFIG.ROBOT_RADIUS + 2, 'casing comes to rest clear of the hull');
  assert.strictEqual(casing.life, at.life - 60);
  for (let i = 0; i < 50; i++) renderer.drawProjectile(context, shell, true);
  assert.ok(renderer.particles.some((p) => p.kind === 'trail'));
  renderer.drawParticles(context);
  renderer.drawRobot(context, b, false, 1000);
});

test('victory card draws free-for-all wins, team wins with fallen teammates, and draws', () => {
  const renderingBB = { ...BB };
  for (const file of ['terrain.js', 'renderer.js']) {
    scriptVm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/ui', file), 'utf8'), { BB: renderingBB, performance });
  }
  const texts = [];
  const context = new Proxy({}, { get(target, key) {
    if (String(key).startsWith('create')) return () => ({ addColorStop() {} });
    if (key === 'measureText') return (text) => ({ width: text.length * 10 });
    return (...args) => {
      if (key === 'fillText') texts.push(args[0]);
      for (const value of args) if (typeof value === 'number') assert.ok(Number.isFinite(value));
    };
  } });
  const card = (world) => {
    const renderer = Object.create(renderingBB.Renderer.prototype);
    Object.assign(renderer, { robotFx: new Map() });
    texts.length = 0;
    renderer.drawBanner(context, world, 1000);
    renderer.drawBanner(context, world, 2000); // fully faded in
    return texts.join(' | ');
  };

  const ffa = new BB.World({ entries: [compile('Champion With A Very Long Name\nWAIT', 0), compile('Loser\nWAIT', 1)], arena: 'open' });
  ffa.robots[0].stats = { shots: 8, hits: 6, damageDealt: 60 };
  ffa.damage(ffa.robots[1], 100, ffa.robots[0], 'shot');
  ffa.step();
  assert.strictEqual(ffa.winner, ffa.robots[0]);
  const ffaText = card(ffa);
  assert.match(ffaText, /V I C T O R Y/);
  assert.match(ffaText, /Last robot standing/);
  assert.match(ffaText, /75%/);
  assert.match(ffaText, /Champion.*…/, 'long names are shortened to fit');

  const teams = new BB.World({ entries: [0, 1, 2].map((id) => ({ ...compile(`Bot${id}\nWAIT`, id), team: id < 2 ? 0 : 1 })), arena: 'open' });
  teams.damage(teams.robots[1], 100, teams.robots[2], 'shot'); // a team A member falls...
  teams.damage(teams.robots[2], 100, teams.robots[0], 'shot'); // ...but team A wins
  teams.step();
  assert.strictEqual(teams.winnerTeam, 0);
  const teamText = card(teams);
  assert.match(teamText, /Team A/);
  assert.match(teamText, /destroyed/);

  const draw = new BB.World({ entries: [compile('A\nWAIT', 0), compile('B\nWAIT', 1)], arena: 'open' });
  for (const r of draw.robots) draw.damage(r, 100, null, 'shot');
  draw.step();
  assert.match(card(draw), /DRAW.*Everyone was destroyed/);
});

test('Stacker balances nested calls and register saves across CPU budget boundaries', () => {
  const example = BB.EXAMPLES.find((ex) => ex.file === 'stacker.asm');
  const compiled = BB.assemble(example.source);
  assert.deepStrictEqual(compiled.errors, []);
  const preserved = [123, -456, 789, 321];
  let overallPeak = 0;
  let overallPartialTicks = 0;
  for (const front of [20, 500]) for (const target of [-1, 200]) {
    let shots = 0, turns = 0, peak = 0, checks = 0, partialTicks = 0;
    const cpu = new BB.VM(compiled.program, {
      sense(id) {
        return { FRONT: front, HEALTH: 100, SCAN_DIST: target, SCAN_ANGLE: 0, TURRET: 0, COOLDOWN: 0 }[BB.ISA.SENSORS[id].name] || 0;
      },
      random: () => 0, speed() {}, head() { turns++; }, aim() {}, scan() {},
      fire() { shots++; },
    });
    cpu.regs.set(preserved);
    const push = cpu.push.bind(cpu);
    cpu.push = (...args) => { push(...args); peak = Math.max(peak, cpu.stack.length); };
    for (let tick = 0; tick < 200; tick++) {
      cpu.run(BB.CONFIG.CYCLES_PER_TICK);
      assert.strictEqual(cpu.fault, null);
      if (cpu.stack.length) partialTicks++;
      else if (cpu.regs[6] > 0) {
        assert.deepStrictEqual([...cpu.regs.slice(0, 4)], preserved);
        assert.strictEqual(cpu.regs[7], 3);
        checks++;
      }
    }
    assert.ok(checks > 20, 'should complete many balanced main-loop passes');
    overallPartialTicks += partialTicks;
    assert.ok(peak <= 11);
    assert.strictEqual(turns > 0, front === 20);
    assert.strictEqual(shots > 0, target >= 0);
    overallPeak = Math.max(overallPeak, peak);
  }
  assert.strictEqual(overallPeak, 11);
  assert.ok(overallPartialTicks > 0, 'routines should span CPU ticks');
});

test('Stacker runs full practice sessions on every arena without stack growth or faults', () => {
  const source = BB.EXAMPLES.find((ex) => ex.file === 'stacker.asm').source;
  for (const arena of ['classic', 'random', 'open']) for (const seed of [1, 7, 42]) {
    const world = new BB.World({ entries: [compile(source, 0)], arena, seed });
    let peak = 0;
    const robot = world.robots[0], push = robot.vm.push.bind(robot.vm);
    robot.vm.push = (...args) => { push(...args); peak = Math.max(peak, robot.vm.stack.length); };
    for (let tick = 0; tick < BB.CONFIG.MAX_TICKS; tick++) world.step();
    assert.strictEqual(robot.vm.fault, null, `${arena}/${seed}`);
    assert.ok(peak <= 11);
    assert.ok(robot.vm.regs[6] > 20, `${arena}/${seed}: patrol/turret passes did not progress`);
    assert.ok(robot.stats.shots === 0, 'solo robot should not fire at nonexistent targets');
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
