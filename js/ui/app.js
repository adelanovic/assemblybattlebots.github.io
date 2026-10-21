/*
 * app.js — Wires the UI to the simulation.
 *
 * State model:
 *   entries[]  the roster: one per robot file { id, filename, source, draft, compiled }
 *              `source` is the applied code, `draft` is what's in the editor.
 *   world      the current match, built from the valid entries on Reset.
 *
 * The main loop (requestAnimationFrame) advances the world by a number of
 * ticks that depends on the speed setting, then redraws. DOM panels are
 * refreshed at ~10 Hz to keep things cheap.
 */
(function (BB) {
  'use strict';

  const C = BB.CONFIG;
  const STORAGE_KEY = 'battlebots.roster.v1';
  const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4, 8, 20, 60]; // multipliers of 60 ticks/second
  const DEFAULT_SPEED = 3;
  const MAX_STEPS_PER_FRAME = 200;
  const MODES = {
    ffa: { label: 'Free-for-all', size: 0 },
    '2v2': { label: 'Teams 2v2', size: 2 },
    '3v3': { label: 'Teams 3v3', size: 3 },
  };
  const TEAMS = ['A', 'B'];

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  class App {
    constructor() {
      this.entries = [];
      this.nextId = 1;
      this.world = null;
      this.running = false;
      this.speedIndex = DEFAULT_SPEED;
      this.acc = 0;
      this.lastFrameTime = null;
      this.selectedId = null;
      this.mode = 'ffa';
      this.lastPanelUpdate = 0;
      this.renderedLogKey = null;

      this.renderer = new BB.Renderer($('#arena'));
      this.fitArena();
      this.editor = new BB.CodeEditor($('#editor'));

      this.bindControls();
      this.buildReference();
      this.restore();
      this.resetMatch();
      requestAnimationFrame((timestamp) => this.frame(timestamp));
    }

    // ------------------------------------------------------------ roster

    compile(source) { return BB.assemble(source); }

    addEntry(filename, source, { select = true, draft, team } = {}) {
      // The editor's textarea reports LF line endings, so CRLF files would never
      // match it (no exec marker, false "Apply changes").
      const lf = (s) => String(s).replace(/\r\n?/g, '\n');
      source = lf(source);
      draft = draft == null ? undefined : lf(draft);
      const entry = { id: this.nextId++, filename, source, draft: draft ?? source, compiled: this.compile(source), team: null };
      this.entries.push(entry);
      entry.team = team !== undefined ? team : this.openSlot();
      if (select) this.select(entry.id);
      return entry;
    }

    entry(id) { return this.entries.find((e) => e.id === id); }
    get selected() { return this.entry(this.selectedId); }

    robotFor(entryId) {
      return this.world ? this.world.robots.find((r) => r.entryId === entryId) : null;
    }

    select(id) {
      this.selectedId = id;
      const e = this.selected;
      this.editor.value = e ? e.draft : '';
      $('#editor-pane').classList.toggle('empty', !e);
      this.showTab('editor');
      this.checkDraft();
      this.renderRoster();
      this.updateDebug();
    }

    duplicateEntry(id) {
      const e = this.entry(id);
      if (!e) return;
      const copy = this.addEntry(e.filename, e.source, { select: false, draft: e.draft });
      // keep the copy next to the original
      this.entries.splice(this.entries.indexOf(copy), 1);
      this.entries.splice(this.entries.indexOf(e) + 1, 0, copy);
      this.persist();
      this.resetMatch();
    }

    // ------------------------------------------------------------ teams

    get teamSize() { return MODES[this.mode].size; }

    /** Team for a newly added robot: the first team with a free slot, else the bench. */
    openSlot() {
      if (!this.teamSize) return null;
      for (const t of TEAMS) {
        if (this.entries.filter((e) => e.team === t).length < this.teamSize) return t;
      }
      return null;
    }

    setTeam(id, team) {
      const e = this.entry(id);
      if (!e || e.team === team) return;
      e.team = team;
      this.persist();
      this.resetMatch();
    }

    /** Fill both teams from the roster in order, keeping valid picks when they already fit. */
    autoAssignTeams() {
      const n = this.teamSize;
      if (!n) return;
      const valid = this.entries.filter((e) => !e.compiled.errors.length);
      const fits = TEAMS.every((t) => valid.filter((e) => e.team === t).length === n);
      if (fits) return;
      for (const e of this.entries) e.team = null;
      valid.slice(0, 2 * n).forEach((e, i) => { e.team = i < n ? 'A' : 'B'; });
    }

    /** Human-readable reason the team match can't start, or null. */
    teamProblem() {
      const n = this.teamSize;
      if (!n) return null;
      const count = (t) => this.entries.filter((e) => e.team === t && !e.compiled.errors.length).length;
      const [a, b] = TEAMS.map(count);
      if (a === n && b === n) return null;
      return `${MODES[this.mode].label} needs ${n} working robots on each team (A has ${a}, B has ${b}). ` +
        'Use the A / B / Bench buttons on the robot cards, or ⧉ to duplicate a robot.';
    }

    setMode(mode) {
      this.mode = MODES[mode] ? mode : 'ffa';
      $('#mode-type').value = this.mode;
      this.autoAssignTeams();
      this.persist();
      this.resetMatch();
    }

    removeEntry(id) {
      const e = this.entry(id);
      if (!e) return;
      if (!confirm(`Remove "${e.compiled.name}" from the roster? Save it first if you want to keep the code.`)) return;
      this.entries = this.entries.filter((x) => x.id !== id);
      if (this.selectedId === id) this.select(this.entries.length ? this.entries[0].id : null);
      this.persist();
      this.resetMatch();
    }

    // ------------------------------------------------------------ match

    resetMatch() {
      this.running = false;
      this.acc = 0;
      this.lastFrameTime = null;
      const seed = parseInt($('#seed').value, 10) || 1;
      const valid = this.entries.filter((e) => !e.compiled.errors.length);
      const playing = this.teamSize ? valid.filter((e) => e.team) : valid;
      for (const e of this.entries) e.runningSource = playing.includes(e) ? e.source : null;
      this.world = new BB.World({
        entries: playing.map((e) => ({
          id: e.id, name: e.compiled.name, program: e.compiled.program,
          appearance: e.compiled.appearance,
          team: this.teamSize ? TEAMS.indexOf(e.team) : undefined,
        })),
        seed,
        arena: $('#arena-type').value,
      });
      this.renderer.clearEffects();
      const skipped = this.entries.length - valid.length;
      if (skipped) this.world.addLog(`${skipped} robot(s) skipped because of syntax errors.`, 'fault');
      const problem = this.teamProblem();
      if (problem) this.world.addLog(problem, 'fault');
      this.renderRoster();
      this.updatePanels(true);
    }

    toggleRun() {
      if (this.world.over) this.resetMatch();
      if (!this.world.robots.length) { this.flash('Add at least one robot first.'); return; }
      const problem = !this.running && this.teamProblem();
      if (problem) { this.flash(problem); return; }
      this.running = !this.running;
      this.lastFrameTime = null;
      this.updatePanels(true);
    }

    stepOnce() {
      if (this.world.over) return;
      if (!this.world.robots.length) { this.flash('Add at least one robot first.'); return; }
      const problem = this.teamProblem();
      if (problem) { this.flash(problem); return; }
      this.running = false;
      this.world.step();
      this.updatePanels(true);
    }

    frame(now = performance.now()) {
      const elapsed = this.lastFrameTime === null ? 0 : Math.max(0, Math.min(now - this.lastFrameTime, 100));
      this.lastFrameTime = now;
      if (this.running && this.world && !this.world.over) {
        this.acc += elapsed * 60 / 1000 * SPEEDS[this.speedIndex];
        let steps = Math.min(Math.floor(this.acc + 1e-9), MAX_STEPS_PER_FRAME);
        // Discard excess catch-up work after a stall, retaining only a fraction.
        this.acc = Math.max(0, this.acc - Math.floor(this.acc + 1e-9));
        while (steps-- > 0 && !this.world.over) this.world.step();
        if (this.world.over) this.running = false;
      }
      if (this.world) {
        this.renderer.addEvents(this.world.drainEvents());
        this.renderer.draw(this.world, this.selectedId);
      }
      if (performance.now() - this.lastPanelUpdate > 100) this.updatePanels(false);
      requestAnimationFrame((timestamp) => this.frame(timestamp));
    }

    /** Keep the canvas as large as its container allows, at 4:3. */
    fitArena() {
      const wrap = $('.arena-wrap');
      const fit = () => {
        const w = wrap.clientWidth, h = wrap.clientHeight;
        const cssW = Math.max(200, Math.floor(Math.min(w, h * C.ARENA_W / C.ARENA_H)));
        if (cssW !== this.arenaCssWidth) {
          this.arenaCssWidth = cssW;
          this.renderer.resize(cssW);
        }
      };
      if (window.ResizeObserver) new ResizeObserver(fit).observe(wrap);
      window.addEventListener('resize', fit);
      fit();
    }

    // ------------------------------------------------------------ editor

    checkDraft() {
      const e = this.selected;
      const box = $('#errors');
      if (!e) { box.innerHTML = ''; this.editor.setErrors([]); return; }
      const res = this.compile(e.draft);
      this.editor.setErrors(res.errors.map((x) => x.line));
      const items = [
        ...res.errors.map((x) => ({ ...x, cls: 'error' })),
        ...res.warnings.map((x) => ({ ...x, cls: 'warning' })),
      ];
      box.innerHTML = items.length
        ? items.map((x) => `<li class="${x.cls}" data-line="${x.line}"><b>Line ${x.line}</b> ${esc(x.message)}</li>`).join('')
        : `<li class="ok">✓ Assembles cleanly: ${res.program.length} instructions.</li>`;
      const dirty = e.draft !== e.source;
      $('#btn-apply').classList.toggle('dirty', dirty);
      $('#btn-apply').textContent = dirty ? 'Apply changes ●' : 'Apply';
      $('#editor-name').textContent = res.name;
      $('#editor-file').textContent = e.filename;
    }

    applyDraft() {
      const e = this.selected;
      if (!e) return;
      const compiled = this.compile(e.draft);
      if (compiled.errors.length) {
        this.checkDraft();
        this.persist();
        this.flash('Not applied: fix the syntax errors first. The robot keeps its previously applied code.');
        return;
      }
      e.source = e.draft;
      e.compiled = compiled;
      this.persist();
      this.checkDraft();
      const robot = this.robotFor(e.id);
      if (this.world.tick === 0 || this.world.over) {
        this.resetMatch();
        this.flash('Applied. The arena has been reset.');
      } else if (robot) {
        // Hot-swap: fresh CPU, same body.
        robot.vm = new BB.VM(e.compiled.program, this.world.makeIO(robot));
        this.world.renameRobot(robot, e.compiled.name);
        robot.appearance = { ...e.compiled.appearance };
        robot.faultReported = false;
        e.runningSource = e.source;
        this.world.addLog(`${robot.name} reloaded its program.`);
        this.flash('Applied. The robot is running its new code.');
      } else {
        this.flash('Applied. Press Reset to add this robot to the arena.');
      }
      this.renderRoster();
    }

    saveFile() {
      const e = this.selected;
      if (!e) return;
      const name = e.filename || `${this.compile(e.draft).name.replace(/[^\w-]+/g, '_').toLowerCase()}.asm`;
      const blob = new Blob([e.draft], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    loadFiles(files) {
      const list = [...files].filter((f) => /\.(asm|txt)$/i.test(f.name) || !f.type || f.type.startsWith('text'));
      if (!list.length) return;
      let pending = list.length;
      let last = null;
      for (const f of list) {
        const reader = new FileReader();
        reader.onload = () => {
          last = this.addEntry(f.name, String(reader.result), { select: false });
          if (--pending === 0) this.afterLoad(last, list.length);
        };
        reader.onerror = () => { this.flash(`Could not read ${f.name}`); if (--pending === 0 && last) this.afterLoad(last, list.length); };
        reader.readAsText(f);
      }
    }

    afterLoad(last, count) {
      this.persist();
      this.select(last.id);
      this.resetMatch();
      this.flash(`Loaded ${count} file${count > 1 ? 's' : ''}.`);
    }

    // ------------------------------------------------------------ panels

    updatePanels(force) {
      this.lastPanelUpdate = performance.now();
      const w = this.world;
      $('#tick').textContent = w ? w.tick : 0;
      const runBtn = $('#btn-run');
      runBtn.textContent = this.running ? '❚❚ Pause' : (w && w.over ? '▶ Rematch' : '▶ Start');
      runBtn.classList.toggle('active', this.running);
      let status = 'Paused';
      if (w && w.over) {
        if (w.teamMode) status = w.winnerTeam === null ? 'Draw' : `🏆 Team ${TEAMS[w.winnerTeam]} wins`;
        else status = w.winner ? `🏆 ${w.winner.name} wins` : 'Draw';
      }
      else if (this.running) status = 'Running';
      else if (w && w.tick === 0) status = w.robots.length ? 'Ready' : 'No robots';
      $('#status').textContent = status;
      this.updateRosterLive();
      this.updateDebug();
      this.updateLog(force);
    }

    renderRoster() {
      const box = $('#roster');
      if (!this.entries.length) {
        box.innerHTML = '<div class="roster-empty">No robots yet. Load .asm files, add an example, or create a new robot.</div>';
        return;
      }
      const teams = this.teamSize > 0;
      const picker = (e) => !teams ? '' : `
          <div class="team-pick">${[...TEAMS, null].map((t) => `
            <button data-team="${t || ''}" class="${e.team === t ? 'on' : ''} ${t ? `team-${t.toLowerCase()}` : ''}"
              title="${t ? `Play for team ${t}` : 'Sit this match out'}">${t || 'Bench'}</button>`).join('')}
          </div>`;
      box.innerHTML = this.entries.map((e) => `
        <div class="card ${e.id === this.selectedId ? 'selected' : ''} ${teams && e.team ? `team-${e.team.toLowerCase()}` : ''}" data-id="${e.id}">
          <div class="card-head">
            <span class="swatch"></span>
            <span class="card-name">${esc(e.compiled.name)}</span>
            <button class="icon" data-act="dup" title="Duplicate robot">⧉</button>
            <button class="icon danger" data-act="remove" title="Remove robot">✕</button>
          </div>
          <div class="hp"><div class="hp-fill"></div></div>
          <div class="card-status"></div>${picker(e)}
        </div>`).join('');
      this.updateRosterLive();
    }

    updateRosterLive() {
      for (const card of document.querySelectorAll('#roster .card')) {
        const e = this.entry(Number(card.dataset.id));
        if (!e) continue;
        const r = this.robotFor(e.id);
        const fill = card.querySelector('.hp-fill');
        const status = card.querySelector('.card-status');
        const swatch = card.querySelector('.swatch');
        let text, cls = '';
        if (e.compiled.errors.length) {
          text = `✗ ${e.compiled.errors.length} syntax error${e.compiled.errors.length > 1 ? 's' : ''}`; cls = 'bad';
        } else if (!r && this.teamSize && !e.team) {
          text = 'On the bench'; cls = 'muted';
        } else if (!r) {
          text = 'Not in arena (Reset)'; cls = 'muted';
        } else if (!r.alive) {
          text = 'Destroyed'; cls = 'muted';
        } else if (r.vm.fault) {
          text = '⚠ CPU fault'; cls = 'bad';
        } else if (r.vm.halted) {
          text = 'Halted'; cls = 'muted';
        } else {
          text = `HP ${Math.ceil(r.health)} · shots ${r.stats.shots} · hits ${r.stats.hits}`;
        }
        swatch.style.background = r ? r.color : '#444';
        fill.style.width = `${r ? (r.health / C.MAX_HEALTH) * 100 : 0}%`;
        fill.style.background = r ? r.color : '#444';
        status.textContent = text;
        status.className = `card-status ${cls}`;
        card.classList.toggle('dead', !!r && !r.alive);
      }
    }

    updateDebug() {
      const box = $('#debug');
      const e = this.selected;
      const r = e && this.robotFor(e.id);
      if (!r) {
        box.innerHTML = '<div class="muted">Select a robot that is in the arena to inspect its CPU.</div>';
        this.editor.setExecLine(0);
        return;
      }
      const vm = r.vm;
      const sensors = ['X', 'Y', 'HEADING', 'SPEED', 'HEALTH', 'COOLDOWN', 'TURRET', 'FRONT', 'SCAN_DIST', 'SCAN_ANGLE', 'SCAN_RANGE', 'THREAT_DIST', 'THREAT_ANGLE'];
      const regs = [...vm.regs].map((v, i) => `<span><i>R${i}</i>${v}</span>`).join('');
      const sens = sensors.map((s) => `<span><i>${s}</i>${this.world.sense(r, BB.ISA.SENSOR_MAP[s].id)}</span>`).join('');
      const state = vm.fault ? `<span class="bad">FAULT — ${esc(vm.fault)}</span>`
        : !r.alive ? 'destroyed' : vm.halted ? 'halted' : `next: line ${vm.currentLine}`;
      box.innerHTML = `
        <div class="dbg-line"><b>${esc(r.name)}</b> · ${state} · ${r.cyclesLastTick}/${C.CYCLES_PER_TICK} cycles last tick · stack ${vm.stack.length}/${C.STACK_SIZE} · cmp ${vm.cmp}</div>
        <div class="kv">${regs}</div>
        <div class="kv sensors">${sens}</div>`;
      // Only point at a line if the editor shows the code the robot is running.
      // A fault marks the crashing line; otherwise, while paused, the next line.
      let line = 0, kind = 'exec';
      if (e.runningSource === this.editor.value) {
        if (vm.fault) { line = vm.faultLine; kind = 'fault'; }
        else if (!this.running && !vm.halted && r.alive) line = vm.currentLine;
      }
      this.editor.setExecLine(line, kind);
    }

    updateLog(force) {
      const log = this.world ? this.world.log : [];
      const key = log.length ? `${log.length}:${log[log.length - 1].tick}:${log[log.length - 1].text}` : '';
      if (!force && key === this.renderedLogKey) return;
      this.renderedLogKey = key;
      const box = $('#log');
      box.innerHTML = log.map((l) => `<li class="${l.kind}"><span class="t">${l.tick}</span>${esc(l.text)}</li>`).join('');
      box.scrollTop = box.scrollHeight;
    }

    buildReference() {
      const { INSTRUCTIONS, SENSORS, LANGUAGE_NOTES } = BB.ISA;
      let html = '<h3>Language basics</h3><ul class="notes">' +
        LANGUAGE_NOTES.map((n) => `<li>${esc(n).replace(/`([^`]+)`/g, '<code>$1</code>')}</li>`).join('') + '</ul>';
      html += `<h3>Operands</h3><table><tr><td><code>dst</code></td><td>register <code>R0</code>..<code>R7</code> or memory <code>[n]</code>, <code>[Rx]</code>, <code>[Rx+n]</code></td></tr>
        <tr><td><code>src</code></td><td>anything <code>dst</code> accepts, plus a number or constant</td></tr>
        <tr><td><code>target</code></td><td>a label</td></tr><tr><td><code>sensor</code></td><td>a sensor name (below)</td></tr></table>`;
      let group = null;
      for (const ins of INSTRUCTIONS) {
        if (ins.group !== group) {
          if (group) html += '</table>';
          group = ins.group;
          html += `<h3>${group}</h3><table class="ref">`;
        }
        const form = [ins.op, ins.args.join(', ')].filter(Boolean).join(' ');
        html += `<tr><td><code>${esc(form)}</code>${ins.cost > 1 ? `<span class="cost">${ins.cost} cycles</span>` : ''}</td>
          <td>${esc(ins.summary)}<div class="ex">${esc(ins.example)}</div></td></tr>`;
      }
      html += '</table><h3>Sensors: <code>GET dst, NAME</code></h3><table class="ref">' +
        SENSORS.map((s) => `<tr><td><code>${s.name}</code></td><td>${esc(s.desc)}</td></tr>`).join('') + '</table>';
      html += '<h3>Appearance header (cosmetic)</h3><table class="ref">' +
        Object.entries(BB.ISA.APPEARANCE).map(([key, spec]) => `<tr><td><code>.${key} preset</code></td><td>${spec.choices.join(', ')}. Default: ${spec.default}.</td></tr>`).join('') +
        '</table><p>Put these optional directives below the name, before labels, constants or instructions. Each may appear once. They change appearance only: collision size, movement, bullet origin and damage stay the same. Twin turrets still fire one shot.</p>';
      html += '<h3>Arena rules</h3><table class="ref">' + [
        ['Arena', `${C.ARENA_W} × ${C.ARENA_H}, robot radius ${C.ROBOT_RADIUS}. Layout: Classic, Open, or Random (mirrored obstacles and mud generated from the seed). Don't hard-code obstacle positions; use FRONT and SCAN.`],
        ['Mud', `Brown patches. While your center is in mud, speed is capped at ${C.MUD_MAX_SPEED} either way; GET MUD reads 1. Bullets, SCAN and RADAR pass over it. Open has none.`],
        ['Budget', `${C.CYCLES_PER_TICK} cycles per robot per tick`],
        ['Movement', `speed ${C.MAX_REVERSE}..${C.MAX_SPEED}, acceleration ${C.ACCELERATION}/tick, body turns ${C.BODY_TURN_RATE}°/tick, turret ${C.TURRET_TURN_RATE}°/tick`],
        ['Weapons', `bullet speed ${C.BULLET_SPEED}, damage ${C.BULLET_DAMAGE}, cooldown ${C.FIRE_COOLDOWN} ticks`],
        ['Collisions', 'Hitting a wall or obstacle at speed ≥ 2 deals speed/2 damage. Ramming another robot deals 1 damage to both.'],
        ['Sensors', `SCAN cone up to ${C.SCAN_MAX_WIDTH}°, blocked by obstacles. Narrow cones reach farther: range ${C.SCAN_RANGE_FACTOR} / √width (${BB.World.scanRange(C.SCAN_MAX_WIDTH)} at ${C.SCAN_MAX_WIDTH}°, ${BB.World.scanRange(16)} at 16°). RADAR range ${C.RADAR_RANGE}.`],
        ['Victory', `Last robot standing. After ${C.MAX_TICKS} ticks, highest health wins.`],
        ['Teams', 'In 2v2 / 3v3, teammates are invisible to SCAN and RADAR, can\'t hurt each other, and don\'t count in ENEMIES (use ALLIES). Team B spawns as the mirror image of team A. Last team standing wins; at the time limit, highest total health.'],
      ].map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('') + '</table>';
      $('#reference').innerHTML = html;
    }

    showTab(name) {
      for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === name);
      for (const p of document.querySelectorAll('.tab-panel')) p.hidden = p.id !== `tab-${name}`;
    }

    flash(msg) {
      const el = $('#flash');
      el.textContent = msg;
      el.classList.add('show');
      clearTimeout(this.flashTimer);
      this.flashTimer = setTimeout(() => el.classList.remove('show'), 3500);
    }

    // ------------------------------------------------------------ persistence

    persist() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          seed: $('#seed').value,
          arena: $('#arena-type').value,
          mode: this.mode,
          entries: this.entries.map((e) => ({ filename: e.filename, source: e.source, draft: e.draft, team: e.team })),
        }));
      } catch (_) { /* storage unavailable: nothing to do */ }
    }

    restore() {
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (_) { saved = null; }
      if (saved && Array.isArray(saved.entries) && saved.entries.length) {
        if (saved.seed) $('#seed').value = saved.seed;
        if (BB.World.ARENAS[saved.arena]) $('#arena-type').value = saved.arena;
        if (MODES[saved.mode]) this.mode = saved.mode;
        $('#mode-type').value = this.mode;
        for (const e of saved.entries) {
          const team = TEAMS.includes(e.team) ? e.team : null;
          this.addEntry(e.filename, e.source, { select: false, draft: e.draft, team });
        }
      } else {
        for (const ex of BB.EXAMPLES) this.addEntry(ex.file, ex.source, { select: false });
      }
      this.select(this.entries.length ? this.entries[0].id : null);
    }

    // ------------------------------------------------------------ wiring

    bindControls() {
      $('#btn-run').onclick = () => this.toggleRun();
      $('#btn-step').onclick = () => this.stepOnce();
      $('#btn-reset').onclick = () => this.resetMatch();
      $('#btn-dice').onclick = () => { $('#seed').value = 1 + Math.floor(Math.random() * 99999); this.persist(); this.resetMatch(); };
      $('#seed').onchange = () => { this.persist(); this.resetMatch(); };
      const arenaSel = $('#arena-type');
      arenaSel.innerHTML = Object.entries(BB.World.ARENAS)
        .map(([key, a]) => `<option value="${key}" title="${esc(a.desc)}">${esc(a.label)}</option>`).join('');
      arenaSel.onchange = () => { this.persist(); this.resetMatch(); };
      const modeSel = $('#mode-type');
      modeSel.innerHTML = Object.entries(MODES).map(([key, m]) => `<option value="${key}">${esc(m.label)}</option>`).join('');
      modeSel.onchange = () => this.setMode(modeSel.value);

      const speed = $('#speed');
      speed.max = SPEEDS.length - 1;
      speed.value = this.speedIndex;
      const showSpeed = () => {
        const s = SPEEDS[this.speedIndex];
        $('#speed-label').textContent = `${s}× · ${Math.round(s * 60)}/s`;
        speed.title = `${s}× speed, ${Math.round(s * 60)} ticks per second`;
      };
      speed.oninput = () => { this.speedIndex = Number(speed.value); showSpeed(); };
      showSpeed();

      $('#show-scans').onchange = (ev) => { this.renderer.showScans = ev.target.checked; };

      $('#btn-new').onclick = () => { this.addEntry('newbot.asm', BB.NEW_ROBOT_TEMPLATE); this.persist(); this.resetMatch(); this.editor.focus(); };
      $('#btn-load').onclick = () => $('#file-input').click();
      $('#file-input').onchange = (ev) => { this.loadFiles(ev.target.files); ev.target.value = ''; };

      const exSel = $('#example-select');
      exSel.innerHTML = '<option value="">+ Add example…</option>' +
        BB.EXAMPLES.map((ex, i) => `<option value="${i}">${esc(BB.assemble(ex.source).name)}: ${esc(ex.blurb)}</option>`).join('');
      exSel.onchange = () => {
        const ex = BB.EXAMPLES[Number(exSel.value)];
        exSel.value = '';
        if (!ex) return;
        this.addEntry(ex.file, ex.source);
        this.persist();
        this.resetMatch();
      };

      $('#roster').addEventListener('click', (ev) => {
        const card = ev.target.closest('.card');
        if (!card) return;
        const id = Number(card.dataset.id);
        if (ev.target.closest('[data-act="remove"]')) { ev.stopPropagation(); this.removeEntry(id); return; }
        if (ev.target.closest('[data-act="dup"]')) { ev.stopPropagation(); this.duplicateEntry(id); return; }
        const pick = ev.target.closest('[data-team]');
        if (pick) { ev.stopPropagation(); this.setTeam(id, pick.dataset.team || null); return; }
        this.select(id);
      });

      let timer = null;
      this.editor.onChange((value) => {
        const e = this.selected;
        if (!e) return;
        e.draft = value;
        clearTimeout(timer);
        timer = setTimeout(() => { this.checkDraft(); this.persist(); }, 250);
      });
      $('#btn-apply').onclick = () => this.applyDraft();
      $('#btn-save').onclick = () => this.saveFile();
      $('#btn-revert').onclick = () => {
        const e = this.selected;
        if (!e || e.draft === e.source) return;
        e.draft = e.source;
        this.editor.value = e.draft;
        this.checkDraft();
        this.persist();
      };
      $('#errors').addEventListener('click', (ev) => {
        const li = ev.target.closest('li[data-line]');
        if (li) this.editor.goToLine(Number(li.dataset.line));
      });

      for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => this.showTab(b.dataset.tab);

      document.addEventListener('keydown', (ev) => {
        // A focused button handles Space/Enter natively, so the shortcuts would fire twice.
        const inField = /^(TEXTAREA|INPUT|SELECT|BUTTON|SUMMARY)$/.test(document.activeElement && document.activeElement.tagName);
        if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); this.applyDraft(); }
        else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); this.saveFile(); }
        else if (!inField && ev.key === ' ') { ev.preventDefault(); this.toggleRun(); }
        else if (!inField && ev.key === '.') { this.stepOnce(); }
        else if (!inField && ev.key.toLowerCase() === 'r') { this.resetMatch(); }
      });

      // Mouse clicks shouldn't leave buttons focused, so Space keeps meaning start/pause.
      document.addEventListener('click', (ev) => {
        const b = ev.target.closest('button');
        if (b && ev.detail > 0) b.blur();
      });

      // Drag & drop .asm files anywhere on the page.
      document.addEventListener('dragover', (ev) => { ev.preventDefault(); document.body.classList.add('dropping'); });
      document.addEventListener('dragleave', (ev) => { if (!ev.relatedTarget) document.body.classList.remove('dropping'); });
      document.addEventListener('drop', (ev) => {
        ev.preventDefault();
        document.body.classList.remove('dropping');
        if (ev.dataTransfer && ev.dataTransfer.files.length) this.loadFiles(ev.dataTransfer.files);
      });
    }
  }

  window.addEventListener('DOMContentLoaded', () => { BB.app = new App(); });
})(globalThis.BB = globalThis.BB || {});
