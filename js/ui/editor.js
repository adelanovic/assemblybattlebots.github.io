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
      // Hover help: `helpProvider(word)` returns tooltip HTML or null.
      this.helpProvider = null;
      this.tip = document.createElement('div');
      this.tip.className = 'ce-tip';
      this.tip.hidden = true;
      document.body.appendChild(this.tip);
      this.tipKey = '';
      this.input.addEventListener('mousemove', (ev) => this.onHover(ev));
      for (const type of ['mouseleave', 'mousedown', 'keydown', 'scroll']) this.input.addEventListener(type, () => this.hideTip());

      this.input.addEventListener('input', () => { this.render(); this.listeners.forEach((f) => f(this.value)); });
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
        if (col >= vis[m.index] && col < vis[m.index + m[0].length]) return { word: m[0], line: row + 1 };
      }
      return null;
    }

    onHover(ev) {
      const hit = this.helpProvider && this.wordAt(ev);
      const key = hit ? `${hit.line}:${hit.word}` : '';
      if (key === this.tipKey) return;
      this.hideTip();
      this.tipKey = key;
      if (!hit) return;
      const at = { x: ev.clientX, y: ev.clientY };
      this.tipTimer = setTimeout(() => {
        const html = this.helpProvider(hit.word);
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

    onKey(e) {
      const ta = this.input;
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
