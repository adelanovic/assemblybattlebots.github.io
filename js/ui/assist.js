/*
 * assist.js — Editing help with no DOM access, so tests can check it:
 *   completions(text, caret)  what autocomplete offers at the caret
 *   toggleComments(text, from, to)  Ctrl+/ on the lines touched by a selection
 */
(function (BB) {
  'use strict';

  const { INSTRUCTIONS, INSTRUCTION_MAP, SENSORS } = BB.ISA;
  const REGISTERS = Array.from({ length: BB.CONFIG.NUM_REGS }, (_, i) => `R${i}`);

  /** First sentence of a description, for the short note beside a suggestion. */
  const firstSentence = (s) => (s ? s.split(/(?<=[.!?])\s/)[0] : '');

  /** Labels and constants defined anywhere in the program (as written). */
  function namesIn(text) {
    const labels = [], constants = [];
    text.split('\n').forEach((line, i) => {
      if (i === 0) return; // line 1 is the robot's name
      let code = line.replace(/[;#].*$/, '');
      const def = /^\s*\.(def|const|equ)\s+([A-Za-z_]\w*)/i.exec(code);
      if (def) { constants.push(def[2]); return; }
      let m;
      while ((m = /^\s*([A-Za-z_]\w*)\s*:/.exec(code))) { labels.push(m[1]); code = code.slice(m[0].length); }
    });
    return { labels, constants };
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

  BB.assist = { completions, toggleComments, namesIn };
})(globalThis.BB = globalThis.BB || {});
