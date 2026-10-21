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

  class VM {
    /**
     * @param {Array} program  output of BB.assemble
     * @param {object} io      { sense(id), random(n), speed(v), turn(v), head(v), aim(v), fire(), scan(w), radar() }
     */
    constructor(program, io) {
      this.program = program;
      this.io = io;
      this.reset();
    }

    reset() {
      this.regs = new Int32Array(NUM_REGS);
      this.mem = new Int32Array(MEMORY_SIZE);
      this.stack = [];
      this.pc = 0;
      this.cmp = 0;
      this.halted = false;
      this.fault = null;
      this.faultLine = 0;    // source line of the faulting instruction
      this.totalCycles = 0;
    }

    /** Line number of the next instruction to execute (for the debugger). */
    get currentLine() {
      if (!this.program.length) return 0;
      // Mirrors run(): RET can leave any popped value in pc until the next cycle.
      const pc = this.pc >= this.program.length || this.pc < 0 ? 0 : this.pc;
      return this.program[pc].line;
    }

    run(budget) {
      let used = 0;
      const prog = this.program;
      if (!prog.length) { this.halted = true; return 0; }
      while (!this.halted && used < budget) {
        if (this.pc >= prog.length || this.pc < 0) this.pc = 0;
        const ins = prog[this.pc];
        // An expensive instruction that doesn't fit waits for the next tick.
        if (used + ins.cost > budget) break;
        used += ins.cost;
        this.pc++;
        let yielded = false;
        try {
          yielded = this.exec(ins);
        } catch (e) {
          const msg = e instanceof VMFault ? e.message : `internal error: ${e.message}`;
          this.fault = `Line ${ins.line}: ${msg}`;
          this.faultLine = ins.line;
          this.halted = true;
        }
        if (yielded) break;
      }
      this.totalCycles += used;
      return used;
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

    push(v) {
      if (this.stack.length >= STACK_SIZE) throw new VMFault(`stack overflow (max ${STACK_SIZE} entries). Missing RET or POP?`);
      this.stack.push(toInt(v));
    }

    pop(what) {
      if (!this.stack.length) throw new VMFault(`${what} with an empty stack.`);
      return this.stack.pop();
    }

    /** Execute one instruction. Returns true if the robot yields for this tick. */
    exec(ins) {
      const a = ins.args;
      const io = this.io;
      switch (ins.op) {
        case 'MOV': this.write(a[0], this.read(a[1])); break;
        case 'PUSH': this.push(this.read(a[0])); break;
        case 'POP': this.write(a[0], this.pop('POP')); break;

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
        case 'JE': if (this.cmp === 0) this.pc = a[0].v; break;
        case 'JNE': if (this.cmp !== 0) this.pc = a[0].v; break;
        case 'JL': if (this.cmp < 0) this.pc = a[0].v; break;
        case 'JLE': if (this.cmp <= 0) this.pc = a[0].v; break;
        case 'JG': if (this.cmp > 0) this.pc = a[0].v; break;
        case 'JGE': if (this.cmp >= 0) this.pc = a[0].v; break;
        case 'CALL': this.push(this.pc); this.pc = a[0].v; break;
        case 'RET': this.pc = this.pop('RET'); break;
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
