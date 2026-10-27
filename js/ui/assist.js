/*
 * assist.js — Editing help with no DOM access, so tests can check it:
 *   completions(text, caret)  what autocomplete offers at the caret
 *   toggleComments(text, from, to)  Ctrl+/ on the lines touched by a selection
 *   wordContext(text, row, index)  what a hovered word means where it is written
 *   headerEnd(text), deadAfter(text, row)  where the Insert menu may put code, and whether it can run there
 */
(function (BB) {
  'use strict';

  const { INSTRUCTIONS, INSTRUCTION_MAP, SENSORS } = BB.ISA;
  const REGISTERS = Array.from({ length: BB.CONFIG.NUM_REGS }, (_, i) => `R${i}`);

  /** First sentence of a description, for the short note beside a suggestion. */
  const firstSentence = (s) => (s ? s.split(/(?<=[.!?])\s/)[0] : '');

  /** Labels and constants defined anywhere in the program (as written), plus each constant's value. */
  function namesIn(text) {
    const labels = [], constants = [], values = Object.create(null);
    text.split('\n').forEach((line, i) => {
      if (i === 0) return; // line 1 is the robot's name
      let code = line.replace(/[;#].*$/, '');
      const def = /^\s*\.(def|const|equ)\s+([A-Za-z_]\w*)(?:\s+(\S+))?/i.exec(code);
      if (def) { constants.push(def[2]); values[def[2].toUpperCase()] = def[3]; return; }
      let m;
      while ((m = /^\s*([A-Za-z_]\w*)\s*:/.exec(code))) { labels.push(m[1]); code = code.slice(m[0].length); }
    });
    return { labels, constants, values };
  }

  const DEF_RE = /^(def|const|equ)$/i;

  /**
   * What the word starting at `index` on line `row` (0-based) means where it is written,
   * for hover help: { role, word, key?, value? } or null.
   * Roles: 'directive' (key: shape/drive/turret/def), 'preset' (key), 'constant' (value),
   * 'label', 'instruction', 'sensor', 'register'.
   */
  function wordContext(text, row, index) {
    if (row < 1) return null; // the name line
    const line = (text.split('\n')[row] || '').replace(/\r$/, '');
    const comment = line.search(/[;#]/);
    if (comment >= 0 && index >= comment) return null;
    const code = comment >= 0 ? line.slice(0, comment) : line;
    const m = /^[A-Za-z_]\w*/.exec(code.slice(index));
    if (!m || /\w/.test(code.charAt(index - 1))) return null;
    const word = m[0], W = word.toUpperCase();
    const { labels, constants, values } = namesIn(text);
    const has = (list) => list.some((n) => n.toUpperCase() === W);
    // Directive lines: `.turret twin`, `.def SPEED_UP 5`.
    const dir = /^\s*\.([A-Za-z_]\w*)/.exec(code);
    if (dir) {
      const key = DEF_RE.test(dir[1]) ? 'def' : dir[1].toLowerCase();
      const known = key === 'def' || Object.prototype.hasOwnProperty.call(BB.ISA.APPEARANCE, key);
      if (!known) return null;
      if (index < dir[0].length) return { role: 'directive', word, key };
      if (key === 'def') {
        const name = /^(\s*\S+\s+)([A-Za-z_]\w*)/.exec(code);
        if (name && index === name[1].length) return { role: 'constant', word, value: values[W] };
        return has(constants) ? { role: 'constant', word, value: values[W] } : null;
      }
      return { role: 'preset', word, key };
    }
    // Labels at the start: `loop:` (several are allowed).
    let pos = 0, lm;
    const rest = () => code.slice(pos);
    while ((lm = /^\s*([A-Za-z_]\w*)\s*:/.exec(rest()))) {
      const at = pos + lm[0].indexOf(lm[1]);
      if (index === at) return { role: 'label', word };
      pos += lm[0].length;
    }
    const op = /^\s*([A-Za-z_]\w*)/.exec(rest());
    if (!op) return null;
    const opAt = pos + op[0].length - op[1].length;
    if (index === opAt) return INSTRUCTION_MAP[W] ? { role: 'instruction', word } : null;
    if (index < opAt) return null;
    const spec = INSTRUCTION_MAP[op[1].toUpperCase()];
    const argIndex = (code.slice(opAt + op[1].length, index).match(/,/g) || []).length;
    const kind = spec && spec.args[argIndex];
    if (kind === 'sensor') return BB.ISA.SENSOR_MAP[W] ? { role: 'sensor', word } : null;
    if (kind === 'target') return has(labels) ? { role: 'label', word } : null;
    if (REGISTERS.includes(W)) return { role: 'register', word };
    if (has(constants)) return { role: 'constant', word, value: values[W] };
    if (has(labels)) return { role: 'label', word };
    return null;
  }

  /**
   * What to offer at `caret` in `text`: { start, prefix, items: [{ text, kind, detail }] },
   * or null when nothing fits (name line, comments, a word already complete...).
   * Instructions are offered from the 2nd letter, everything else from the 1st.
   */
  function completions(text, caret) {
    const before = text.slice(0, caret);
    const lineStart = before.lastIndexOf('\n') + 1;
    if (lineStart === 0) return null; // the name line
    const line = before.slice(lineStart);
    if (/[;#]/.test(line)) return null; // inside a comment
    if (/\w/.test(text.charAt(caret))) return null; // only at the end of a word
    const word = /[A-Za-z_]\w*$/.exec(line);
    const prefix = word ? word[0] : '';
    if (!prefix) return null;
    const start = caret - prefix.length;
    // What comes before the word on this line: labels, then maybe the instruction and operands.
    let head = line.slice(0, line.length - prefix.length);
    if (/\[[^\]]*$/.test(head)) head = head.replace(/\[[^\]]*$/, ''); // inside [ ]: an operand
    head = head.replace(/^\s*([A-Za-z_]\w*\s*:\s*)*/, '');
    const P = prefix.toUpperCase();
    const starts = (s) => s.toUpperCase().startsWith(P) && s.toUpperCase() !== P;
    let items = [];
    if (!head.trim()) {
      // Start of a statement: an instruction (or a directive like .def, handled by the assembler).
      if (prefix.length < 2 || /\.\s*$/.test(head)) return null;
      items = INSTRUCTIONS.filter((ins) => starts(ins.op)).map((ins) => ({
        text: ins.op, kind: 'instruction', insert: ins.args.length ? `${ins.op} ` : ins.op,
        detail: firstSentence((BB.explain && BB.explain.instruction(ins.op)) || ins.summary),
      }));
    } else {
      const op = /^\s*([A-Za-z]+)\s/.exec(head);
      const spec = op && INSTRUCTION_MAP[op[1].toUpperCase()];
      if (!spec) return null;
      const argIndex = (head.slice(op[0].length).match(/,/g) || []).length;
      const kind = spec.args[argIndex];
      const { labels, constants } = namesIn(text);
      if (kind === 'sensor') {
        items = SENSORS.filter((s) => starts(s.name)).map((s) => ({
          text: s.name, kind: 'sensor', insert: s.name,
          detail: firstSentence((BB.explain && BB.explain.sensor(s.name)) || s.desc),
        }));
      } else if (kind === 'target') {
        items = labels.filter(starts).map((l) => ({ text: l, kind: 'label', insert: l, detail: 'a label in your program' }));
      } else if (kind === 'dst' || kind === 'src') {
        items = REGISTERS.filter(starts).map((r) => ({ text: r, kind: 'register', insert: r, detail: 'a box that holds one number' }))
          .concat(kind === 'src' ? constants.filter(starts).map((c) => ({ text: c, kind: 'constant', insert: c, detail: 'a constant (.def)' })) : []);
      }
    }
    return items.length ? { start, prefix, items: items.slice(0, 8) } : null;
  }

  /**
   * Ctrl+/: comment out the lines touched by the selection [from, to), or
   * uncomment them if they all already start with ";". Blank lines and the
   * name line are left alone. Returns { text, from, to } covering the edited lines.
   */
  function toggleComments(text, from, to) {
    const lineStart = text.lastIndexOf('\n', from - 1) + 1;
    // A selection ending just after a newline doesn't include the next line.
    const endPos = to > from && text.charAt(to - 1) === '\n' ? to - 1 : to;
    let lineEnd = text.indexOf('\n', endPos);
    if (lineEnd < 0) lineEnd = text.length;
    const firstLineNo = text.slice(0, lineStart).split('\n').length - 1; // 0-based
    const lines = text.slice(lineStart, lineEnd).split('\n');
    const editable = (l, i) => firstLineNo + i > 0 && l.trim() !== '';
    const targets = lines.filter(editable);
    if (!targets.length) return { text, from, to };
    const uncomment = targets.every((l) => /^\s*;/.test(l));
    const out = lines.map((l, i) => {
      if (!editable(l, i)) return l;
      return uncomment ? l.replace(/^(\s*);\s?/, '$1') : l.replace(/^(\s*)/, '$1; ');
    }).join('\n');
    return { text: text.slice(0, lineStart) + out + text.slice(lineEnd), from: lineStart, to: lineStart + out.length };
  }

  /**
   * Tab / Shift+Tab on a selection: indent (or outdent) the lines it touches by
   * 4 spaces. Blank lines and the name line are left alone, as in toggleComments.
   * Returns { text, from, to } covering the edited lines.
   */
  function indentLines(text, from, to, outdent) {
    const lineStart = text.lastIndexOf('\n', from - 1) + 1;
    const endPos = to > from && text.charAt(to - 1) === '\n' ? to - 1 : to;
    let lineEnd = text.indexOf('\n', endPos);
    if (lineEnd < 0) lineEnd = text.length;
    const firstLineNo = text.slice(0, lineStart).split('\n').length - 1;
    const out = text.slice(lineStart, lineEnd).split('\n').map((l, i) => {
      if (firstLineNo + i === 0 || l.trim() === '') return l;
      return outdent ? l.replace(/^(\t| {1,4})/, '') : `    ${l}`;
    }).join('\n');
    return { text: text.slice(0, lineStart) + out + text.slice(lineEnd), from: lineStart, to: lineStart + out.length };
  }

  /** Code part of a line: no comment, trimmed. */
  const codeOf = (line) => (line || '').replace(/[;#].*$/, '').trim();
  const LABELS_RE = /^([A-Za-z_]\w*\s*:\s*)+/;

  /** Index (0-based) of the last line of the name and appearance header. Inserted code goes below it. */
  function headerEnd(text) {
    const lines = text.split('\n');
    let end = 0;
    for (let i = 1; i < lines.length; i++) {
      const code = codeOf(lines[i]);
      if (/^\.(shape|drive|turret)\b/i.test(code)) end = i;
      else if (code) break;
    }
    return end;
  }

  /**
   * Code starting at line `row` (0-based) can never run if the code line above it
   * always jumps away and nothing can jump to it. Returns that line's instruction
   * ("JMP main", "RET" or "HALT"), or null when the code can run.
   */
  function deadAfter(text, row) {
    const lines = text.split('\n');
    const first = lines.slice(row).map(codeOf).find(Boolean);
    if (!first || LABELS_RE.test(first)) return null; // a label: a jump can reach it
    for (let i = row - 1; i >= 1; i--) {
      const code = codeOf(lines[i]);
      if (!code) continue;
      const ins = code.replace(LABELS_RE, '');
      if (!ins) return null; // a label just above
      return /^(JMP|RET|HALT)\b/i.test(ins) ? ins.replace(/\s+/g, ' ') : null;
    }
    return null;
  }

  BB.assist = { completions, toggleComments, indentLines, namesIn, wordContext, headerEnd, deadAfter };
})(globalThis.BB = globalThis.BB || {});
