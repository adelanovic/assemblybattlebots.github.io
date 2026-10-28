#!/usr/bin/env node
// Reproducible balance exploration; never changes the saved game configuration.
// node tools/balance.js [seed-count] [--out docs/balance-results.json]
// (--out writes UTF-8; in Windows PowerShell 5.1, "> file" would write UTF-16 and break the JSON.)
'use strict';
const fs = require('fs');
const BB = require('./load-core')();
const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const outFile = outAt >= 0 ? args.splice(outAt, 2)[1] : null;
if (outAt >= 0 && !outFile) {
  console.error('--out needs a file path');
  process.exit(2);
}
const seeds = Number(args[0] || 20);
if (!Number.isSafeInteger(seeds) || seeds < 1 || seeds > 1000) {
  console.error('seed-count must be an integer from 1 to 1000');
  process.exit(2);
}
const defaults = { ...BB.CONFIG };
const arenas = ['classic', 'random', 'open'];
const names = BB.EXAMPLES.map((ex) => BB.assemble(ex.source).name);
let matches = 0;

function compile(sources) {
  return sources.map((source, id) => {
    const result = BB.assemble(source);
    if (result.errors.length) throw new Error(JSON.stringify(result.errors));
    return { id, name: result.name, program: result.program, appearance: result.appearance };
  });
}
const originalSources = BB.EXAMPLES.map((ex) => ex.source);

function play(entries, seed, arena) {
  const world = new BB.World({ entries, seed, arena });
  while (!world.over && world.tick < BB.CONFIG.MAX_TICKS) world.step();
  matches++;
  return world;
}

function ffa(sources, config = {}) {
  Object.assign(BB.CONFIG, defaults, config);
  const entries = compile(sources);
  const results = {};
  for (const arena of arenas) {
    const summary = { games: 0, wins: Object.fromEntries(names.map((n) => [n, 0])), draws: 0,
      timeLimits: 0, faults: 0, meanTicks: 0, hitRate: 0 };
    let shots = 0, hits = 0;
    for (let seed = 1; seed <= seeds; seed++) {
      // Each robot occupies each roster/spawn slot for the same seed.
      for (let offset = 0; offset < entries.length; offset++) {
        const order = entries.slice(offset).concat(entries.slice(0, offset));
        const w = play(order, seed, arena);
        summary.games++;
        if (w.winner) summary.wins[w.winner.name]++;
        else summary.draws++;
        summary.timeLimits += Number(w.tick >= BB.CONFIG.MAX_TICKS);
        summary.meanTicks += w.tick;
        for (const r of w.robots) {
          summary.faults += Number(!!r.vm.fault);
          shots += r.stats.shots;
          hits += r.stats.hits;
        }
      }
    }
    summary.meanTicks = Math.round(summary.meanTicks / summary.games);
    summary.hitRate = Number((hits / Math.max(1, shots)).toFixed(3));
    results[arena] = summary;
  }
  Object.assign(BB.CONFIG, defaults);
  return results;
}

const result = { seedCount: seeds, methodology: `Seeds 1..N; ${names.length} cyclic roster orders per FFA seed; team compositions swap sides; one parameter changes at a time.`,
  config: defaults, baseline: ffa(originalSources), robotVariants: {}, ruleVariants: {}, teams2v2: {}, duels1v1: {} };

const variants = [
  [0, 'SWEEP_STEP', 18], [0, 'DODGE_RANGE', 120],
  [1, 'CLOSE', 140], [1, 'ALIGN', 4],
  [2, 'WALL_GAP', 100], [2, 'DODGE_RANGE', 140],
  [3, 'RANGE', 120], [3, 'LOCK_WIDTH', 32],
];
for (const [index, key, value] of variants) {
  const sources = originalSources.slice();
  const pattern = new RegExp('(\\.def\\s+' + key + '\\s+)-?\\d+');
  if (!pattern.test(sources[index])) throw new Error('Missing constant: ' + key);
  sources[index] = sources[index].replace(pattern, (_, prefix) => prefix + value);
  result.robotVariants[`${names[index]} ${key}=${value}`] = ffa(sources);
}
for (const [key, value] of [
  ['CYCLES_PER_TICK', 35], ['CYCLES_PER_TICK', 65],
  ['FIRE_COOLDOWN', 10], ['FIRE_COOLDOWN', 20],
  ['BULLET_SPEED', 8], ['BULLET_SPEED', 12], ['MAX_SPEED', 4],
  ['SCAN_RANGE_FACTOR', 1800], ['SCAN_RANGE_FACTOR', 3200],
  ['MUD_MAX_SPEED', 1], ['MUD_MAX_SPEED', 5],
])result.ruleVariants[`${key}=${value}`] = ffa(originalSources, { [key]: value });

const entries = compile(originalSources);
for (const arena of arenas) {
  const summary = { games: 0, wins: Object.fromEntries(names.map((n) => [n, 0])), draws: 0, timeLimits: 0, faults: 0 };
  for (let a = 0; a < entries.length; a++) for (let b = a + 1; b < entries.length; b++) {
    for (let seed = 1; seed <= seeds; seed++) for (const order of [[a, b], [b, a]]) {
      const roster = order.flatMap((index, team) => [0, 1].map((copy) => ({ ...entries[index], id: 2 * team + copy, team })));
      const w = play(roster, seed, arena);
      summary.games++;
      if (w.winnerTeam === null) summary.draws++;
      else summary.wins[names[order[w.winnerTeam]]]++;
      summary.timeLimits += Number(w.tick >= BB.CONFIG.MAX_TICKS);
      summary.faults += w.robots.filter((r) => r.vm.fault).length;
    }
  }
  result.teams2v2[arena] = summary;
}
// 1v1: duels1v1[arena][A][B] = how often A beat B (2 games per seed, one in each spawn order).
for (const arena of arenas) {
  const table = Object.fromEntries(names.map((a) => [a, Object.fromEntries(names.filter((b) => b !== a).map((b) => [b, 0]))]));
  for (let a = 0; a < entries.length; a++) for (let b = a + 1; b < entries.length; b++) {
    for (let seed = 1; seed <= seeds; seed++) for (const order of [[a, b], [b, a]]) {
      const w = play(order.map((index, id) => ({ ...entries[index], id })), seed, arena);
      if (w.winner) table[w.winner.name][w.robots.find((r) => r !== w.winner).name]++;
    }
  }
  result.duels1v1[arena] = { gamesPerPair: 2 * seeds, wins: table };
}
result.totalMatches = matches;
const json = JSON.stringify(result, null, 2);
if (outFile) fs.writeFileSync(outFile, `${json}\n`, 'utf8');
else console.log(json);
