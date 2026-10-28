/*
 * vm.js — The isolated robot CPU.
 *
 * A VM owns its registers, memory and stack and can only affect the outside
 * world through the `io` object passed to it (sensors and robot actions).
 * `run(budget)` executes until the cycle budget for this tick is used, the
 * program WAITs, HALTs or faults. A fault halts only this VM and is recorded
 * in `vm.fault`; it never throws to the caller.
 */
(function (BB) {
  'use strict';

  const { NUM_REGS, MEMORY_SIZE, STACK_SIZE } = BB.CONFIG;

  class VMFault extends Error {}

  const toInt = (v) => v | 0;

  /** When each conditional jump is taken, given the last CMP result (-1, 0, 1). */
  const JUMP_IF = {
    JE: (c) => c === 0, JNE: (c) => c !== 0, JL: (c) => c < 0,
    JLE: (c) => c <= 0, JG: (c) => c > 0, JGE: (c) => c >= 0,
  };

  class VM {
    /**
     * @param {Array} program  output of BB.assemble
     * @param {object} io      { sense(id), random(n), speed(v), turn(v), head(v), aim(v), fire(), scan(w), radar() }
     */
    constructor(program, io) {
      this.program = program;
      this.io = io;
      // Debugger: a Set of source lines to stop before, or null. When run()
      // reaches one it yields for the rest of the tick and sets breakHit.
      this.breakLines = null;
      this.breakHit = 0;
      this.resumeLine = 0;   // the line we stopped at; runs without stopping again
      // Debugger: set to an array to record each run()'s instructions as
      // { line, asm, note }; `lastStop` says why the run ended.
      this.trace = null;
      this.lastStop = null;  // 'wait' | 'halt' | 'fault' | 'break' | 'budget'
      this.reset();
    }

    reset() {
      this.regs = new Int32Array(NUM_REGS);
      this.mem = new Int32Array(MEMORY_SIZE);
      this.stack = [];
      this.isReturn = [];  // parallel to stack: true where CALL saved a return address
      this.pushedAt = [];  // parallel to stack: source line of the PUSH or CALL that saved each entry
      this.returnTakenAt = 0; // line of a POP that took CALL's return address, for RET's error message
      this.pc = 0;
      this.cmp = 0;
      this.halted = false;
      this.fault = null;
      this.faultLine = 0;    // source line of the faulting instruction
      this.totalCycles = 0;
      this.counts = new Uint32Array(this.program.length); // times each instruction ran
    }

    /** Line number of the next instruction to execute (for the debugger). */
    get currentLine() { return this.lineAt(this.pc); }

    /** Source line of the instruction at `pc`, wrapping like run() does. */
    lineAt(pc) {
      if (!this.program.length) return 0;
      // pc can run past the end; run() wraps it to 0 before the next instruction.
      return this.program[pc >= this.program.length || pc < 0 ? 0 : pc].line;
    }

    run(budget) {
      let used = 0;
      const prog = this.program;
      if (!prog.length) { this.halted = true; return 0; }
      let resume = this.resumeLine;
      this.resumeLine = this.breakHit = 0;
      const trace = this.trace;
      if (trace) trace.length = 0;
      let stop = 'budget';
      while (!this.halted && used < budget) {
        if (this.pc >= prog.length || this.pc < 0) this.pc = 0;
        const ins = prog[this.pc];
        if (this.breakLines && this.breakLines.has(ins.line) && ins.line !== resume) {
          this.breakHit = this.resumeLine = ins.line;
          stop = 'break';
          break;
        }
        resume = 0;
        // An expensive instruction that doesn't fit waits for the next tick.
        if (used + ins.cost > budget) break;
        used += ins.cost;
        this.counts[this.pc]++;
        const at = this.pc++;
        let yielded = false, faultMsg = null;
        try {
          yielded = this.exec(ins);
        } catch (e) {
          faultMsg = e instanceof VMFault ? e.message : `internal error: ${e.message}`;
          this.fault = `Line ${ins.line}: ${faultMsg}`;
          this.faultLine = ins.line;
          this.halted = true;
          stop = 'fault';
        }
        if (trace) trace.push({ line: ins.line, asm: ins.asm, op: ins.op, ...(faultMsg ? { note: faultMsg, fault: faultMsg } : this.describe(ins, at)) });
        if (yielded) { stop = ins.op === 'HALT' ? 'halt' : 'wait'; break; }
      }
      this.lastStop = stop;
      this.totalCycles += used;
      return used;
    }

    /**
     * What `ins` (at index `at`) just did, for the trace: a short `note` plus
     * the facts it came from, so the UI can word it for beginners:
     *   CMP: x, y · jumps: taken, to · CALL/RET: to · dst ops: dst, value (GET: sensor)
     *   src ops: value · SCAN/RADAR: found (distance, -1 = none) · FIRE: cooldown
     */
    describe(ins, at) {
      const a = ins.args;
      const sense = (name) => (this.io.sense ? this.io.sense(BB.ISA.SENSOR_MAP[name].id) : -1);
      switch (ins.op) {
        case 'CMP': {
          const x = this.read(a[0]), y = this.read(a[1]);
          return { note: `${x} ${x < y ? '<' : x > y ? '>' : '='} ${y}`, x, y };
        }
        case 'JMP': { const to = this.lineAt(this.pc); return { note: `jump to line ${to}`, taken: true, to }; }
        case 'CALL': { const to = this.lineAt(this.pc); return { note: `call line ${to}`, to }; }
        case 'RET': { const to = this.lineAt(this.pc); return { note: `return to line ${to}`, to }; }
        case 'WAIT': return { note: 'end of turn' };
        case 'HALT': return { note: 'CPU stopped' };
        case 'SCAN': {
          const found = sense('SCAN_DIST');
          return { note: found < 0 ? 'nobody found' : `found at ${found}`, value: this.read(a[0]), found };
        }
        case 'RADAR': {
          const found = sense('THREAT_DIST');
          return { note: found < 0 ? 'no bullets coming' : `bullet at ${found}`, found };
        }
        case 'FIRE': {
          const cooldown = this.io.sense ? sense('COOLDOWN') : 0;
          return { note: cooldown > 0 ? `reloading, ${cooldown} ticks` : 'fires', cooldown };
        }
      }
      if (JUMP_IF[ins.op]) {
        const taken = JUMP_IF[ins.op](this.cmp), to = this.lineAt(taken ? a[0].v : at + 1);
        return { note: taken ? `jump to line ${to}` : 'no jump', taken, to };
      }
      const kind = BB.ISA.INSTRUCTION_MAP[ins.op].args[0];
      if (kind === 'dst') {
        const dst = a[0].k === 'reg' ? `R${a[0].r}` : `[${this.addr(a[0])}]`, value = this.read(a[0]);
        const facts = { note: `${dst} = ${value}`, dst, value };
        if (ins.op === 'GET') facts.sensor = BB.ISA.SENSORS[a[1].v].name;
        return facts;
      }
      if (kind === 'src') {
        const value = this.read(a[0]);
        return { note: a[0].k === 'imm' ? '' : `value ${value}`, value };
      }
      return { note: '' };
    }

    // ---- operand helpers ----
    addr(a) {
      const addr = (a.r >= 0 ? this.regs[a.r] : 0) + a.off;
      if (addr < 0 || addr >= MEMORY_SIZE) {
        throw new VMFault(`memory address ${addr} is out of range (0..${MEMORY_SIZE - 1}).`);
      }
      return addr;
    }

    read(a) {
      if (a.k === 'reg') return this.regs[a.r];
      if (a.k === 'imm') return a.v;
      return this.mem[this.addr(a)];
    }

    write(a, v) {
      if (a.k === 'reg') this.regs[a.r] = toInt(v);
      else this.mem[this.addr(a)] = toInt(v);
    }

    push(v, isReturn = false, line = 0) {
      if (this.stack.length >= STACK_SIZE) throw new VMFault(`stack overflow (max ${STACK_SIZE} entries). Missing RET or POP?`);
      this.stack.push(toInt(v));
      this.isReturn.push(isReturn);
      this.pushedAt.push(line);
    }

    pop(what) {
      // A POP that took CALL's return address is the real mistake when RET then goes wrong.
      const taken = what === 'RET' && this.returnTakenAt
        ? `The POP on line ${this.returnTakenAt} took the place to go back to, which CALL saved. Every POP needs a PUSH before it.` : '';
      if (!this.stack.length) throw new VMFault(taken ? `RET has nowhere to go back to. ${taken}` : `${what} with an empty stack.`);
      // Without this, RET would quietly jump to whatever number PUSH saved.
      if (what === 'RET' && !this.isReturn[this.isReturn.length - 1]) {
        throw new VMFault(taken ? `RET found a value saved by PUSH, not the place to go back to. ${taken}`
          : 'RET found a value saved by PUSH, not the place to go back to. Every PUSH in a function needs a POP before RET.');
      }
      this.isReturn.pop();
      this.pushedAt.pop();
      return this.stack.pop();
    }

    /** Execute one instruction. Returns true if the robot yields for this tick. */
    exec(ins) {
      const a = ins.args;
      const io = this.io;
      switch (ins.op) {
        case 'MOV': this.write(a[0], this.read(a[1])); break;
        case 'PUSH': this.push(this.read(a[0]), false, ins.line); break;
        case 'POP': {
          const tookReturn = this.isReturn[this.isReturn.length - 1];
          this.write(a[0], this.pop('POP'));
          if (tookReturn) this.returnTakenAt = ins.line; // the RET that follows will crash: say why
          break;
        }

        case 'ADD': this.write(a[0], this.read(a[0]) + this.read(a[1])); break;
        case 'SUB': this.write(a[0], this.read(a[0]) - this.read(a[1])); break;
        case 'MUL': this.write(a[0], Math.imul(this.read(a[0]), this.read(a[1]))); break;
        case 'DIV': {
          const d = this.read(a[1]);
          if (d === 0) throw new VMFault('division by zero.');
          this.write(a[0], Math.trunc(this.read(a[0]) / d));
          break;
        }
        case 'MOD': {
          const d = this.read(a[1]);
          if (d === 0) throw new VMFault('modulo by zero.');
          const x = this.read(a[0]);
          this.write(a[0], ((x % d) + d) % d);
          break;
        }
        case 'INC': this.write(a[0], this.read(a[0]) + 1); break;
        case 'DEC': this.write(a[0], this.read(a[0]) - 1); break;
        case 'NEG': this.write(a[0], -this.read(a[0])); break;
        case 'ABS': this.write(a[0], Math.abs(this.read(a[0]))); break;
        case 'MIN': this.write(a[0], Math.min(this.read(a[0]), this.read(a[1]))); break;
        case 'MAX': this.write(a[0], Math.max(this.read(a[0]), this.read(a[1]))); break;
        case 'AND': this.write(a[0], this.read(a[0]) & this.read(a[1])); break;
        case 'OR': this.write(a[0], this.read(a[0]) | this.read(a[1])); break;
        case 'XOR': this.write(a[0], this.read(a[0]) ^ this.read(a[1])); break;
        case 'RAND': {
          const n = this.read(a[1]);
          if (n <= 0) throw new VMFault(`RAND range must be positive, got ${n}.`);
          this.write(a[0], io.random(n));
          break;
        }

        case 'ATAN2': {
          const dy = this.read(a[1]), dx = this.read(a[2]);
          this.write(a[0], BB.geo.normAngle(Math.round(Math.atan2(dy, dx) * 180 / Math.PI)));
          break;
        }
        case 'SIN': this.write(a[0], Math.round(Math.sin(this.read(a[1]) * Math.PI / 180) * 1000)); break;
        case 'COS': this.write(a[0], Math.round(Math.cos(this.read(a[1]) * Math.PI / 180) * 1000)); break;
        case 'SQRT': {
          const v = this.read(a[1]);
          if (v < 0) throw new VMFault(`SQRT of negative number ${v}.`);
          this.write(a[0], Math.floor(Math.sqrt(v)));
          break;
        }
        case 'NORM': {
          const v = this.read(a[0]);
          this.write(a[0], ((((v + 180) % 360) + 360) % 360) - 180);
          break;
        }

        case 'CMP': {
          const x = this.read(a[0]), y = this.read(a[1]);
          this.cmp = x < y ? -1 : x > y ? 1 : 0;
          break;
        }
        case 'JMP': this.pc = a[0].v; break;
        case 'JE': case 'JNE': case 'JL': case 'JLE': case 'JG': case 'JGE':
          if (JUMP_IF[ins.op](this.cmp)) this.pc = a[0].v;
          break;
        case 'CALL': this.push(this.pc, true, ins.line); this.pc = a[0].v; break;
        case 'RET': this.pc = this.pop('RET'); this.returnTakenAt = 0; break;
        case 'NOP': break;
        case 'WAIT': return true;
        case 'HALT': this.halted = true; return true;

        case 'GET': this.write(a[0], io.sense(a[1].v)); break;
        case 'SPEED': io.speed(this.read(a[0])); break;
        case 'TURN': io.turn(this.read(a[0])); break;
        case 'HEAD': io.head(this.read(a[0])); break;
        case 'AIM': io.aim(this.read(a[0])); break;
        case 'FIRE': io.fire(); break;
        case 'SCAN': io.scan(this.read(a[0])); break;
        case 'RADAR': io.radar(); break;

        default: throw new VMFault(`unimplemented instruction ${ins.op}.`);
      }
      return false;
    }
  }

  BB.VM = VM;
})(globalThis.BB = globalThis.BB || {});
