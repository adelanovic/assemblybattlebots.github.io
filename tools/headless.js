#!/usr/bin/env node
// Run matches without a browser.
//
//   node tools/headless.js examples/*.asm            one match, seed 1
//   node tools/headless.js --seed 7 a.asm b.asm      pick a seed
//   node tools/headless.js --rounds 20 examples/*.asm  tournament over seeds 1..20
//   node tools/headless.js --arena random ...          classic (default) | random | open
//   node tools/headless.js --teams 2 a b c d             team match: first 2 files = team A, next 2 = team B
'use strict';
const fs = require('fs');
const BB = require('./load-core')();

const args = process.argv.slice(2);
let seed = 1, rounds = 1, verbose = false, arena = 'classic', teamSize = 0;
const files = [];
function positiveInteger(option, value, max = Number.MAX_SAFE_INTEGER) {
  if (!/^\d+$/.test(value || '') || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max) {
    console.error(`${option} requires a positive integer${max < Number.MAX_SAFE_INTEGER ? ` up to ${max}` : ''}, got ${value === undefined ? '(missing)' : value}`);
    process.exit(2);
  }
  return Number(value);
}
const USAGE = 'usage: node tools/headless.js [--seed N] [--rounds N] [--arena classic|random|open] [--teams N] [-v] robot.asm ...';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--seed') seed = positiveInteger('--seed', args[++i], 0xFFFFFFFF);
  else if (args[i] === '--rounds') rounds = positiveInteger('--rounds', args[++i]);
  else if (args[i] === '--arena') arena = args[++i];
  else if (args[i] === '--teams') teamSize = positiveInteger('--teams', args[++i]);
  else if (args[i] === '-v') verbose = true;
  else if (args[i] === '--help' || args[i] === '-h') { console.log(USAGE); process.exit(0); }
  else if (args[i].startsWith('-')) { console.error(`unknown option ${args[i]}
${USAGE}`); process.exit(2); }
  else files.push(args[i]);
}
if (!files.length) {
  console.error(USAGE);
  process.exit(2);
}

const entries = [];
if (seed + rounds - 1 > 0xFFFFFFFF) {
  console.error('seed range must stay within 1..4294967295');
  process.exit(2);
}
// Options are checked first, then the robot files.
const missing = files.filter((f) => !fs.existsSync(f));
if (missing.length) {
  console.error(`can't find ${missing.join(', ')}`);
  process.exit(2);
}
let bad = false;
files.forEach((f, i) => {
  const res = BB.assemble(fs.readFileSync(f, 'utf8'));
  if (res.errors.length) {
    bad = true;
    for (const e of res.errors) console.error(`${f}:${e.line}: ${e.message}`);
  } else {
    const team = teamSize ? (i < teamSize ? 0 : 1) : undefined;
    entries.push({ id: i, name: res.name, program: res.program, appearance: res.appearance, team });
  }
});
if (bad) process.exit(1);
if (teamSize && files.length !== 2 * teamSize) {
  console.error(`--teams ${teamSize} needs exactly ${2 * teamSize} robot files (${teamSize} per team), got ${files.length}`);
  process.exit(2);
}
if (!BB.World.ARENAS[arena]) {
  console.error(`unknown arena "${arena}" (use ${Object.keys(BB.World.ARENAS).join(', ')})`);
  process.exit(2);
}

const wins = new Map();
for (let r = 0; r < rounds; r++) {
  const world = new BB.World({ entries, seed: seed + r, arena });
  while (!world.over && world.tick < BB.CONFIG.MAX_TICKS) world.step();
  if (!world.competitive) world.addLog('Practice run finished (time limit reached).');
  const teamLabel = (t) => `Team ${BB.World.TEAM_NAMES[t]} (${world.robots.filter((b) => b.team === t).map((b) => b.name).join(', ')})`;
  const key = !world.competitive ? '(practice)' : world.teamMode
    ? (world.winnerTeam === null ? '(draw)' : teamLabel(world.winnerTeam))
    : (world.winner ? world.winner.name : '(draw)');
  wins.set(key, (wins.get(key) || 0) + 1);
  if (rounds === 1 || verbose) {
    if (rounds === 1) for (const l of world.log) console.log(`[${String(l.tick).padStart(5)}] ${l.text}`);
    else console.log(`seed ${seed + r}: ${key} @ tick ${world.tick}`);
    if (rounds === 1) {
      for (const b of world.robots) {
        const team = b.team === null ? '' : `[${BB.World.TEAM_NAMES[b.team]}] `;
        console.log(`  ${(team + b.name).padEnd(18)} hp=${String(Math.ceil(b.health)).padStart(3)} shots=${b.stats.shots} hits=${b.stats.hits}` +
          (b.vm.fault ? ` FAULT: ${b.vm.fault}` : ''));
      }
    }
  }
}
if (rounds > 1) {
  console.log(`\nResults over ${rounds} rounds (${arena} arena):`);
  for (const [k, v] of [...wins].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(14)} ${v}`);
}
