/*
 * assembler.js — Turns robot source text into an executable program.
 *
 *   assemble(source) -> { name, program, errors, warnings }
 *
 * `program` is an array of { op, args, cost, line, text, asm } (`asm` is the
 * instruction alone, without label or comment) where every operand
 * has been resolved to one of:
 *   { k: 'reg', r }            register index
 *   { k: 'imm', v }            number (constants, labels and sensors resolve to this)
 *   { k: 'mem', r, off }       memory at regs[r] + off (r = -1 means no register)
 *
 * Errors carry 1-based line numbers that match the original file.
 */
(function (BB) {
  'use strict';

  const { INSTRUCTION_MAP, SENSOR_MAP } = BB.ISA;
  const { NUM_REGS } = BB.CONFIG;

  const IDENT_RE = /^[A-Z_][A-Z0-9_]*$/;
  const REG_RE = /^R(\d+)$/;
  const NUM_RE = /^[+-]?(0X[0-9A-F]+|\d+)$/;
  const MAX_NAME = 24;

  const ARG_HINT = {
    dst: 'a register or memory location',
    src: 'a register, memory location, number or constant',
    target: 'a label',
    sensor: 'a sensor name',
  };

  function parseNumber(tok) {
    if (!NUM_RE.test(tok)) return null;
    const neg = tok[0] === '-';
    const body = tok.replace(/^[+-]/, '');
    const v = body.startsWith('0X') ? parseInt(body.slice(2), 16) : parseInt(body, 10);
    return neg ? -v : v;
  }

  function levenshtein(a, b) {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return dp[a.length][b.length];
  }

  function suggest(word, candidates) {
    let best = null, bestD = 3;
    for (const c of candidates) {
      const d = levenshtein(word, c);
      if (d < bestD) { best = c; bestD = d; }
    }
    return best ? ` Did you mean ${best}?` : '';
  }

  /** Split "a, b , [R1 + 2]" into trimmed operand strings. */
  function splitArgs(text) {
    if (!text.trim()) return [];
    return text.split(',').map((s) => s.trim());
  }

  function stripComment(line) {
    const i = line.search(/[;#]/);
    return i >= 0 ? line.slice(0, i) : line;
  }

  function assemble(source) {
    const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
    const errors = [];
    const warnings = [];
    const appearance = Object.fromEntries(Object.entries(BB.ISA.APPEARANCE).map(([key, spec]) => [key, spec.default]));
    const appearanceSeen = new Set();
    let inHeader = true;
    const err = (line, message) => errors.push({ line, message });

    // ---- Line 1: robot name ----
    let name = (lines[0] || '').replace(/^\s*[;#]+/, '').trim();
    if (!name) {
      err(1, 'Line 1 must contain the robot\'s name (for example: "Sentinel").');
      name = 'Unnamed';
    } else if ([...name].length > MAX_NAME) {
      // Count code points, so an emoji is never cut in half.
      warnings.push({ line: 1, message: `Name truncated to ${MAX_NAME} characters.` });
      name = [...name].slice(0, MAX_NAME).join('');
    }

    // ---- Pass 1: labels, constants, raw statements ----
    const labels = Object.create(null);
    const constants = Object.create(null);
    const statements = [];
    const rejectedLabels = new Set(); // already reported; don't also flag each jump to them

    const checkNewName = (lineNo, id, what) => {
      if (!IDENT_RE.test(id)) { err(lineNo, `"${id}" is not a valid ${what} name (use letters, digits and _, not starting with a digit).`); return false; }
      if (REG_RE.test(id)) { err(lineNo, `"${id}" is a register and cannot be used as a ${what} name.`); return false; }
      if (INSTRUCTION_MAP[id]) {
        err(lineNo, `"${id}" is an instruction and cannot be used as a ${what} name. Try something like "${id.toLowerCase()}_${what === 'label' ? 'here' : 'value'}".`);
        return false;
      }
      if (labels[id] !== undefined || constants[id] !== undefined) {
        err(lineNo, `"${id}" is already defined.`); return false;
      }
      return true;
    };

    for (let i = 1; i < lines.length; i++) {
      const lineNo = i + 1;
      const raw = lines[i];
      let text = stripComment(raw).trim();
      if (!text) continue;

      const header = /^(\.\S+)(?:\s+(.*))?$/.exec(text);
      const key = header && header[1].slice(1).toLowerCase();
      const appearanceSpec = key && Object.prototype.hasOwnProperty.call(BB.ISA.APPEARANCE, key) && BB.ISA.APPEARANCE[key];
      if (appearanceSpec) {
        const value = (header[2] || '').trim().toLowerCase();
        if (!inHeader) err(lineNo, `.${key} must appear in the appearance header below the name, before labels, constants or instructions.`);
        else if (appearanceSeen.has(key)) err(lineNo, `.${key} is already specified.`);
        else if (!appearanceSpec.choices.includes(value)) err(lineNo, `.${key} expects one preset: ${appearanceSpec.choices.join(', ')}.`);
        else appearance[key] = value;
        appearanceSeen.add(key);
        continue;
      }
      inHeader = false;

      // Leading labels: "loop:", "a: b: MOV R0, 1"
      let m;
      while ((m = /^([^\s:,\[\]]+)\s*:/.exec(text))) {
        const id = m[1].toUpperCase();
        if (checkNewName(lineNo, id, 'label')) labels[id] = statements.length;
        else rejectedLabels.add(id);
        text = text.slice(m[0].length).trim();
      }
      if (!text) continue;

      // Directives
      if (text[0] === '.') {
        const parts = text.split(/\s+/);
        const dir = parts[0].toUpperCase();
        if (dir === '.DEF' || dir === '.CONST' || dir === '.EQU') {
          if (parts.length !== 3) { err(lineNo, `${dir} expects a name and a value, e.g. ".def RANGE 200".`); continue; }
          const id = parts[1].toUpperCase();
          const v = parseNumber(parts[2].toUpperCase());
          if (v === null) { err(lineNo, `${dir} value "${parts[2]}" is not a number.`); continue; }
          if (v > 2147483647 || v < -2147483648) {
            err(lineNo, `Number ${parts[2]} does not fit in 32 bits.`);
            continue;
          }
          if (checkNewName(lineNo, id, 'constant')) constants[id] = v;
        } else {
          err(lineNo, `Unknown directive "${parts[0]}". Supported: .def NAME value; header presets .shape, .drive, .turret.`);
        }
        continue;
      }

      const sp = text.search(/\s/);
      const opTok = (sp < 0 ? text : text.slice(0, sp)).toUpperCase();
      const argText = sp < 0 ? '' : text.slice(sp + 1);
      statements.push({ op: opTok, args: splitArgs(argText), line: lineNo, text: raw.trim() });
    }

    // ---- Pass 2: resolve operands ----
    const program = [];

    const resolveValue = (tok, lineNo) => {
      const n = parseNumber(tok);
      if (n !== null) {
        if (n > 2147483647 || n < -2147483648) { err(lineNo, `Number ${tok} does not fit in 32 bits.`); return null; }
        return n;
      }
      if (constants[tok] !== undefined) return constants[tok];
      return undefined; // caller decides the message
    };

    const resolveReg = (tok) => {
      const m = REG_RE.exec(tok);
      if (!m) return -1;
      const r = parseInt(m[1], 10);
      return r < NUM_REGS ? r : -2;
    };

    function parseMemory(inner, lineNo) {
      // [R1], [12], [R1+4], [R1-CONST], [CONST]
      const t = inner.replace(/\s+/g, '');
      const m = /^([A-Z0-9_]+)(?:([+-])([A-Z0-9_]+))?$/.exec(t);
      if (!m) { err(lineNo, `Bad memory operand "[${inner}]". Use [n], [Rx] or [Rx+n].`); return null; }
      let r = -1, off = 0;
      const first = resolveReg(m[1]);
      if (first === -2) { err(lineNo, `Unknown register ${m[1]}. Registers are R0..R${NUM_REGS - 1}.`); return null; }
      if (first >= 0) {
        r = first;
      } else {
        const v = resolveValue(m[1], lineNo);
        if (v === undefined) { err(lineNo, `Unknown name "${m[1]}" in memory operand.`); return null; }
        if (v === null) return null;
        off = v;
      }
      if (m[2]) {
        if (r < 0) { err(lineNo, `Memory operand must look like [Rx+n]; the register comes first.`); return null; }
        const v = resolveValue(m[3], lineNo);
        if (v === undefined) { err(lineNo, `Offset "${m[3]}" must be a number or constant.`); return null; }
        if (v === null) return null;
        off = m[2] === '-' ? -v : v;
      }
      return { k: 'mem', r, off };
    }

    function parseOperand(raw, kind, lineNo, op, idx) {
      const tok = raw.toUpperCase();
      const where = `${op} operand ${idx + 1}`;
      if (!tok) { err(lineNo, `${where} is empty.`); return null; }

      if (kind === 'target') {
        if (labels[tok] !== undefined) return { k: 'imm', v: labels[tok] };
        const n = parseNumber(tok);
        if (n !== null) return { k: 'imm', v: n };
        if (rejectedLabels.has(tok)) return null; // error already reported at the label
        if (constants[tok] !== undefined) {
          err(lineNo, `"${raw}" is a constant, not a label (names are case-insensitive).`);
          return null;
        }
        err(lineNo, `Unknown label "${raw}".${suggest(tok, Object.keys(labels))}`);
        return null;
      }

      if (kind === 'sensor') {
        if (SENSOR_MAP[tok]) return { k: 'imm', v: SENSOR_MAP[tok].id };
        err(lineNo, `Unknown sensor "${raw}".${suggest(tok, Object.keys(SENSOR_MAP))}`);
        return null;
      }

      // dst / src
      const mem = /^\[(.*)\]$/.exec(tok);
      if (mem) return parseMemory(mem[1], lineNo);

      const r = resolveReg(tok);
      if (r === -2) { err(lineNo, `Unknown register ${raw}. Registers are R0..R${NUM_REGS - 1}.`); return null; }
      if (r >= 0) return { k: 'reg', r };

      if (kind === 'dst') {
        err(lineNo, `${where} must be ${ARG_HINT.dst}, got "${raw}".`);
        return null;
      }

      const v = resolveValue(tok, lineNo);
      if (v === null) return null;
      if (v !== undefined) return { k: 'imm', v };

      let hint = '';
      if (SENSOR_MAP[tok]) hint = ` To read a sensor, use GET first, e.g. "GET R0, ${tok}".`;
      else if (labels[tok] !== undefined) hint = ' Labels can only be used as jump targets.';
      else hint = suggest(tok, Object.keys(constants));
      err(lineNo, `Unknown name "${raw}" — expected ${ARG_HINT[kind]}.${hint}`);
      return null;
    }

    for (const st of statements) {
      const spec = INSTRUCTION_MAP[st.op];
      if (!spec) {
        err(st.line, `Unknown instruction "${st.op}".${suggest(st.op, Object.keys(INSTRUCTION_MAP))}`);
        continue;
      }
      if (st.args.length !== spec.args.length) {
        const form = spec.args.length ? `${spec.op} ${spec.args.join(', ')}` : spec.op;
        err(st.line, `${spec.op} takes ${spec.args.length} operand${spec.args.length === 1 ? '' : 's'} (${form}), but got ${st.args.length}.`);
        continue;
      }
      const args = [];
      let ok = true;
      st.args.forEach((a, i) => {
        const o = parseOperand(a, spec.args[i], st.line, spec.op, i);
        if (!o) ok = false;
        args.push(o);
      });
      if (ok) {
        const asm = st.args.length ? `${spec.op} ${st.args.join(', ')}` : spec.op; // no label or comment
        program.push({ op: spec.op, args, cost: spec.cost, line: st.line, text: st.text, asm });
      }
    }

    // Jumps to an index past the end are legal (they wrap to 0), but not beyond that.
    for (const ins of program) {
      if (BB.ISA.INSTRUCTION_MAP[ins.op].args[0] === 'target') {
        const t = ins.args[0].v;
        if (t < 0 || t > statements.length) err(ins.line, `Jump target ${t} is outside the program.`);
      }
    }

    if (!errors.length && program.length === 0) {
      err(Math.min(lines.length, 2), 'The program has no instructions. Add code after the name line.');
    }

    errors.sort((a, b) => a.line - b.line);
    return { name, appearance, program: errors.length ? [] : program, errors, warnings };
  }

  BB.assemble = assemble;
})(globalThis.BB = globalThis.BB || {});
