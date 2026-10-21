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

  class CodeEditor {
    constructor(root) {
      root.classList.add('code-editor');
      root.innerHTML = `
        <div class="ce-gutter"></div>
        <div class="ce-body">
          <div class="ce-mark" hidden></div>
          <pre class="ce-hl" aria-hidden="true"></pre>
          <textarea class="ce-input" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off"></textarea>
        </div>`;
      this.gutter = root.querySelector('.ce-gutter');
      this.hl = root.querySelector('.ce-hl');
      this.input = root.querySelector('.ce-input');
      this.mark = root.querySelector('.ce-mark');
      this.errorLines = new Set();
      this.execLine = 0;
      this.execKind = 'exec';
      this.listeners = [];

      this.input.addEventListener('input', () => { this.render(); this.listeners.forEach((f) => f(this.value)); });
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

    setErrors(lines) { this.errorLines = new Set(lines); this.renderGutter(); }

    /** Mark `line` (0 = none) as the CPU's next line ('exec') or the line that crashed ('fault'). */
    setExecLine(line, kind = 'exec') {
      if (line === this.execLine && kind === this.execKind) return;
      this.execLine = line;
      this.execKind = kind;
      this.mark.hidden = !line;
      this.mark.className = `ce-mark ${kind}`;
      this.renderGutter();
      if (line) this.revealLine(line);
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

    onKey(e) {
      const ta = this.input;
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = ta.selectionStart, en = ta.selectionEnd;
        ta.setRangeText('    ', s, en, 'end');
        ta.dispatchEvent(new Event('input'));
      } else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
        // keep indentation
        const s = ta.selectionStart;
        const lineStart = ta.value.lastIndexOf('\n', s - 1) + 1;
        const indent = /^\s*/.exec(ta.value.slice(lineStart, s))[0];
        if (indent) {
          e.preventDefault();
          ta.setRangeText('\n' + indent, s, ta.selectionEnd, 'end');
          ta.dispatchEvent(new Event('input'));
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
        const cls = [this.errorLines.has(i) ? 'err' : '', this.execLine === i ? this.execKind : ''].join(' ').trim();
        html += `<div${cls ? ` class="${cls}"` : ''}>${i}</div>`;
      }
      this.gutter.innerHTML = html;
      this.syncScroll();
    }

    syncScroll() {
      this.hl.scrollTop = this.input.scrollTop;
      this.hl.scrollLeft = this.input.scrollLeft;
      this.gutter.scrollTop = this.input.scrollTop;
      if (this.execLine) this.mark.style.transform = `translateY(${(this.execLine - 1) * this.lineHeight() - this.input.scrollTop}px)`;
    }
  }

  BB.CodeEditor = CodeEditor;
})(globalThis.BB = globalThis.BB || {});
