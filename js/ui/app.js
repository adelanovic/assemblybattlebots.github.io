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

  const MISSION_KEY = 'battlebots.missions.v1';
  const WELCOME_KEY = 'battlebots.welcomed';
  const LAYOUT_KEY = 'battlebots.layout.v1';

  /** Registers (sorted) and sensors (in order of first use) a program refers to. */
  function usedByProgram(program) {
    const regs = new Set(), sensors = [];
    for (const ins of program) {
      for (const a of ins.args) if ((a.k === 'reg' || a.k === 'mem') && a.r >= 0) regs.add(a.r);
      if (ins.op === 'GET') {
        const name = BB.ISA.SENSORS[ins.args[1].v].name;
        if (!sensors.includes(name)) sensors.push(name);
      }
    }
    return { regs: [...regs].sort((x, y) => x - y), sensors };
  }

  /**
   * Where 1-based `lines` of `before` end up in `after`. Text is compared from
   * both ends: lines above the edited block keep their number, lines below it
   * shift by the change in length, and a line inside the edited block keeps its
   * number while the new block still reaches it (typing on a line keeps its mark).
   */
  function shiftLines(before, after, lines) {
    const a = before.split('\n'), b = after.split('\n');
    let top = 0;
    while (top < a.length && top < b.length && a[top] === b[top]) top++;
    let bottom = 0;
    while (bottom < a.length - top && bottom < b.length - top && a[a.length - 1 - bottom] === b[b.length - 1 - bottom]) bottom++;
    const out = [];
    for (const n of lines) {
      if (n - 1 < top) out.push(n);
      else if (n - 1 >= a.length - bottom) out.push(n + b.length - a.length);
      else if (n - 1 < b.length - bottom) out.push(n);
    }
    return out;
  }

  /** True if two assembled programs run the same instructions (line numbers aside). */
  function sameInstructions(a, b) {
    return a.length === b.length &&
      a.every((ins, i) => ins.op === b[i].op && JSON.stringify(ins.args) === JSON.stringify(b[i].args));
  }

  /** "?" opens the shortcuts list. Some keyboards report Shift+/ as "/" with Shift held. */
  const isHelpKey = (ev) => ev.key === '?' || (ev.key === '/' && ev.shiftKey && !ev.ctrlKey && !ev.metaKey);

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
      this.showCounts = false;  // editor shows how often each line ran
      this.simple = true;       // Simple view: plain-language help, smaller inspector
      this.mission = null;      // the mission being played (from BB.MISSIONS), or null
      this.missionEntry = null; // its code, shaped like a roster entry but not in the roster
      this.missionState = { done: [], code: {}, fails: {} };

      this.renderer = new BB.Renderer($('#arena'));
      this.fitArena();
      this.editor = new BB.CodeEditor($('#editor'));
      this.editor.setHelp((word, at) => this.helpFor(word, at));
      this.editor.onHelpLink((ref) => this.openReference(ref));

      this.bindControls();
      this.restore();
      this.buildReference(); // after restore: it depends on the saved Simple view setting
      this.renderMissions();
      this.resetMatch();
      let seen = false;
      try { seen = !!localStorage.getItem(WELCOME_KEY); } catch (_) { seen = true; } // no storage: don't nag every visit
      $('#welcome').hidden = seen;
      if (!seen) $('#welcome-mission').focus(); // Enter starts the first mission
      requestAnimationFrame((timestamp) => this.frame(timestamp));
    }

    // ------------------------------------------------------------ roster

    compile(source) { return BB.assemble(source); }

    /** A roster-shaped entry, not yet added anywhere. */
    makeEntry(filename, source, { draft, breakpoints, id = this.nextId++ } = {}) {
      // The editor's textarea reports LF line endings, so CRLF files would never
      // match it (no exec marker, false "Apply changes").
      const lf = (s) => String(s).replace(/\r\n?/g, '\n');
      source = lf(source);
      draft = draft == null ? undefined : lf(draft);
      const entry = { id, filename, source, draft: draft ?? source, compiled: this.compile(source), team: null };
      // Source lines to pause before; saved with the roster.
      entry.breakpoints = new Set(Array.isArray(breakpoints) ? breakpoints.filter(Number.isInteger) : []);
      return entry;
    }

    addEntry(filename, source, { select = true, draft, team, breakpoints } = {}) {
      const entry = this.makeEntry(filename, source, { draft, breakpoints });
      this.entries.push(entry);
      entry.team = team !== undefined ? team : this.openSlot();
      if (select) this.select(entry.id);
      return entry;
    }

    entry(id) {
      if (this.missionEntry && id === this.missionEntry.id) return this.missionEntry;
      return this.entries.find((e) => e.id === id);
    }
    get selected() { return this.entry(this.selectedId); }

    robotFor(entryId) {
      return this.world ? this.world.robots.find((r) => r.entryId === entryId) : null;
    }

    select(id) {
      // Picking a roster robot leaves the mission and brings the roster back to the arena.
      const leaving = this.mission && id !== BB.MISSION_ENTRY_ID;
      if (leaving) this.exitMission();
      this.selectedId = id;
      const e = this.selected;
      this.editor.value = e ? e.draft : '';
      this.editor.setBreakpoints(e ? e.breakpoints : []);
      $('#editor-pane').classList.toggle('empty', !e);
      this.showTab('editor');
      this.checkDraft();
      this.renderRoster();
      this.updateDebug();
      if (leaving) this.resetMatch();
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
      if (!n || this.mission) return null;
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
      this.missionReported = false;
      if (this.mission) { this.resetMission(); return; }
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

    /** Mission arena: only the mission's code and its dummies; roster robots sit out. */
    resetMission() {
      const e = this.missionEntry;
      const ok = !e.compiled.errors.length;
      for (const x of this.entries) x.runningSource = null;
      e.runningSource = ok ? e.source : null;
      // A fresh seed per attempt, so missions like "Mission control" can't be solved by memorising numbers.
      this.world = ok ? BB.buildMission(this.mission, e.compiled, 1 + Math.floor(Math.random() * 1e6)) : new BB.World({ entries: [] });
      if (!ok) {
        this.world.log = [];
        this.world.addLog('Fix the errors in your code (listed under the editor), then press ▶ Start.', 'fault');
      }
      this.renderer.clearEffects();
      this.renderRoster();
      this.updatePanels(true);
    }

    /** Why the arena has no robots, worded as what to do next. */
    emptyArenaReason() {
      if (this.mission || this.entries.some((e) => e.compiled.errors.length)) {
        return 'Fix the syntax errors in your code first (they are listed under the editor), then press ▶ Start.';
      }
      return 'Add at least one robot first.';
    }

    /** Once per mission run: record a pass, tell the player, update the mission panels. */
    checkMissionResult() {
      const m = this.world.mission;
      if (!m || !m.result || this.missionReported) return;
      this.missionReported = true;
      this.running = false;
      if (m.result.ok && !this.missionState.done.includes(m.def.id)) this.missionState.done.push(m.def.id);
      // Failed attempts unlock more help in the mission bar (a bigger hint, then a working answer).
      if (!m.result.ok) this.missionState.fails[m.def.id] = (this.missionState.fails[m.def.id] || 0) + 1;
      this.persist();
      this.flash(m.result.ok ? `Mission complete! ${m.result.text}` : m.result.text);
      this.renderMissionBar();
      this.renderMissions();
    }

    /**
     * Start and Step use the code that is in the editor, so a changed program
     * never runs its old version by surprise. Returns false (with a message)
     * when the editor's code has syntax errors, so nothing runs.
     */
    applyPendingEdits() {
      const e = this.selected;
      if (!e || e.draft === e.source) return true;
      if (this.compile(e.draft).errors.length) {
        this.checkDraft();
        this.flash('Your code has errors (listed under the editor). Fix them, or press Undo changes, then try again.');
        return false;
      }
      this.applyDraft();
      return true;
    }

    toggleRun() {
      if (!this.running && !this.applyPendingEdits()) return;
      if (this.world.over) this.resetMatch();
      if (!this.world.robots.length) {
        this.flash(this.emptyArenaReason());
        return;
      }
      const problem = !this.running && this.teamProblem();
      if (problem) { this.flash(problem); return; }
      this.running = !this.running;
      this.lastFrameTime = null;
      this.updatePanels(true);
    }

    stepOnce() {
      if (!this.applyPendingEdits()) return;
      if (this.world.over) {
        this.flash(this.mission ? 'This attempt is over. Press ▶ Try again, or R to reset and then Step.'
          : 'The match is over. Press ▶ Rematch, or R to reset and then Step.');
        return;
      }
      if (!this.world.robots.length) { this.flash(this.emptyArenaReason()); return; }
      const problem = this.teamProblem();
      if (problem) { this.flash(problem); return; }
      this.running = false;
      this.syncDebugger();
      this.world.step();
      this.checkBreakpoint();
      this.checkMissionResult();
      this.updatePanels(true);
    }

    /**
     * Before ticks: hand each robot's CPU its entry's breakpoints (if it runs
     * that entry's applied code), and record a trace only for the selected robot.
     */
    syncDebugger() {
      for (const r of this.world.robots) {
        const e = this.entry(r.entryId);
        // Breakpoints follow the draft as it is edited, so they only apply while it matches the running code.
        r.vm.breakLines = e && e.breakpoints.size > 0 && e.runningSource === e.source && e.draft === e.source ? e.breakpoints : null;
        if (r.entryId !== this.selectedId) r.vm.trace = null;
        else if (!r.vm.trace) r.vm.trace = [];
      }
    }

    /** After a tick: if a robot stopped at a breakpoint, pause and show its code. */
    checkBreakpoint() {
      const r = this.world.robots.find((x) => x.vm.breakHit);
      if (!r) return false;
      for (const x of this.world.robots) x.vm.breakHit = 0;
      this.running = false;
      if (this.selectedId !== r.entryId) this.select(r.entryId);
      this.flash(`Breakpoint: ${r.name} is about to run line ${r.vm.resumeLine}.`);
      return true;
    }

    /** Keep `e`'s breakpoints on the same code when its text changes from `before` to `after`. */
    moveBreakpoints(e, before, after) {
      if (!e.breakpoints.size || before === after) return;
      const moved = shiftLines(before, after, [...e.breakpoints]);
      e.breakpoints.clear();
      for (const n of moved) e.breakpoints.add(n);
      if (e === this.selected) this.editor.setBreakpoints(e.breakpoints);
    }

    toggleBreakpoint(line) {
      const e = this.selected;
      if (!e) return;
      if (e.breakpoints.has(line)) e.breakpoints.delete(line);
      else {
        const res = this.compile(e.draft);
        if (res.errors.length) { this.flash('Fix the syntax errors before setting breakpoints.'); return; }
        if (!res.program.some((ins) => ins.line === line)) { this.flash('Breakpoints go on lines with an instruction.'); return; }
        e.breakpoints.add(line);
      }
      this.editor.setBreakpoints(e.breakpoints);
      this.persist();
    }

    frame(now = performance.now()) {
      const elapsed = this.lastFrameTime === null ? 0 : Math.max(0, Math.min(now - this.lastFrameTime, 100));
      this.lastFrameTime = now;
      if (this.running && this.world && !this.world.over) {
        this.acc += elapsed * 60 / 1000 * SPEEDS[this.speedIndex];
        let steps = Math.min(Math.floor(this.acc + 1e-9), MAX_STEPS_PER_FRAME);
        // Discard excess catch-up work after a stall, retaining only a fraction.
        this.acc = Math.max(0, this.acc - Math.floor(this.acc + 1e-9));
        if (steps > 0) this.syncDebugger();
        while (steps-- > 0 && !this.world.over) {
          this.world.step();
          if (this.checkBreakpoint()) { this.updatePanels(true); break; }
        }
        if (this.world.over) this.running = false;
        this.checkMissionResult();
      }
      if (this.world) {
        this.renderer.addEvents(this.world.drainEvents());
        this.renderer.draw(this.world, this.selectedId, { paused: !this.running });
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
      // Drop breakpoints whose line no longer holds an instruction.
      const lines = new Set(compiled.program.map((ins) => ins.line));
      for (const n of e.breakpoints) if (!lines.has(n)) e.breakpoints.delete(n);
      this.editor.setBreakpoints(e.breakpoints);
      this.persist();
      this.checkDraft();
      const robot = this.robotFor(e.id);
      if (this.world.tick === 0 || this.world.over) {
        this.resetMatch();
        this.flash('Applied. The arena has been reset.');
      } else if (robot && sameInstructions(robot.vm.program, e.compiled.program)) {
        // Only comments, spacing or the appearance changed: keep the CPU (registers,
        // position in the program), with the new line numbers for markers and breakpoints.
        robot.vm.program = e.compiled.program;
        this.world.renameRobot(robot, e.compiled.name);
        robot.appearance = { ...e.compiled.appearance };
        e.runningSource = e.source;
        this.flash('Applied. Only comments or spacing changed, so your robot kept going.');
      } else if (this.mission) {
        // A mission is judged over the whole attempt (laps driven, shots missed, time close to the
        // Leader...), so new code starts the attempt again: a correct fix never fails for old mistakes.
        const wasRunning = this.running;
        this.resetMatch();
        this.running = wasRunning;
        this.flash('Applied. The mission starts again with your new code.');
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
      const failed = [];
      const done = () => { if (--pending === 0 && last) this.afterLoad(last, list.length - failed.length, failed); };
      for (const f of list) {
        const reader = new FileReader();
        reader.onload = () => {
          last = this.addEntry(f.name, String(reader.result), { select: false });
          done();
        };
        // If nothing loads, this message is the last word.
        reader.onerror = () => { failed.push(f.name); this.flash(`Could not read ${failed.join(', ')}.`); done(); };
        reader.readAsText(f);
      }
    }

    afterLoad(last, count, failed = []) {
      this.persist();
      this.select(last.id);
      this.resetMatch();
      const skipped = failed.length ? ` Could not read ${failed.join(', ')}.` : '';
      this.flash(`Loaded ${count} file${count > 1 ? 's' : ''}.${skipped}`);
    }

    // ------------------------------------------------------------ panels

    updatePanels(force) {
      this.lastPanelUpdate = performance.now();
      const w = this.world;
      $('#tick').textContent = w ? w.tick : 0;
      const runBtn = $('#btn-run');
      runBtn.textContent = this.running ? '❚❚ Pause' : (w && w.over ? (this.mission ? '▶ Try again' : '▶ Rematch') : '▶ Start');
      runBtn.classList.toggle('active', this.running);
      let status = 'Paused';
      if (w && w.over) {
        if (w.mission && w.mission.result) status = w.mission.result.ok ? '✓ Mission complete' : 'Not yet: try again';
        else if (w.teamMode) status = w.winnerTeam === null ? 'Draw' : `🏆 Team ${TEAMS[w.winnerTeam]} wins`;
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
        } else if (!r && this.mission) {
          text = 'Waiting: mission in progress'; cls = 'muted';
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
      // Rebuilt only on change, like the trace: otherwise the 10 Hz refresh replaces
      // a cell before its tooltip (the plain-language help) has time to appear.
      const show = (html) => {
        if (html === this.debugHtml) return;
        this.debugHtml = html;
        $('#debug').innerHTML = html;
      };
      const e = this.selected;
      const r = e && this.robotFor(e.id);
      if (!r) {
        show('<div class="muted">Select a robot that is in the arena to inspect its CPU.</div>');
        this.editor.setExecLine(0);
        this.editor.setCounts([]);
        this.updateTrace(null);
        return;
      }
      const vm = r.vm;
      const state = vm.fault ? `<span class="bad">${this.simple ? esc(BB.explain.fault(vm.fault)) : `FAULT — ${esc(vm.fault)}`}</span>`
        : !r.alive ? 'destroyed' : vm.halted ? 'halted'
        : vm.resumeLine && !this.running ? `<span class="bp-state">● stopped at breakpoint, line ${vm.resumeLine}</span>`
        : `next: line ${vm.currentLine}`;
      const cell = (k, v, tip) => `<span${tip ? ` title="${esc(tip)}"` : ''}><i>${k}</i>${v}</span>`;
      if (this.simple) {
        // Only the boxes and sensors this program uses, with plain-language tooltips.
        const used = usedByProgram(vm.program);
        const regs = used.regs.map((i) => cell(`R${i}`, vm.regs[i], BB.explain.REGISTER)).join('');
        const sens = used.sensors.map((s) => cell(s, this.world.sense(r, BB.ISA.SENSOR_MAP[s].id), BB.explain.sensor(s))).join('');
        show(`
          <div class="dbg-line"><b>${esc(r.name)}</b> · ${state}</div>
          ${regs ? `<div class="kv">${regs}</div>` : '<div class="muted">This program doesn\'t use any boxes (registers) yet.</div>'}
          ${sens ? `<div class="kv sensors">${sens}</div>` : ''}`);
      } else {
        const sensors = ['X', 'Y', 'HEADING', 'SPEED', 'HEALTH', 'COOLDOWN', 'TURRET', 'FRONT', 'SCAN_DIST', 'SCAN_ANGLE', 'SCAN_RANGE', 'THREAT_DIST', 'THREAT_ANGLE'];
        const regs = [...vm.regs].map((v, i) => cell(`R${i}`, v)).join('');
        const sens = sensors.map((s) => cell(s, this.world.sense(r, BB.ISA.SENSOR_MAP[s].id))).join('');
        show(`
          <div class="dbg-line"><b>${esc(r.name)}</b> · ${state} · ${r.cyclesLastTick}/${C.CYCLES_PER_TICK} cycles last tick · stack ${vm.stack.length}/${C.STACK_SIZE} · cmp ${vm.cmp}</div>
          <div class="kv">${regs}</div>
          <div class="kv sensors">${sens}</div>`);
      }
      // Only mark lines if the editor shows the code the robot is running.
      // A fault marks the crashing line; otherwise, while paused, the next line.
      let line = 0, kind = 'exec', counts = [];
      if (e.runningSource === this.editor.value) {
        if (vm.fault) { line = vm.faultLine; kind = 'fault'; }
        else if (!this.running && !vm.halted && r.alive) line = vm.currentLine;
        if (this.showCounts) counts = vm.program.map((ins, i) => [ins.line, vm.counts[i]]);
      }
      this.editor.setExecLine(line, kind);
      this.editor.setCounts(counts);
      this.updateTrace(r);
    }

    /** The selected robot's last CPU turn, one row per instruction, shown while paused. */
    updateTrace(r) {
      const vm = r && r.vm;
      let html = '';
      if (!vm) { /* nothing to show */ }
      else if (this.running) html = '<div class="muted">Pause, Step or stop at a breakpoint to see the last tick\'s instructions.</div>';
      else if (!vm.trace) html = vm.halted ? '' : '<div class="muted">Press Step to record this robot\'s next tick.</div>';
      else {
        const notes = this.simple ? BB.explain.traceNotes(vm.trace) : vm.trace.map((t) => t.note);
        const rows = vm.trace.map((t, i) => {
          const bad = vm.lastStop === 'fault' && i === vm.trace.length - 1;
          return `<li data-line="${t.line}"${bad ? ' class="bad"' : ''}><span class="ln">${t.line}</span>` +
            `<code>${esc(t.asm)}</code><span class="note">${esc(notes[i])}</span></li>`;
        });
        if (vm.lastStop === 'break') rows.push(`<li class="end bp" data-line="${vm.resumeLine}"><span class="ln">●</span><span>stopped before line ${vm.resumeLine} (breakpoint)</span></li>`);
        else if (vm.lastStop === 'budget') {
          const out = this.simple ? `Out of coins: carries on at line ${vm.currentLine} next tick` : `out of cycles: continues at line ${vm.currentLine} next tick`;
          rows.push(`<li class="end"><span class="ln">…</span><span>${out}</span></li>`);
        }
        const n = vm.trace.length;
        const head = this.simple ? 'What your robot did last tick' : `Last tick: ${n} instruction${n === 1 ? '' : 's'}`;
        html = `<div class="trace-head">${head}</div>` + (rows.length ? `<ol class="trace-list${this.simple ? ' simple' : ''}">${rows.join('')}</ol>` : '');
      }
      // Rebuilt only on change, so rows stay clickable between 10 Hz panel refreshes.
      if (html === this.traceHtml) return;
      this.traceHtml = html;
      $('#trace').innerHTML = html;
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

    /**
     * The Reference tab, as sections (ids ref-sec-*) whose rows can be linked
     * (ref-ins-OP, ref-sensor-NAME) and filtered by the search box. Simple view
     * leads with plain language and keeps the exact rules below it.
     */
    buildReference() {
      const { INSTRUCTIONS, SENSORS, LANGUAGE_NOTES } = BB.ISA;
      const described = (plain, exact) => (this.simple && plain
        ? `${esc(plain)}<div class="ref-exact">${esc(exact)}</div>` : esc(exact));
      const sections = [];
      const add = (id, title, label, body) => sections.push({ id, title, label, body });
      add('basics', 'Language basics', 'Basics', '<ul class="notes">' +
        LANGUAGE_NOTES.map((n) => `<li>${esc(n).replace(/`([^`]+)`/g, '<code>$1</code>')}</li>`).join('') + '</ul>');
      add('operands', 'Operands', 'Operands', `<table><tr><td><code>dst</code></td><td>register <code>R0</code>..<code>R7</code> or memory <code>[n]</code>, <code>[Rx]</code>, <code>[Rx+n]</code>, <code>[Rx-n]</code></td></tr>
        <tr><td><code>src</code></td><td>anything <code>dst</code> accepts, plus a number or constant</td></tr>
        <tr><td><code>target</code></td><td>a label (where to jump)</td></tr><tr><td><code>sensor</code></td><td>a sensor name (below)</td></tr></table>`);
      for (const group of [...new Set(INSTRUCTIONS.map((ins) => ins.group))]) {
        add(group.toLowerCase(), group, group, '<table class="ref">' + INSTRUCTIONS.filter((ins) => ins.group === group).map((ins) => {
          const form = [ins.op, ins.args.join(', ')].filter(Boolean).join(' ');
          return `<tr id="ref-ins-${ins.op}"><td><code>${esc(form)}</code>${ins.cost > 1 ? `<span class="cost">${ins.cost} ${this.simple ? 'coins' : 'cycles'}</span>` : ''}</td>
            <td>${described(BB.explain.instruction(ins.op), ins.summary)}<div class="ex">${esc(ins.example)}</div></td></tr>`;
        }).join('') + '</table>');
      }
      add('sensors', 'Sensors: <code>GET dst, NAME</code>', 'Sensors', '<table class="ref">' +
        SENSORS.map((s) => `<tr id="ref-sensor-${s.name}"><td><code>${s.name}</code></td><td>${described(BB.explain.sensor(s.name), s.desc)}</td></tr>`).join('') + '</table>');
      add('appearance', 'Appearance header (cosmetic)', 'Appearance', '<table class="ref">' +
        Object.entries(BB.ISA.APPEARANCE).map(([key, spec]) => `<tr><td><code>.${key} preset</code></td><td>${spec.choices.join(', ')}. Default: ${spec.default}.</td></tr>`).join('') +
        '</table><p>Put these optional directives below the name, before labels, constants or instructions. Each may appear once. They change appearance only: collision size, movement, bullet origin and damage stay the same. Twin turrets still fire one shot.</p>');
      add('rules', 'Arena rules', 'Rules', '<table class="ref">' + [
        ['Arena', `${C.ARENA_W} × ${C.ARENA_H}, robot radius ${C.ROBOT_RADIUS}. Layout: Classic, Open, or Random (mirrored obstacles and mud generated from the seed). Don't hard-code obstacle positions; use FRONT and SCAN.`],
        ['Mud', `Brown patches. While your center is in mud, speed is capped at ${C.MUD_MAX_SPEED} either way; GET MUD reads 1. Bullets, SCAN and RADAR pass over it. Open has none.`],
        ['Budget', `${C.CYCLES_PER_TICK} cycles per robot per tick`],
        ['Movement', `speed ${C.MAX_REVERSE}..${C.MAX_SPEED}, acceleration ${C.ACCELERATION}/tick, body turns ${C.BODY_TURN_RATE}°/tick, turret ${C.TURRET_TURN_RATE}°/tick`],
        ['Firing', `bullet speed ${C.BULLET_SPEED}, damage ${C.BULLET_DAMAGE}, cooldown ${C.FIRE_COOLDOWN} ticks`],
        ['Collisions', 'Hitting a wall or obstacle stops you and costs half your speed in health, rounded down: nothing at speed 1, 1 at speed 2 or 3, 2 at speed 4 or 5. Every tick a robot keeps driving into an enemy faster than 1 unit per tick, both take 1 damage, so pushing hurts both sides. Teammates never damage each other.'],
        ['Sensors', `SCAN cone up to ${C.SCAN_MAX_WIDTH}°, blocked by obstacles. Narrow cones reach farther: range ${C.SCAN_RANGE_FACTOR} / √width (${BB.World.scanRange(C.SCAN_MAX_WIDTH)} at ${C.SCAN_MAX_WIDTH}°, ${BB.World.scanRange(16)} at 16°). RADAR range ${C.RADAR_RANGE}.`],
        ['Victory', `Last robot standing wins. After ${C.MAX_TICKS} ticks, the highest health wins, and equal health is a draw. A practice match with only one robot never ends.`],
        ['Teams', 'In 2v2 / 3v3, teammates are invisible to SCAN and RADAR, can\'t hurt each other, and don\'t count in ENEMIES (use ALLIES). Team B spawns as the mirror image of team A. Last team standing wins; at the time limit, highest total health.'],
      ].map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('') + '</table>');
      $('#reference').innerHTML = sections.map((x) => `<section class="ref-sec" id="ref-sec-${x.id}"><h3>${x.title}</h3>${x.body}</section>`).join('');
      $('#ref-jump').innerHTML = sections.map((x) => `<button data-sec="${x.id}">${esc(x.label)}</button>`).join('');
      this.filterReference($('#ref-search').value);
    }

    /** Show only Reference rows containing `query` (any case); hide sections left empty. */
    filterReference(query) {
      const q = String(query || '').trim().toLowerCase();
      let shown = 0;
      for (const sec of document.querySelectorAll('#reference .ref-sec')) {
        const rows = [...sec.querySelectorAll('tr, li')];
        let visible = 0;
        for (const row of rows) {
          row.hidden = !!q && !row.textContent.toLowerCase().includes(q);
          if (!row.hidden) visible++;
        }
        const titleHit = !!q && sec.querySelector('h3').textContent.toLowerCase().includes(q);
        if (titleHit) { for (const row of rows) row.hidden = false; visible = rows.length; }
        sec.hidden = !!q && !visible && !titleHit;
        if (!sec.hidden) shown++;
      }
      $('#ref-none').hidden = shown > 0;
    }

    /** Open the Reference at 'ins:SCAN', 'sensor:HEALTH' or 'sec:basics', and highlight it. */
    openReference(ref) {
      const [kind, name] = String(ref).split(':');
      const id = kind === 'ins' ? `ref-ins-${name}` : kind === 'sensor' ? `ref-sensor-${name}` : `ref-sec-${name}`;
      this.showTab('reference');
      if ($('#ref-search').value) { $('#ref-search').value = ''; this.filterReference(''); }
      const el = document.getElementById(id);
      if (!el) return;
      el.scrollIntoView({ block: 'center' });
      el.classList.remove('ref-flash');
      void el.offsetWidth; // restart the highlight animation
      el.classList.add('ref-flash');
    }

    showTab(name) {
      for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === name);
      for (const p of document.querySelectorAll('.tab-panel')) p.hidden = p.id !== `tab-${name}`;
    }

    /** A short message at the bottom of the page, for `ms` milliseconds. */
    flash(msg, ms = 3500) {
      const el = $('#flash');
      el.textContent = msg;
      el.classList.add('show');
      clearTimeout(this.flashTimer);
      this.flashTimer = setTimeout(() => el.classList.remove('show'), ms);
    }

    // ------------------------------------------------------------ layout

    /** Dismiss the first-visit welcome for good. */
    closeWelcome() {
      try { localStorage.setItem(WELCOME_KEY, '1'); } catch (_) { /* fine: it just shows again next time */ }
      $('#welcome').hidden = true;
    }

    showShortcuts(open) {
      $('#shortcuts').hidden = !open;
      if (open) $('#shortcuts-close').focus();
    }

    /**
     * The divider between the arena and the code panel: drag it, use the arrow
     * keys, or double-click to reset. The width is remembered per browser.
     */
    bindSplitter() {
      const main = $('main'), splitter = $('#splitter'), right = $('section.right');
      const MIN = 320, ARENA_MIN = 380, STEP = 24;
      // `chosen` is the width the user picked. A small window squeezes it to fit,
      // but doesn't overwrite it, so growing the window brings it back.
      let chosen = null;
      const fit = (w) => Math.round(Math.max(MIN, Math.min(innerWidth - ARENA_MIN, w)));
      const apply = () => {
        if (chosen) main.style.setProperty('--right-w', `${fit(chosen)}px`);
        else main.style.removeProperty('--right-w');
      };
      const setWidth = (w, save) => {
        chosen = w ? fit(w) : null;
        apply();
        if (save) {
          try { localStorage.setItem(LAYOUT_KEY, JSON.stringify({ right: chosen })); } catch (_) { /* fine */ }
        }
      };
      try {
        const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null');
        if (saved && Number.isFinite(saved.right)) { chosen = saved.right; apply(); }
      } catch (_) { /* default layout */ }
      splitter.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        splitter.setPointerCapture(ev.pointerId);
        splitter.classList.add('dragging');
        document.body.classList.add('resizing');
      });
      splitter.addEventListener('pointermove', (ev) => {
        if (splitter.classList.contains('dragging')) setWidth(innerWidth - ev.clientX - 3, false);
      });
      const stop = () => {
        if (!splitter.classList.contains('dragging')) return;
        splitter.classList.remove('dragging');
        document.body.classList.remove('resizing');
        setWidth(chosen, true);
      };
      splitter.addEventListener('pointerup', stop);
      splitter.addEventListener('pointercancel', stop);
      splitter.addEventListener('keydown', (ev) => {
        if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
        ev.preventDefault();
        setWidth(right.offsetWidth + (ev.key === 'ArrowLeft' ? STEP : -STEP), true);
      });
      splitter.addEventListener('dblclick', () => setWidth(null, true));
      // A smaller window must still fit the arena and the panel.
      window.addEventListener('resize', apply);
    }

    // ------------------------------------------------------------ help

    /**
     * Tooltip HTML for a word hovered in the editor, or null. With `at` ({ line, index }),
     * the word is read where it is written, so `.turret twin` or a label named `front`
     * isn't mistaken for the TURRET or FRONT sensor.
     */
    helpFor(word, at) {
      const W = word.toUpperCase(), X = BB.explain, simple = this.simple;
      const e = this.selected, r = e && this.robotFor(e.id);
      const live = (v) => `<div class="tip-live">Right now: <b>${v}</b></div>`;
      const more = (ref) => `<button class="tip-more" data-ref="${ref}">More in Reference →</button>`;
      const head = (code, kind) => `<div class="tip-head"><code>${esc(code)}</code> <span class="tip-kind">${kind}</span></div>`;
      const ctx = at && BB.assist.wordContext(this.editor.value, at.line - 1, at.index);
      if (at && !ctx) return null;
      const role = ctx && ctx.role;
      if (role === 'directive' && ctx.key === 'def') {
        return head('.def NAME value', 'constant') +
          `<div>Gives a number a name, so <code>.def FAST 4</code> lets you write <code>SPEED FAST</code>. Uses no ${simple ? 'coins' : 'cycles'}.</div>` + more('sec:basics');
      }
      if (role === 'directive' || role === 'preset') {
        const spec = BB.ISA.APPEARANCE[ctx.key];
        const what = { shape: 'body shape', drive: 'wheels or tracks', turret: 'turret style' }[ctx.key] || 'look';
        return head(`.${ctx.key} preset`, 'appearance') +
          `<div>Picks your robot's ${what}. Choices: ${spec.choices.map((c) => `<code>${c}</code>`).join(', ')} (default ${spec.default}). Looks only: it doesn't change how the robot plays.</div>` +
          more('sec:appearance');
      }
      if (role === 'constant') {
        const value = ctx.value !== undefined ? ` for <b>${esc(ctx.value)}</b>` : '';
        return head(word, 'constant') + `<div>A name you made${value} with <code>.def</code>. It never changes while the robot runs.</div>`;
      }
      if (role === 'label') {
        return head(`${word}:`, 'label') + '<div>A bookmark in your program. Jumps like <code>JMP</code> and <code>CALL</code> go here.</div>';
      }
      const ins = role && role !== 'instruction' ? null : BB.ISA.INSTRUCTION_MAP[W];
      if (ins) {
        const form = [ins.op, ins.args.join(', ')].filter(Boolean).join(' ');
        const cost = ins.cost > 1 ? `<span class="tip-cost">${ins.cost} ${simple ? 'coins' : 'cycles'}</span>` : '';
        return `<div class="tip-head"><code>${esc(form)}</code>${cost}</div>` +
          `<div>${esc((simple && X.instruction(W)) || ins.summary)}</div>` +
          `<div class="tip-ex">Example: <code>${esc(ins.example)}</code></div>` + more(`ins:${W}`);
      }
      const sensor = role && role !== 'sensor' ? null : BB.ISA.SENSOR_MAP[W];
      if (sensor) {
        return head(W, 'sensor') +
          `<div>${esc((simple && X.sensor(W)) || sensor.desc)}</div>` +
          (simple ? `<div class="tip-ex">Read it with <code>GET R0, ${W}</code></div>` : '') +
          (r ? live(this.world.sense(r, sensor.id)) : '') + more(`sensor:${W}`);
      }
      const reg = role && role !== 'register' ? null : /^R([0-7])$/.exec(W);
      if (reg) {
        return head(W, 'register') +
          `<div>${esc(simple ? X.REGISTER : 'One of 8 general-purpose 32-bit registers, R0..R7. Starts at 0.')}</div>` +
          (r ? live(r.vm.regs[reg[1]]) : '') + more('sec:basics');
      }
      return null;
    }

    // ------------------------------------------------------------ missions

    startMission(id) {
      const def = BB.MISSIONS.find((m) => m.id === id);
      if (!def) return;
      this.persist(); // keep the current mission's latest edits before switching
      const n = BB.MISSIONS.indexOf(def) + 1;
      const { source, draft } = this.missionCodeFor(def);
      if (this.mission !== def) { this.hintOpen = false; this.showAnswer = null; }
      this.mission = def;
      this.missionEntry = this.makeEntry(`mission-${n}-${id}.asm`, source, { id: BB.MISSION_ENTRY_ID, draft });
      this.select(BB.MISSION_ENTRY_ID);
      this.resetMatch();
      this.renderMissionBar();
      this.renderMissions();
    }

    /**
     * A mission's saved code as { source, draft }. The arena always runs code
     * that assembles: the last applied version, else the starter. An unfinished
     * edit comes back as the draft, so it is never lost and never empties the arena.
     */
    missionCodeFor(def) {
      const saved = this.missionState.code[def.id];
      let source = def.starter, draft;
      if (typeof saved === 'string') {
        // Older saves kept only the editor text: run it if it assembles, else keep it as the draft.
        if (this.compile(saved).errors.length) draft = saved; else source = saved;
      } else if (saved && typeof saved === 'object') {
        if (typeof saved.source === 'string' && !this.compile(saved.source).errors.length) source = saved.source;
        if (typeof saved.draft === 'string') draft = saved.draft;
      }
      return { source, draft: draft ?? source };
    }

    exitMission() {
      this.persist(); // keep edits made just before leaving
      this.mission = null;
      this.missionEntry = null;
      this.renderMissionBar();
      this.renderMissions();
    }

    /** Throw away the player's code for this mission and start from the starter. */
    restartMissionCode() {
      if (!this.mission || !confirm('Start this mission over? Your changes to its code will be lost.')) return;
      this.missionEntry.source = this.missionEntry.draft = this.mission.starter; // startMission saves, then reloads, this
      this.startMission(this.mission.id);
    }

    renderMissions() {
      const box = $('#missions');
      const done = new Set(this.missionState.done);
      const all = BB.MISSIONS.every((m) => done.has(m.id));
      const card = (m) => {
        const i = BB.MISSIONS.indexOf(m), active = this.mission === m;
        const label = active ? 'Playing' : done.has(m.id) ? 'Play again' : 'Start';
        return `<li class="${done.has(m.id) ? 'done' : ''} ${active ? 'active' : ''}">
          <span class="m-num">${done.has(m.id) ? '✓' : i + 1}</span>
          <div class="m-body"><b>${esc(m.title)}</b><div class="m-goal">${esc(m.goal)}</div><div class="m-teaches">Teaches: ${esc(m.teaches)}</div></div>
          <button data-mission="${m.id}" ${active ? 'disabled' : ''} class="${!active && !done.has(m.id) ? 'primary' : ''}">${label}</button>
        </li>`;
      };
      const units = BB.MISSION_UNITS.map((u, n) => {
        const ms = u.ids.map((id) => BB.MISSIONS.find((m) => m.id === id));
        const finished = ms.filter((m) => done.has(m.id)).length;
        return `<h3 class="unit-title">Unit ${n + 1}: ${esc(u.title)} <span class="unit-progress">${finished} / ${ms.length}</span></h3>
          <ol class="mission-list">${ms.map(card).join('')}</ol>`;
      }).join('');
      box.innerHTML = `
        <p class="missions-intro">Short challenges that each teach one idea. Fix the starter code, then press <b>▶ Start</b>: it always runs the code in the editor.
          Hover over any instruction in the editor to see what it does, or open the Reference tab to see them all.</p>
        ${units}
        ${all ? '<p class="missions-done">🏆 All missions complete! Now build your own robot from scratch and battle your friends.</p>' : ''}
        <p class="missions-reset"><button data-reset-progress title="For shared computers: clears the ✓ marks, hints and mission code saved in this browser">Reset mission progress…</button></p>`;
    }

    /** Shared computers: clear the mission progress and mission code saved in this browser. The roster stays. */
    resetMissionProgress() {
      if (!confirm('Reset all mission progress? This clears the ✓ marks, unlocked hints and mission code saved in this browser. Your robots stay.')) return;
      this.missionState = { done: [], code: {}, fails: {} };
      this.hintOpen = false;
      this.showAnswer = null;
      if (this.mission) {
        this.missionEntry.source = this.missionEntry.draft = this.mission.starter;
        this.startMission(this.mission.id); // saves the starter, then reloads it
      } else {
        this.persist();
        this.renderMissions();
      }
      this.flash('Mission progress reset.');
    }

    renderMissionBar() {
      const bar = $('#mission-bar');
      const m = this.mission;
      bar.hidden = !m;
      if (!m) { bar.innerHTML = ''; return; }
      const i = BB.MISSIONS.indexOf(m), next = BB.MISSIONS[i + 1];
      const passed = this.world && this.world.mission && this.world.mission.result && this.world.mission.result.ok;
      // Help grows with failed attempts: the hint, then a bigger hint (2 fails), then a working answer (4).
      const fails = this.missionState.fails[m.id] || 0;
      const more = fails >= 4 ? ' (more help is ready)' : fails >= 2 ? ' (a bigger hint is ready)' : '';
      const answer = fails < 4 ? ''
        : this.showAnswer === m.id ? `<p><b>A working answer:</b> try typing it in yourself, that's how it sticks!</p><pre class="mb-answer">${esc(m.solution)}</pre>`
        : '<p><button data-mb="answer">Show me a working answer</button></p>';
      bar.innerHTML = `
        <div class="mb-head"><span class="mb-tag">Mission ${i + 1} of ${BB.MISSIONS.length}</span> <b>${esc(m.title)}</b>
          ${this.missionState.done.includes(m.id) ? '<span class="mb-done">✓ complete</span>' : ''}</div>
        <div class="mb-goal">${esc(m.goal)}</div>
        <details class="mb-hint"${this.hintOpen ? ' open' : ''}><summary>Need a hint?${more}</summary>
          <p>${esc(m.hint)}</p>
          ${fails >= 2 ? `<p><b>Bigger hint:</b> ${esc(m.hint2)}</p>` : ''}
          ${answer}</details>
        <div class="mb-actions">
          ${passed && next ? `<button data-mb="next" class="primary">Next mission: ${esc(next.title)} →</button>` : ''}
          <button data-mb="restart" title="Throw away your changes and load the starter code again">Start over</button>
          <button data-mb="exit" title="Go back to your own robots">Exit mission</button>
        </div>`;
    }

    // ------------------------------------------------------------ persistence

    persist() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          seed: $('#seed').value,
          arena: $('#arena-type').value,
          mode: this.mode,
          simple: this.simple,
          entries: this.entries.map((e) => ({ filename: e.filename, source: e.source, draft: e.draft, team: e.team, breakpoints: [...e.breakpoints] })),
        }));
        // Both versions: the last applied code (what the arena runs) and the editor text.
        if (this.missionEntry) this.missionState.code[this.mission.id] = { source: this.missionEntry.source, draft: this.missionEntry.draft };
        localStorage.setItem(MISSION_KEY, JSON.stringify(this.missionState));
      } catch (_) { /* storage unavailable: nothing to do */ }
    }

    restore() {
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (_) { saved = null; }
      try {
        const m = JSON.parse(localStorage.getItem(MISSION_KEY) || 'null');
        if (m && Array.isArray(m.done)) this.missionState.done = m.done.filter((id) => BB.MISSIONS.some((x) => x.id === id));
        if (m && m.code && typeof m.code === 'object') this.missionState.code = m.code;
        if (m && m.fails && typeof m.fails === 'object') {
          for (const [id, n] of Object.entries(m.fails)) if (Number.isInteger(n) && n > 0) this.missionState.fails[id] = n;
        }
      } catch (_) { /* keep the empty mission state */ }
      if (saved && typeof saved.simple === 'boolean') this.simple = saved.simple;
      $('#simple-view').checked = this.simple;
      document.body.classList.toggle('simple', this.simple);
      if (saved && Array.isArray(saved.entries) && saved.entries.length) {
        if (saved.seed) $('#seed').value = saved.seed;
        if (BB.World.ARENAS[saved.arena]) $('#arena-type').value = saved.arena;
        if (MODES[saved.mode]) this.mode = saved.mode;
        $('#mode-type').value = this.mode;
        for (const e of saved.entries) {
          if (!e || typeof e.source !== 'string') continue; // damaged save: nothing to restore
          const team = TEAMS.includes(e.team) ? e.team : null;
          this.addEntry(e.filename, e.source, { select: false, draft: e.draft, team, breakpoints: e.breakpoints });
        }
      }
      // First visit, an emptied roster, or a save too damaged to use: start with the examples.
      if (!this.entries.length) {
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
      $('#show-counts').onchange = (ev) => { this.showCounts = ev.target.checked; this.updateDebug(); };
      $('#simple-view').onchange = (ev) => {
        this.simple = ev.target.checked;
        document.body.classList.toggle('simple', this.simple);
        this.persist(); this.updateDebug(); this.buildReference();
      };
      // Simple view tucks the match settings away; this shows or hides them.
      $('#btn-settings').onclick = () => {
        const open = document.body.classList.toggle('show-settings');
        $('#btn-settings').classList.toggle('active', open);
      };

      // Reference: search as you type, and jump to a section.
      $('#ref-search').addEventListener('input', (ev) => this.filterReference(ev.target.value));
      $('#ref-jump').addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-sec]');
        if (!b) return;
        if ($('#ref-search').value) { $('#ref-search').value = ''; this.filterReference(''); }
        // Scroll the section's heading to just below the sticky search bar (its height varies as buttons wrap).
        const panel = $('#tab-reference'), sec = document.getElementById(`ref-sec-${b.dataset.sec}`);
        panel.scrollTop += sec.getBoundingClientRect().top - $('.ref-tools').getBoundingClientRect().bottom - 6;
      });

      // Insert menu: ready-made code patterns, at the cursor.
      const insert = $('#insert-select');
      insert.innerHTML = '<option value="">➕ Insert code…</option>' +
        BB.SNIPPETS.map((s) => `<option value="${s.id}">${esc(s.title)}</option>`).join('');
      insert.onchange = () => {
        const s = BB.SNIPPETS.find((x) => x.id === insert.value);
        insert.value = '';
        if (!s || !this.selected) return;
        const before = this.editor.value, { code, cursor } = BB.snippetToInsert(s.id, before);
        const at = this.editor.insertBlock(code, { replaceable: BB.isSnippetPlaceholder, below: BB.assist.headerEnd(before) });
        // The cursor waits on a fresh, indented line where the student's own code goes (typing or the next Insert).
        this.editor.select(at.from + cursor);
        const dead = BB.assist.deadAfter(this.editor.value, this.editor.value.slice(0, at.from).split('\n').length - 1);
        if (dead) this.flash(`Heads up: this landed right after "${dead}", so it will never run. Press Ctrl+Z, click where it should go (inside your loop), and insert it again.`, 8000);
        else this.flash(`Inserted "${s.title}". Read its comments, then change it to suit your robot.`);
      };

      // Shortcuts list: the ? button or key; Close, Esc or a click outside the card closes it.
      $('#btn-help').onclick = () => this.showShortcuts(true);
      $('#shortcuts-close').onclick = () => this.showShortcuts(false);
      $('#shortcuts').addEventListener('click', (ev) => { if (ev.target.id === 'shortcuts') this.showShortcuts(false); });

      this.bindSplitter();

      // First visit: a short welcome that points beginners at the missions.
      $('#welcome-mission').onclick = () => { this.closeWelcome(); this.startMission(BB.MISSIONS[0].id); };
      $('#welcome-explore').onclick = () => this.closeWelcome();
      $('#missions').addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-mission]');
        if (b) this.startMission(b.dataset.mission);
        else if (ev.target.closest('[data-reset-progress]')) this.resetMissionProgress();
      });
      // Remember whether the hint box is open, so redrawing the bar after an attempt keeps it that way.
      $('#mission-bar').addEventListener('toggle', (ev) => {
        if (ev.target.classList.contains('mb-hint')) this.hintOpen = ev.target.open;
      }, true);
      $('#mission-bar').addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-mb]');
        if (!b || !this.mission) return;
        if (b.dataset.mb === 'next') this.startMission(BB.MISSIONS[BB.MISSIONS.indexOf(this.mission) + 1].id);
        else if (b.dataset.mb === 'restart') this.restartMissionCode();
        else if (b.dataset.mb === 'answer') { this.showAnswer = this.mission.id; this.hintOpen = true; this.renderMissionBar(); }
        else this.select(this.entries.length ? this.entries[0].id : null);
      });
      this.editor.onGutterClick((line) => this.toggleBreakpoint(line));

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
        this.moveBreakpoints(e, e.draft, value);
        e.draft = value;
        clearTimeout(timer);
        timer = setTimeout(() => { this.checkDraft(); this.persist(); }, 250);
      });
      $('#btn-apply').onclick = () => this.applyDraft();
      $('#btn-save').onclick = () => this.saveFile();
      $('#btn-revert').onclick = () => {
        const e = this.selected;
        if (!e || e.draft === e.source) return;
        // Typed in as an edit, so onChange updates the draft and Ctrl+Z undoes a misclick.
        this.editor.replaceAll(e.source);
        this.checkDraft();
        this.persist();
        this.flash('Back to your last applied code. Changed your mind? Press Ctrl+Z.');
      };
      $('#trace').addEventListener('click', (ev) => {
        const li = ev.target.closest('li[data-line]');
        if (li) this.editor.goToLine(Number(li.dataset.line));
      });
      $('#errors').addEventListener('click', (ev) => {
        const li = ev.target.closest('li[data-line]');
        if (li) this.editor.goToLine(Number(li.dataset.line));
      });

      for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => this.showTab(b.dataset.tab);

      document.addEventListener('keydown', (ev) => {
        // A focused button handles Space/Enter natively, so the shortcuts would fire twice.
        const inField = /^(TEXTAREA|INPUT|SELECT|BUTTON|SUMMARY)$/.test(document.activeElement && document.activeElement.tagName);
        // While the welcome card is open, Esc closes it ("look around first") and nothing else reacts.
        if (!$('#welcome').hidden) {
          if (ev.key === 'Escape') { ev.preventDefault(); this.closeWelcome(); }
          return;
        }
        // While the shortcuts list is open, Esc or ? closes it and nothing else reacts.
        if (!$('#shortcuts').hidden) {
          if (ev.key === 'Escape' || isHelpKey(ev)) { ev.preventDefault(); this.showShortcuts(false); }
          return;
        }
        if (!inField && isHelpKey(ev)) { ev.preventDefault(); this.showShortcuts(true); }
        else if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); this.applyDraft(); }
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
