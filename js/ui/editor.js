/*
 * editor.js — A lightweight code editor: a <textarea> layered over a
 * syntax-highlighted <pre>, with a gutter showing line numbers, error
 * markers and the line the selected robot's CPU is about to execute.
 */
(function (BB) {
  'use strict';

  const { INSTRUCTION_MAP, SENSOR_MAP } = BB.ISA;

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function highlightLine(line, index) {
    if (index === 0) return `<span class="t-name">${esc(line)}</span>`;
    const ci = line.search(/[;#]/);
    const code = ci >= 0 ? line.slice(0, ci) : line;
    const comment = ci >= 0 ? line.slice(ci) : '';
    let html = code.replace(/(\.[A-Za-z]+)|(\[|\])|([A-Za-z_][A-Za-z0-9_]*:)|([A-Za-z_][A-Za-z0-9_]*)|(-?0x[0-9a-fA-F]+|-?\d+)|([^\w.\[\]-]+|.)/g,
      (m, dir, br, label, word, num, other) => {
        if (dir) return `<span class="t-dir">${esc(m)}</span>`;
        if (br) return `<span class="t-br">${m}</span>`;
        if (label) return `<span class="t-label">${esc(m)}</span>`;
        if (word) {
          const u = word.toUpperCase();
          if (INSTRUCTION_MAP[u]) return `<span class="t-op">${esc(m)}</span>`;
          if (/^R[0-7]$/.test(u)) return `<span class="t-reg">${esc(m)}</span>`;
          if (SENSOR_MAP[u]) return `<span class="t-sensor">${esc(m)}</span>`;
          return `<span class="t-ident">${esc(m)}</span>`;
        }
        if (num) return `<span class="t-num">${esc(m)}</span>`;
        return esc(m);
      });
    if (comment) html += `<span class="t-comment">${esc(comment)}</span>`;
    return html;
  }

  /** 950, 1.2k, 34k, 1.5M */
  function formatCount(n) {
    if (n < 1000) return String(n);
    if (n < 1e6) return `${n < 1e4 ? (n / 1e3).toFixed(1) : Math.round(n / 1e3)}k`;
    return `${(n / 1e6).toFixed(1)}M`;
  }

  class CodeEditor {
    constructor(root) {
      root.classList.add('code-editor');
      root.innerHTML = `
        <div class="ce-gutter" title="Click a line number to set or clear a breakpoint"><div class="ce-gutter-lines"></div></div>
        <div class="ce-body">
          <div class="ce-marks"></div>
          <pre class="ce-hl" aria-hidden="true"></pre>
          <div class="ce-marks ce-cover"></div>
          <textarea class="ce-input" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off"></textarea>
        </div>`;
      this.gutter = root.querySelector('.ce-gutter');
      this.gutterLines = root.querySelector('.ce-gutter-lines');
      this.hl = root.querySelector('.ce-hl');
      this.input = root.querySelector('.ce-input');
      this.marks = root.querySelector('.ce-marks');   // behind the code
      this.cover = root.querySelector('.ce-cover');   // over the code, dims lines
      this.errorLines = new Set();
      this.breakLines = new Set();
      this.execLine = 0;
      this.execKind = 'exec';
      this.counts = [];       // [line, times run] per instruction line
      this.countsKey = '';
      this.listeners = [];
      this.gutterListeners = [];
      // Hover help: `helpProvider(word, { line, index })` returns tooltip HTML or null.
      this.helpProvider = null;
      this.tip = document.createElement('div');
      this.tip.className = 'ce-tip';
      this.tip.hidden = true;
      document.body.appendChild(this.tip);
      this.tipKey = '';
      this.input.addEventListener('mousemove', (ev) => this.onHover(ev));
      for (const type of ['mousedown', 'keydown', 'scroll']) this.input.addEventListener(type, () => this.hideTip());
      // The tooltip is clickable ("More in Reference"), so leaving the code gives
      // the mouse a moment to reach it before it closes.
      this.input.addEventListener('mouseleave', () => this.hideTipSoon());
      this.tip.addEventListener('mouseenter', () => clearTimeout(this.tipTimer));
      this.tip.addEventListener('mouseleave', () => this.hideTip());
      this.linkListeners = [];
      this.tip.addEventListener('click', (ev) => {
        const link = ev.target.closest('[data-ref]');
        if (!link) return;
        this.hideTip();
        this.linkListeners.forEach((f) => f(link.dataset.ref));
      });

      this.input.addEventListener('input', () => {
        this.render();
        this.listeners.forEach((f) => f(this.value));
        if (!this.quietInput) this.updateCompletions();
      });
      // Autocomplete popup: suggestions for the word being typed (see assist.js).
      this.complete = document.createElement('div');
      this.complete.className = 'ce-complete';
      this.complete.hidden = true;
      this.complete.setAttribute('role', 'listbox');
      document.body.appendChild(this.complete);
      this.completion = null; // { start, prefix, items, index } while open
      this.complete.addEventListener('mousedown', (ev) => {
        ev.preventDefault(); // keep the caret in the textarea
        const item = ev.target.closest('[data-i]');
        if (item) this.acceptCompletion(Number(item.dataset.i));
      });
      for (const type of ['blur', 'scroll', 'mousedown']) this.input.addEventListener(type, () => this.closeCompletions());
      // Popups are placed in window coordinates, so a resize would leave them stranded.
      window.addEventListener('resize', () => { this.closeCompletions(); this.hideTip(); });
      this.gutter.addEventListener('click', (ev) => {
        const row = ev.target.closest('[data-n]');
        if (row) this.gutterListeners.forEach((f) => f(Number(row.dataset.n)));
      });
      this.input.addEventListener('scroll', () => this.syncScroll());
      this.input.addEventListener('keydown', (e) => this.onKey(e));
      this.render();
    }

    get value() { return this.input.value; }
    set value(v) {
      this.input.value = v;
      this.input.scrollTop = 0;
      this.render();
    }

    onChange(fn) { this.listeners.push(fn); }

    /** `fn(line)` runs when a line number is clicked. */
    onGutterClick(fn) { this.gutterListeners.push(fn); }

    /** `fn(word)` returns tooltip HTML for a hovered word, or null for none. */
    setHelp(fn) { this.helpProvider = fn; }

    charWidth() {
      if (!this.cw) {
        const cs = getComputedStyle(this.input);
        const g = document.createElement('canvas').getContext('2d');
        g.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        this.cw = g.measureText('M'.repeat(20)).width / 20 || 7.8;
      }
      return this.cw;
    }

    /** The identifier under the mouse, as { word, line }, ignoring the name line and comments. */
    wordAt(ev) {
      const ta = this.input, cs = getComputedStyle(ta), rect = ta.getBoundingClientRect();
      const x = ev.clientX - rect.left - parseFloat(cs.paddingLeft) + ta.scrollLeft;
      const y = ev.clientY - rect.top - parseFloat(cs.paddingTop) + ta.scrollTop;
      if (x < 0 || y < 0) return null;
      const row = Math.floor(y / this.lineHeight());
      const lines = this.value.split('\n');
      if (row < 1 || row >= lines.length) return null;
      const text = lines[row];
      // Visual column of each character, expanding tabs (tab-size 4).
      const vis = [];
      let v = 0;
      for (const ch of text) { vis.push(v); v += ch === '\t' ? 4 - (v % 4) : 1; }
      vis.push(v);
      const col = x / this.charWidth();
      const comment = text.search(/[;#]/);
      const re = /[A-Za-z_][A-Za-z0-9_]*/g;
      let m;
      while ((m = re.exec(text))) {
        if (comment >= 0 && m.index > comment) break;
        if (col >= vis[m.index] && col < vis[m.index + m[0].length]) return { word: m[0], line: row + 1, index: m.index };
      }
      return null;
    }

    /** `fn(ref)` runs when a tooltip link like "More in Reference" is clicked. */
    onHelpLink(fn) { this.linkListeners.push(fn); }

    onHover(ev) {
      const hit = this.helpProvider && this.wordAt(ev);
      const key = hit ? `${hit.line}:${hit.word}` : '';
      if (key === this.tipKey) return;
      if (!hit) {
        // Off the word: a short grace period lets the mouse travel onto the tooltip.
        this.tipKey = '';
        this.hideTipSoon();
        return;
      }
      this.hideTip();
      this.tipKey = key;
      const at = { x: ev.clientX, y: ev.clientY };
      this.tipTimer = setTimeout(() => {
        const html = this.helpProvider(hit.word, hit);
        if (!html) return;
        this.tip.innerHTML = html;
        this.tip.hidden = false;
        const w = this.tip.offsetWidth, h = this.tip.offsetHeight;
        this.tip.style.left = `${Math.max(8, Math.min(at.x + 12, innerWidth - w - 8))}px`;
        this.tip.style.top = `${at.y + 20 + h < innerHeight ? at.y + 20 : Math.max(8, at.y - h - 10)}px`;
      }, 350);
    }

    hideTip() {
      clearTimeout(this.tipTimer);
      this.tip.hidden = true;
      this.tipKey = '';
    }

    /** Close the tooltip shortly, unless the mouse moves onto it first. */
    hideTipSoon() {
      clearTimeout(this.tipTimer);
      if (this.tip.hidden) return;
      this.tipTimer = setTimeout(() => this.hideTip(), 400);
    }

    /**
     * Insert a block of lines where the cursor is, as one undoable step. It
     * replaces the cursor's line if that is blank (or `replaceable(line)`), goes
     * above the line when the cursor is before its code, and below it otherwise.
     * Lines 0..`below` (the name and header) stay on top: the block goes after them.
     * Returns where the block landed, as { from, to } offsets.
     */
    insertBlock(text, { replaceable = () => false, below = 0 } = {}) {
      const ta = this.input;
      ta.focus();
      const v = ta.value, lines = v.split('\n'), s = ta.selectionStart;
      const caretLine = v.slice(0, s).split('\n').length - 1;
      const n = Math.max(caretLine, below);
      const line = lines[n] || '';
      const lineStart = lines.slice(0, n).reduce((sum, l) => sum + l.length + 1, 0), lineEnd = lineStart + line.length;
      const beforeCode = n === caretLine && s <= lineStart + /^\s*/.exec(line)[0].length;
      let from;
      if (n > below && (!line.trim() || replaceable(line))) {
        ta.setSelectionRange(lineStart, lineEnd);
        from = lineStart;
        this.insertText(text);
      } else if (n > below && beforeCode) {
        ta.setSelectionRange(lineStart, lineStart);
        from = lineStart;
        this.insertText(`${text}\n`);
      } else {
        ta.setSelectionRange(lineEnd, lineEnd);
        from = lineEnd + 1;
        this.insertText(`\n${text}`);
      }
      return { from, to: from + text.length };
    }

    /** Select `from`..`to` (just a cursor when equal) and scroll it into view. */
    select(from, to = from) {
      this.input.focus();
      this.input.setSelectionRange(from, to);
      this.revealLine(this.input.value.slice(0, from).split('\n').length);
    }

    setErrors(lines) { this.errorLines = new Set(lines); this.renderGutter(); }

    setBreakpoints(lines) { this.breakLines = new Set(lines); this.renderGutter(); }

    /** Mark `line` (0 = none) as the CPU's next line ('exec') or the line that crashed ('fault'). */
    setExecLine(line, kind = 'exec') {
      if (line === this.execLine && kind === this.execKind) return;
      this.execLine = line;
      this.execKind = kind;
      this.renderMarks();
      this.renderGutter();
      if (line) this.revealLine(line);
    }

    /** Show how often each instruction line ran: `[[line, count], ...]`, or [] for none. Zero dims the line. */
    setCounts(counts) {
      const key = counts.join(';');
      if (key === this.countsKey) return;
      this.countsKey = key;
      this.counts = counts;
      this.renderMarks();
    }

    renderMarks() {
      const lh = this.lineHeight();
      const at = (n) => `style="top:${(n - 1) * lh}px"`;
      let behind = '', over = '';
      if (this.execLine) behind += `<div class="ce-band ${this.execKind}" ${at(this.execLine)}></div>`;
      for (const [n, c] of this.counts) {
        if (c) behind += `<div class="ce-count" ${at(n)}>×${formatCount(c)}</div>`;
        else over += `<div class="ce-band never" ${at(n)}></div>`;
      }
      this.marks.innerHTML = behind;
      this.cover.innerHTML = over;
    }

    lineHeight() { return parseFloat(getComputedStyle(this.input).lineHeight) || 18; }

    /** Scroll just enough to bring `n` into view, e.g. after a jump. */
    revealLine(n) {
      const ta = this.input;
      if (!ta.clientHeight) return; // editor tab hidden
      const lh = this.lineHeight();
      const pad = parseFloat(getComputedStyle(ta).paddingTop) || 0;
      const top = pad + (n - 1) * lh;
      if (top < ta.scrollTop || top + lh > ta.scrollTop + ta.clientHeight) {
        ta.scrollTop = Math.max(0, top - ta.clientHeight / 3);
        this.syncScroll();
      }
    }

    focus() { this.input.focus(); }

    goToLine(n) {
      const lines = this.value.split('\n');
      let pos = 0;
      for (let i = 0; i < n - 1 && i < lines.length; i++) pos += lines[i].length + 1;
      const end = pos + (lines[n - 1] || '').length;
      this.input.focus();
      this.input.setSelectionRange(pos, end);
      this.input.scrollTop = Math.max(0, (n - 5) * this.lineHeight());
      this.syncScroll();
    }

    /**
     * Type `text` over the selection as if from the keyboard. execCommand keeps
     * the browser's undo history (setRangeText would break Ctrl+Z); it fires
     * the input event itself.
     */
    insertText(text) {
      const ta = this.input;
      if (document.execCommand && document.execCommand('insertText', false, text)) return;
      ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input'));
    }

    /** Show, refresh or close the autocomplete popup for the word at the caret. */
    updateCompletions() {
      const ta = this.input;
      const r = ta.selectionStart === ta.selectionEnd && BB.assist ? BB.assist.completions(ta.value, ta.selectionStart) : null;
      if (!r) { this.closeCompletions(); return; }
      this.completion = { ...r, index: 0 };
      this.renderCompletions();
      // Place the popup just under the word, using the same column maths as the hover help.
      const cs = getComputedStyle(ta), rect = ta.getBoundingClientRect(), lh = this.lineHeight();
      const before = ta.value.slice(0, r.start), row = before.split('\n').length - 1;
      let col = 0;
      for (const ch of before.slice(before.lastIndexOf('\n') + 1)) col += ch === '\t' ? 4 - (col % 4) : 1;
      const x = rect.left + parseFloat(cs.paddingLeft) + col * this.charWidth() - ta.scrollLeft;
      const y = rect.top + parseFloat(cs.paddingTop) + (row + 1) * lh - ta.scrollTop;
      this.complete.hidden = false;
      const h = this.complete.offsetHeight, w = this.complete.offsetWidth;
      this.complete.style.left = `${Math.max(4, Math.min(x, innerWidth - w - 4))}px`;
      this.complete.style.top = `${y + h + 4 < innerHeight ? y + 2 : Math.max(4, y - lh - h - 2)}px`;
    }

    renderCompletions() {
      const c = this.completion;
      this.complete.innerHTML = c.items.map((it, i) =>
        `<div class="cc-item${i === c.index ? ' active' : ''}" data-i="${i}" role="option"><b>${esc(it.text)}</b><span>${esc(it.detail)}</span></div>`).join('') +
        '<div class="cc-help">↑ ↓ choose · Enter or Tab to use · Esc to close</div>';
    }

    closeCompletions() {
      this.completion = null;
      this.complete.hidden = true;
    }

    /** Replace the typed prefix with suggestion `i`, as one undoable step. */
    acceptCompletion(i) {
      const c = this.completion, ta = this.input;
      if (!c || !c.items[i]) return;
      this.closeCompletions();
      ta.setSelectionRange(c.start, c.start + c.prefix.length);
      this.quietInput = true; // don't reopen the popup for our own insert
      this.insertText(c.items[i].insert);
      this.quietInput = false;
    }

    onKey(e) {
      const ta = this.input;
      const c = this.completion;
      if (c) {
        // While suggestions are open, these keys drive the list instead of the text.
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          c.index = (c.index + (e.key === 'ArrowDown' ? 1 : c.items.length - 1)) % c.items.length;
          this.renderCompletions();
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); this.acceptCompletion(c.index); return; }
        if (e.key === 'Escape') { e.preventDefault(); this.closeCompletions(); return; }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        // Comment out (or back in) every line the selection touches.
        e.preventDefault();
        this.closeCompletions();
        const before = ta.value, r = BB.assist.toggleComments(before, ta.selectionStart, ta.selectionEnd);
        if (r.text === before) return;
        const oldEnd = r.to - (r.text.length - before.length);
        ta.setSelectionRange(r.from, oldEnd);
        this.quietInput = true;
        this.insertText(r.text.slice(r.from, r.to));
        this.quietInput = false;
        ta.setSelectionRange(r.from, r.to);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        this.insertText('    ');
      } else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
        // keep indentation
        const s = ta.selectionStart;
        const lineStart = ta.value.lastIndexOf('\n', s - 1) + 1;
        const indent = /^\s*/.exec(ta.value.slice(lineStart, s))[0];
        if (indent) {
          e.preventDefault();
          this.insertText('\n' + indent);
        }
      }
    }

    render() {
      const lines = this.value.split('\n');
      // Trailing newline keeps the <pre> height in sync with the textarea.
      this.hl.innerHTML = lines.map(highlightLine).join('\n') + '\n';
      this.lineCount = lines.length;
      this.renderGutter();
      this.syncScroll();
    }

    renderGutter() {
      let html = '';
      for (let i = 1; i <= this.lineCount; i++) {
        const cls = [this.errorLines.has(i) ? 'err' : '', this.execLine === i ? this.execKind : '',
          this.breakLines.has(i) ? 'bp' : ''].join(' ').trim();
        html += `<div data-n="${i}"${cls ? ` class="${cls}"` : ''}>${i}</div>`;
      }
      this.gutterLines.innerHTML = html;
      this.syncScroll();
    }

    /**
     * Move the coloured text, line numbers and marks by exactly the textarea's
     * scroll. Transforms, not scrollTop: when the textarea shows a horizontal
     * scrollbar (long lines on Windows), it can scroll further than the other
     * layers could, and they would drift up to a line out of step.
     */
    syncScroll() {
      const top = this.input.scrollTop, left = this.input.scrollLeft;
      this.hl.style.transform = `translate(${-left}px, ${-top}px)`;
      this.gutterLines.style.transform = `translateY(${-top}px)`;
      this.marks.style.transform = this.cover.style.transform = `translateY(${-top}px)`;
    }
  }

  BB.CodeEditor = CodeEditor;
})(globalThis.BB = globalThis.BB || {});
