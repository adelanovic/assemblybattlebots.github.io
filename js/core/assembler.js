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
  const C = BB.CONFIG;
  const { NUM_REGS, MEMORY_SIZE } = C;

  const IDENT_RE = /^[A-Z_][A-Z0-9_]*$/;
  const REG_RE = /^R(\d+)$/;
  const NUM_RE = /^[+-]?(0X[0-9A-F]+|\d+)$/;
  // Dashes that word processors put in place of a minus sign, so code pasted from a document breaks.
  const DASH_RE = /[\u2010-\u2015\u2212\uFE63\uFF0D]/;
  // Commas from other keyboard layouts (，、﹐﹑،), which look like a comma but don't separate operands.
  const ODD_COMMA_RE = /[\uFF0C\u3001\uFE50\uFE51\u060C]/;
  // Invisible characters that come along when code is copied from a document or web page.
  const INVISIBLE_RE = /[\u200B-\u200D\u2060\uFEFF]/;
  const INVISIBLE_ALL_RE = new RegExp(INVISIBLE_RE.source, 'g');
  // Wide punctuation from other keyboard layouts, and the plain key to type instead.
  const WIDE_PUNCT = { '\uFF1B': ';', '\uFF3B': '[', '\uFF3D': ']', '\uFF03': '#', '\uFF1A': ':' };
  const WIDE_PUNCT_RE = /[\uFF1B\uFF3B\uFF3D\uFF03\uFF1A]/;
  const DECIMAL_RE = /^[+-]?\d*\.\d+$/;
  const MAX_NAME = 24;
  const ORDINAL = ['first', 'second', 'third'];

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
    if (word.length < 3) return ''; // "5" -> "X" or "IF" -> "DIV" would mislead
    // Real names are short; a pasted wall of text or thousands of labels would freeze the page.
    if (word.length > 32 || candidates.length > 500) return '';
    let best = null, bestD = 3;
    for (const c of candidates) {
      const d = levenshtein(word, c);
      if (d < bestD) { best = c; bestD = d; }
    }
    return best ? ` Did you mean ${best}?` : '';
  }

  /**
   * Line 1 is only the name, so code there never runs. It usually gets there when
   * the real name line is deleted. Returns null for a name, or { label } (the label
   * it would define, upper case, or null) when the line looks like code.
   */
  function codeOnNameLine(line) {
    const label = /^([A-Za-z_]\w*)\s*:/.exec(line);
    if (label) return { label: label[1].toUpperCase() };
    if (line[0] === '.') return { label: null };
    const m = /^([A-Za-z]+)\s+(\S.*)$/.exec(line);
    const spec = m && INSTRUCTION_MAP[m[1].toUpperCase()];
    if (!spec || !spec.args.length) return null; // "Fire" or "Turn Left" are fine names
    // A jump to a label is code even though the label is defined further down.
    if (spec.args[0] === 'target' && /^[A-Za-z_]\w*$/.test(m[2].trim())) return { label: null };
    return assemble(`Name\n${line}`).errors.length ? null : { label: null };
  }

  /** Words beginners often try, from other languages or plain English. */
  const FRIENDLY = {
    IF: 'Assembly has no IF: compare with CMP, then jump with JL, JG, JE and friends.',
    ELSE: 'Assembly has no ELSE: jump past the code you want to skip with JMP.',
    WHILE: 'Assembly has no WHILE: put a label at the top of the loop and JMP back to it.',
    FOR: 'Assembly has no FOR: count with INC or DEC, CMP, then jump back to a label.',
    LOOP: 'To loop, put a label like "main:" at the top and JMP back to it.',
    GOTO: 'Use JMP to jump to a label.',
    SET: 'Use MOV to put a value in a register, e.g. "MOV R0, 5".',
    LET: 'Use MOV to put a value in a register, e.g. "MOV R0, 5".',
    PRINT: 'Robots can\'t print. Watch your registers in the CPU inspector instead.',
    SHOOT: 'Use FIRE.',
    MOVE: 'Use SPEED to drive, e.g. "SPEED 5".', DRIVE: 'Use SPEED to drive, e.g. "SPEED 5".', GO: 'Use SPEED to drive, e.g. "SPEED 5".',
    LEFT: 'Use TURN with a negative number to turn left, e.g. "TURN -90".',
    RIGHT: 'Use TURN to turn right, e.g. "TURN 90".',
    ROTATE: 'Use TURN to turn the body, or AIM to point the turret.',
    STOP: 'Use "SPEED 0" to stop, or HALT to end the program.',
    END: 'Use HALT to stop the program for good.',
  };

  /** For text holding a pasted dash: say what it is and what to type instead. */
  function dashMessage(raw) {
    const fixed = raw.replace(new RegExp(DASH_RE.source, 'g'), '-');
    return `"${raw}" has a "${DASH_RE.exec(raw)[0]}" copied from a document, not a minus sign. Type the - key instead: "${fixed}".`;
  }

  /** A word to quote in a message, cut short if someone pasted something huge. */
  const quote = (s) => (s.length > 40 ? `${s.slice(0, 37)}...` : s);

  /** For "2.5": robots only use whole numbers, so suggest the two nearest. */
  function decimalMessage(raw) {
    const v = Number(raw);
    return `Robots only use whole numbers, so "${raw}" won't work. Try ${Math.floor(v)} or ${Math.ceil(v)} instead.`;
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
    const errors = [];
    const warnings = [];
    // Invisible characters make correct-looking code fail ("MOV​R0" is one word), so drop them and say so.
    const lines = String(source).replace(/\r\n?/g, '\n').split('\n').map((line, i) => {
      if (!INVISIBLE_RE.test(line)) return line;
      warnings.push({ line: i + 1, message: 'This line has an invisible character, copied from a document or web page. It was skipped when checking your code, so you can leave it there.' });
      return line.replace(INVISIBLE_ALL_RE, '');
    });
    const appearance = Object.fromEntries(Object.entries(BB.ISA.APPEARANCE).map(([key, spec]) => [key, spec.default]));
    const appearanceSeen = new Set();
    let inHeader = true;
    const err = (line, message) => errors.push({ line, message });

    // ---- Line 1: robot name ----
    let name = (lines[0] || '').replace(/^\s*[;#]+/, '').trim();
    const nameCode = name ? codeOnNameLine(name) : null;
    if (nameCode) {
      warnings.push({ line: 1, message: `Line 1 is only your robot's name, so "${name}" won't run as code. Put a name on line 1 (like "Rookie") and start your code on line 2.` });
    }
    if (!name) {
      err(1, 'Line 1 must contain the robot\'s name (for example: "Sentinel").');
      name = 'Unnamed';
    } else if ([...name].length > MAX_NAME) {
      // Count code points, so an emoji is never cut in half.
      warnings.push({ line: 1, message: `Name truncated to ${MAX_NAME} characters.` });
      name = [...name].slice(0, MAX_NAME).join('');
    }
    if (/[;#]/.test(name)) {
      warnings.push({ line: 1, message: 'Line 1 is only the robot\'s name, so this ; or # is part of the name. Put comments on line 2 or later.' });
    }

    // ---- Pass 1: labels, constants, raw statements ----
    const labels = Object.create(null);
    const constants = Object.create(null);
    const definedAt = Object.create(null); // name -> line, for "already used on line N"
    const statements = [];
    const rejectedLabels = new Set(); // already reported; don't also flag each jump to them

    const checkNewName = (lineNo, id, what, shown = id) => {
      if (!IDENT_RE.test(id)) { err(lineNo, `"${id}" is not a valid ${what} name (use letters, digits and _, not starting with a digit).`); return false; }
      if (REG_RE.test(id)) { err(lineNo, `"${id}" is a register and cannot be used as a ${what} name.`); return false; }
      if (INSTRUCTION_MAP[id]) {
        err(lineNo, `"${id}" is an instruction and cannot be used as a ${what} name. Try something like "${id.toLowerCase()}_${what === 'label' ? 'here' : 'value'}".`);
        return false;
      }
      if (labels[id] !== undefined || constants[id] !== undefined) {
        err(lineNo, `"${shown}" is already used on line ${definedAt[id]}. Each name can only be defined once (upper and lower case count as the same name).`);
        return false;
      }
      definedAt[id] = lineNo;
      return true;
    };

    for (let i = 1; i < lines.length; i++) {
      const lineNo = i + 1;
      const raw = lines[i];
      const wide = WIDE_PUNCT_RE.exec(stripComment(raw));
      if (wide) {
        const plain = WIDE_PUNCT[wide[0]];
        err(lineNo, `The "${wide[0]}" isn't a plain "${plain}": it comes from another keyboard layout. Type the ${plain} key instead.`);
        continue;
      }
      let text = stripComment(raw).trim();
      if (!text) continue;

      const header = /^(\.\S+)(?:\s+(.*))?$/.exec(text);
      const key = header && header[1].slice(1).toLowerCase();
      const appearanceSpec = key && Object.prototype.hasOwnProperty.call(BB.ISA.APPEARANCE, key) && BB.ISA.APPEARANCE[key];
      if (appearanceSpec) {
        let value = (header[2] || '').trim().toLowerCase();
        // .badge also takes a number, kept without leading zeros ("07" is 7).
        if (appearanceSpec.numbers && /^\d{1,3}$/.test(value)) value = String(Number(value));
        const orNumber = appearanceSpec.numbers ? `, or a number from 1 to ${appearanceSpec.numbers}` : '';
        if (!inHeader) err(lineNo, `.${key} must appear in the appearance header below the name, before labels, constants or instructions.`);
        else if (appearanceSeen.has(key)) err(lineNo, `.${key} is already specified.`);
        else if (!BB.ISA.appearanceAllows(appearanceSpec, value)) err(lineNo, `.${key} expects one preset: ${appearanceSpec.choices.join(', ')}${orNumber}.`);
        else appearance[key] = value;
        appearanceSeen.add(key);
        continue;
      }
      inHeader = false;

      // Leading labels: "loop:", "a: b: MOV R0, 1"
      let m;
      while ((m = /^([^\s:,\[\]]+)\s*:/.exec(text))) {
        const id = m[1].toUpperCase();
        if (checkNewName(lineNo, id, 'label', m[1])) labels[id] = statements.length;
        else rejectedLabels.add(id);
        text = text.slice(m[0].length).trim();
      }
      if (!text) continue;

      // Directives
      if (text[0] === '.') {
        const parts = text.split(/\s+/);
        const dir = parts[0].toUpperCase();
        const late = dir.slice(1).toLowerCase();
        if (dir === '.DEF' || dir === '.CONST' || dir === '.EQU') {
          if (text.includes(',')) { err(lineNo, `${parts[0]} doesn't use commas. Write "${text.replace(/\s*,\s*/g, ' ')}".`); continue; }
          if (DASH_RE.test(text)) { err(lineNo, dashMessage(text)); continue; }
          if (parts.length !== 3) { err(lineNo, `${dir} expects a name and a value, e.g. ".def RANGE 200".`); continue; }
          const id = parts[1].toUpperCase();
          const v = parseNumber(parts[2].toUpperCase());
          if (v === null) { err(lineNo, DECIMAL_RE.test(parts[2]) ? decimalMessage(parts[2]) : `${dir} value "${parts[2]}" is not a number.`); continue; }
          if (v > 2147483647 || v < -2147483648) {
            err(lineNo, `Number ${parts[2]} does not fit in 32 bits.`);
            continue;
          }
          if (checkNewName(lineNo, id, 'constant', parts[1])) {
            constants[id] = v;
            // MOV R0, FRONT would then use the constant, while GET R0, FRONT still reads the sensor.
            if (SENSOR_MAP[id]) warnings.push({ line: lineNo, message: `${parts[1]} is also a sensor's name. "MOV R0, ${parts[1]}" will use your constant, but "GET R0, ${parts[1]}" still reads the sensor. A different name avoids the mix-up.` });
          }
        } else if (Object.prototype.hasOwnProperty.call(BB.ISA.APPEARANCE, late)) {
          // "loop: .shape tank": a header line after a label is too late, not unknown.
          err(lineNo, `.${late} must appear in the appearance header below the name, before labels, constants or instructions.`);
        } else {
          err(lineNo, `Unknown directive "${parts[0]}". Supported: .def NAME value; header presets .shape, .drive, .turret.`);
        }
        continue;
      }

      const sp = text.search(/\s/);
      const word = sp < 0 ? text : text.slice(0, sp);
      const argText = sp < 0 ? '' : text.slice(sp + 1);
      statements.push({ op: word.toUpperCase(), word, args: splitArgs(argText), argText, line: lineNo, text: raw.trim() });
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
      if (/^-\d+$/.test(t)) { err(lineNo, `Memory slots go from [0] to [${MEMORY_SIZE - 1}], so [${t}] would crash your robot.`); return null; }
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
        if (resolveReg(m[3]) !== -1) { err(lineNo, `In [${inner}], the register comes first: write [${m[3]}${m[2]}${m[1]}].`); return null; }
        const v = resolveValue(m[3], lineNo);
        if (v === undefined) { err(lineNo, `Offset "${m[3]}" must be a number or constant.`); return null; }
        if (v === null) return null;
        // [BASE+4] with no register: a fixed address worked out now, checked below like [14].
        off += m[2] === '-' ? -v : v;
      }
      // A fixed address outside memory would crash the robot every time it runs.
      if (r < 0 && (off < 0 || off >= MEMORY_SIZE)) {
        err(lineNo, `Memory slots go from [0] to [${MEMORY_SIZE - 1}], so [${off}] would crash your robot.`);
        return null;
      }
      return { k: 'mem', r, off };
    }

    function parseOperand(raw, kind, lineNo, op, idx) {
      const tok = raw.toUpperCase();
      const where = `${op}'s ${ORDINAL[idx]} value`;
      if (!tok) { err(lineNo, `${where} is empty.`); return null; }
      if (DASH_RE.test(raw)) { err(lineNo, dashMessage(raw)); return null; }
      if (/["'‘’“”]/.test(raw)) {
        err(lineNo, `Values don't go in quotes: write ${raw.replace(/["'‘’“”]/g, '')}, not ${raw}.`);
        return null;
      }

      if (kind === 'target') {
        if (labels[tok] !== undefined) return { k: 'imm', v: labels[tok] };
        if (REG_RE.test(tok)) { err(lineNo, `${op} needs a label to jump to, like "${op} main". It can't jump to a register.`); return null; }
        const n = parseNumber(tok);
        if (n !== null) {
          if (n < 0 || n > statements.length) return { k: 'imm', v: n }; // out of range: reported once, below
          // Legal, but beginners read it as a line number, which it isn't.
          const where = n === 0 ? 'the first instruction' : `instruction number ${n} (counting from 0), not line ${n}`;
          warnings.push({ line: lineNo, message: `"${op} ${raw}" goes to ${where}. A label, like "${op} main", is clearer.` });
          return { k: 'imm', v: n };
        }
        if (rejectedLabels.has(tok)) return null; // error already reported at the label
        if (constants[tok] !== undefined) {
          err(lineNo, `"${raw}" is a constant, not a label (names are case-insensitive).`);
          return null;
        }
        const hint = nameCode && nameCode.label === tok
          ? ` Line 1 is your robot's name, so the "${raw}:" there doesn't count as a label.`
          : suggest(tok, Object.keys(labels));
        err(lineNo, `Unknown label "${quote(raw)}".${hint}`);
        return null;
      }

      if (kind === 'sensor') {
        if (SENSOR_MAP[tok]) return { k: 'imm', v: SENSOR_MAP[tok].id };
        if (REG_RE.test(tok) || parseNumber(tok) !== null) {
          err(lineNo, `${op}'s second operand must be a sensor name, such as HEALTH or FRONT, not "${raw}".`);
        } else {
          err(lineNo, `Unknown sensor "${raw}".${suggest(tok, Object.keys(SENSOR_MAP))}`);
        }
        return null;
      }

      // dst / src
      const mem = /^\[(.*)\]$/.exec(tok);
      if (mem) return parseMemory(mem[1], lineNo);
      if (tok.startsWith('[')) { err(lineNo, `Memory operand "${raw}" is missing its closing ].`); return null; }
      if (tok.includes('//')) { err(lineNo, `"${raw}" isn't a value. Comments start with ; or #, not //.`); return null; }

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
      if (DECIMAL_RE.test(tok)) { err(lineNo, decimalMessage(raw)); return null; }

      // A label that shares a sensor's name (x: and X) is still a label here.
      let hint = '';
      if (labels[tok] !== undefined) hint = ' Labels can only be used as jump targets.';
      else if (SENSOR_MAP[tok]) hint = ` To read a sensor, use GET first, e.g. "GET R0, ${tok}".`;
      else hint = suggest(tok, Object.keys(constants));
      err(lineNo, `Unknown name "${quote(raw)}" — expected ${ARG_HINT[kind]}.${hint}`);
      return null;
    }

    // Names jumped to. A lone word that is one of them is a label missing its colon ("main" for "main:"):
    // reported once at that word, not again at every jump to it.
    const jumpTargets = new Set();
    for (const st of statements) {
      const spec = INSTRUCTION_MAP[st.op];
      if (spec && spec.args[0] === 'target' && st.args.length === 1) jumpTargets.add(st.args[0].toUpperCase());
    }
    const colonless = (st) => !st.args.length && IDENT_RE.test(st.op) && !REG_RE.test(st.op) && jumpTargets.has(st.op);
    for (const st of statements) if (!INSTRUCTION_MAP[st.op] && colonless(st)) rejectedLabels.add(st.op);

    /** "Unknown instruction", with the hint that fits what was probably meant. */
    const unknownInstruction = (st) => {
      if (colonless(st)) return `"${st.word}" is used as a label, so it needs a colon at the end: write "${st.word}:".`;
      if (/^(\/\/|\/\*|--)/.test(st.word)) return `"${st.word}" isn't a comment here. Comments start with ; or #, like "; ${st.text.replace(/^(\/\/|\/\*|--)\s*/, '')}".`;
      const base = `Unknown instruction "${quote(st.op)}".`;
      const assign = /^([+\-*/]?)=\s*(.*)$/.exec(st.argText.trim()); // "R0 = 5", "x += 1"
      if (assign) {
        const op = { '': 'MOV', '+': 'ADD', '-': 'SUB', '*': 'MUL', '/': 'DIV' }[assign[1]];
        const reg = REG_RE.test(st.op) ? st.word : 'R0';
        return `${base} Assembly has no "${assign[1]}=". Use ${op}, like "${op} ${reg}, ${assign[2].trim() || 5}".`;
      }
      if (FRIENDLY[st.op]) return `${base} ${FRIENDLY[st.op]}`;
      if (REG_RE.test(st.op)) return `${base} A line starts with an instruction, like "MOV ${st.word}, 5".`;
      const hint = suggest(st.op, Object.keys(INSTRUCTION_MAP));
      if (st.args.length || !IDENT_RE.test(st.op)) return `${base}${hint}`;
      // A lone word may be a label missing its colon, even when nothing jumps to it yet.
      return `${base}${hint}${hint ? ' Or, if' : ' If'} it's a label, add a colon at the end: "${st.word}:".`;
    };

    /** "MOV R0 5": operands separated by spaces instead of commas. */
    const commaTip = (st, spec) => {
      if (st.args.length >= spec.args.length) return '';
      const odd = ODD_COMMA_RE.exec(st.argText);
      if (odd) return ` The "${odd[0]}" isn't a plain comma: type the , key instead.`;
      const parts = st.args.flatMap((a) => (/[[\]]/.test(a) ? [a] : a.split(/\s+/)));
      if (parts.length === spec.args.length) return ` Did you forget a comma? Write "${spec.op} ${parts.join(', ')}".`;
      return st.args.some((a) => /\S\s+\S/.test(a.replace(/\[[^\]]*\]/g, '[]'))) ? ' Put a comma between operands.' : '';
    };

    /** Code that would crash every time it runs, caught before the match: a message, or null. */
    const certainCrash = (spec, args, st) => {
      const b = args[1];
      if (!b || b.k !== 'imm') return null;
      if ((spec.op === 'DIV' || spec.op === 'MOD') && b.v === 0) return `${spec.op} by 0 would crash your robot: nothing can be divided by zero. Use a different number.`;
      if (spec.op === 'RAND' && b.v <= 0) return `RAND needs a number bigger than 0, like "RAND ${st.args[0]}, 360".`;
      if (spec.op === 'SQRT' && b.v < 0) return 'SQRT of a negative number would crash your robot. Use 0 or more.';
      return null;
    };

    /** Values the world quietly clamps (SPEED 10 drives at 5): a gentle warning, since it still runs. */
    const clampWarning = (spec, args, st) => {
      const a = args[0];
      if (!a || a.k !== 'imm') return null;
      const said = `"${spec.op} ${st.args[0]}"${/^[+-]?\d+$/.test(st.args[0]) ? '' : ` (${st.args[0]} is ${a.v})`}`;
      if (spec.op === 'SPEED' && (a.v > C.MAX_SPEED || a.v < C.MAX_REVERSE)) {
        const to = Math.max(C.MAX_REVERSE, Math.min(C.MAX_SPEED, a.v));
        return `${said} drives at ${to}: SPEED goes from ${C.MAX_REVERSE} to ${C.MAX_SPEED}.`;
      }
      if (spec.op === 'SCAN' && (a.v > C.SCAN_MAX_WIDTH || a.v < 1)) {
        const to = Math.max(1, Math.min(C.SCAN_MAX_WIDTH, a.v));
        return `${said} looks ${to}° wide: SCAN cones go from 1° to ${C.SCAN_MAX_WIDTH}°.`;
      }
      return null;
    };

    for (const st of statements) {
      const spec = INSTRUCTION_MAP[st.op];
      if (!spec) {
        err(st.line, unknownInstruction(st));
        continue;
      }
      // "MOV R0, #5": the # starts a comment, so the 5 is cut off.
      if (/,\s*#\s*[-+]?\d/.test(st.text)) {
        err(st.line, `Numbers don't need a # in front. # starts a comment, so everything after it is ignored. Write "${st.text.replace(/#\s*(?=[-+]?\d)/, '')}".`);
        continue;
      }
      if (st.args.length > 1 && st.args.some((a) => !a)) {
        err(st.line, `${spec.op} has an extra comma, or a value missing between commas.`);
        continue;
      }
      if (st.args.length !== spec.args.length) {
        const n = spec.args.length, got = st.args.length;
        const gave = `this line gives ${got}`;
        err(st.line, (n
          ? `${spec.op} needs ${n} value${n === 1 ? '' : 's'}, like "${spec.example}", but ${gave}.`
          : `${spec.op} doesn't take any values, but ${gave}.`) + commaTip(st, spec));
        continue;
      }
      const args = [];
      let ok = true;
      st.args.forEach((a, i) => {
        const o = parseOperand(a, spec.args[i], st.line, spec.op, i);
        if (!o) ok = false;
        args.push(o);
      });
      if (!ok) continue;
      const crash = certainCrash(spec, args, st);
      if (crash) { err(st.line, crash); continue; }
      const clamped = clampWarning(spec, args, st);
      if (clamped) warnings.push({ line: st.line, message: clamped });
      const asm = st.args.length ? `${spec.op} ${st.args.join(', ')}` : spec.op; // no label or comment
      program.push({ op: spec.op, args, cost: spec.cost, line: st.line, text: st.text, asm });
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
