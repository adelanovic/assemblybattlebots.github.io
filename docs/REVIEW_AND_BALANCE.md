# Balance report

Measured on 2026-10-09 with the current rules: per-robot `RAND` streams, width-based scan range (`SCAN_RANGE_FACTOR` 2400) and mud (`MUD_MAX_SPEED` 2). All figures come from [balance-results.json](balance-results.json). The report covers the five stock example robots in headless simulations; it does not cover custom robots, browser layout or accessibility.

An earlier review (2026-10-07) found five correctness issues. Four are fixed: FRONT now measures swept-body clearance, playback runs on elapsed time with bounded catch-up, robot contacts are resolved iteratively, and CLI integer options are validated. The fifth, an emptied roster coming back as the examples after a reload, is now intended behavior; see [Open issues](#open-issues).

## Reproducing the experiments

Run `npm run balance` (or `node tools/balance.js <seeds> > docs/balance-results.json`; seeds 1..1000, default 20). The script changes parameters only inside its own process and restores the defaults between scenarios.

The study runs:

- **Stock free-for-all** with all five examples on Classic, Random and Open. Each seed is replayed in five cyclic roster orders, so every robot takes every spawn slot: 100 games per arena, 300 in total.
- **Eight single-constant robot variants**, changing one `.def` in one of Sentinel, Hunter, Dodger or Orbiter. Stacker has no variants yet.
- **Eleven single-rule variants** of `CONFIG` values, with every robot program unchanged.
- **Homogeneous 2v2 teams** for every pair of examples, with both sides swapped on every seed and arena: 400 games per arena. Each composition plays 480 games in total.

The 20-seed run completed **7200 matches** with **zero runtime faults**. Roster rotations and side swaps are correlated observations, not extra independent seeds. Mixed teams, 3v3 and combinations of several changed parameters are outside this study.

## What players can adjust

| Parameter | Where | Balance consequence |
|---|---|---|
| Arena: Classic / Random / Open | Toolbar | Changes sight lines, cover, wall contacts, mud and room to dodge. Open has no obstacles and no mud. Compare strategies on all three. |
| Seed | Toolbar | Changes spawns, every robot's `RAND` stream and the Random layout. A single seed is a replay, not an estimate of strength. |
| Free-for-all / 2v2 / 3v3 and team picks | Toolbar and roster | Focus fire, mirrored spawns, friendly blocking and summed-health time limits change what works. |
| Robot code and `.def` constants | Editor | The main balance control players have. Apply rejects drafts with errors. |
| `SCAN` width | Robot program | Every width costs 3 cycles, but reach is `floor(2400 / √width)`: 252 units at 90°, 600 at 16°, 1200 at 4°. Width trades search area against range. |
| Driving through mud | Robot program | Mud caps speed at 2 either way while a robot's centre is inside. `GET R0, MUD` detects it. |
| Playback speed, Step, scan cones | Toolbar | Presentation only; they never change the simulation. |

Health, damage, fire cooldown, bullet speed, turn rates, acceleration, CPU budget, scan range, mud speed and match length have no UI controls. They are `CONFIG` values in `js/core/isa.js`. Random-map spacing, thickness and coverage are the `GEN` values in `js/core/world.js`.

## Parameter interactions

- **Aim tolerance shrinks with range.** A radius-16 target spans about 11.5° at 80 units, 4.6° at 200 and 3.1° at 300. Hunter's `ALIGN` 8 works up close but wastes shots farther out.
- **Scan width now has a range cost.** A wide search cone only sees nearby robots, so a robot that searches wide and locks narrow (Orbiter, Sentinel) reaches farther than one that always scans wide (Hunter at 60° reaches 309; Stacker at 45° reaches 357).
- **Dodging needs time and room.** At `DODGE_RANGE` 200 a speed-10 bullet arrives in about 20 ticks. A quarter turn at 8°/tick takes about 12 ticks and reaching speed 5 takes 10. Radar range caps detection at 250. Unnecessary dodges cause wall contacts and break targeting, and dodging into mud is slow.
- **Mud punishes constant motion.** Robots that keep moving (Orbiter's circling, Dodger's evasion) cross mud often; robots that hold position (Sentinel) rarely do. This is why mud cuts Orbiter's wins most.
- **Sweep rate saturates.** The turret turns at most 20°/tick, so a search step above 20 does not search faster. Hunter asks for 45; Sentinel asks for 9.
- **The CPU budget changes timing unevenly.** Sentinel's lead and dodge paths run longer than 50 cycles and resume the next tick, so budget changes affect advanced robots more than short loops.
- **Bullet speed is coupled to robot code.** Sentinel's lead calculation divides by 10000, which is the 1000 trig scale times bullet speed 10 (`js/core/examples.js:75` and `:78`). Changing `BULLET_SPEED` without updating it miscalibrates its aim.
- **Avoid changing the geometry casually.** Map spacing, hull drawings, the Classic layout, mirrored spawns and spawn margins all assume the current radius and arena size.

## Results

### Stock free-for-all

| Arena | Sentinel | Hunter | Dodger | Orbiter | Stacker | Time limits | Mean ticks | Hit rate |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Classic (100 games) | 23 | 1 | 26 | 50 | 0 | 2 | 1717 | 32.0% |
| Random (100 games) | 20 | 1 | 21 | 51 | 7 | 5 | 1786 | 33.6% |
| Open (100 games) | 19 | 0 | 42 | 38 | 1 | 4 | 1474 | 21.6% |
| **All (300 games)** | **62** | **2** | **89** | **139** | **8** | **11** | **1659** | |

Orbiter wins 46.3% of games, Dodger 29.7%, Sentinel 20.7%, Stacker 2.7% and Hunter 0.7%. On Open, which has no obstacles or mud, Dodger overtakes Orbiter (42 to 38). There were no draws, and only 11 of 300 games reached the 6000-tick limit, so match length is not what decides these results.

### Homogeneous 2v2 teams

| Composition | Wins / games played | Win rate |
|---|---:|---:|
| Two Orbiters | 434 / 480 | 90.4% |
| Two Dodgers | 323 / 480 | 67.3% |
| Two Sentinels | 280 / 480 | 58.3% |
| Two Stackers | 130 / 480 | 27.1% |
| Two Hunters | 33 / 480 | 6.9% |

Orbiter teams are strongest on every arena: 160/160 on Classic, 142/160 on Random and 132/160 on Open. Team play amplifies Orbiter's free-for-all lead, because two robots circling a target is hard to escape.

### Player-editable robot constants

Only the named robot's one constant changes; the counts compare that robot with its own stock result on the same seeds, maps and roster orders.

| Change | Stock wins / 300 | Variant wins / 300 | Per arena (Classic, Random, Open) | Interpretation |
|---|---:|---:|---|---|
| Sentinel `SWEEP_STEP` 9 → 18 | 62 | 86 | 23→30, 20→30, 19→26 | Strongest improvement measured, on every arena. Orbiter falls to 130 wins. |
| Sentinel `DODGE_RANGE` 200 → 120 | 62 | 59 | 23→26, 20→21, 19→12 | Slightly worse overall and much worse on Open. |
| Hunter `CLOSE` 80 → 140 | 2 | 2 | 1→0, 1→2, 0→0 | No effect. |
| Hunter `ALIGN` 8 → 4 | 2 | 2 | 1→1, 1→1, 0→0 | No effect. |
| Dodger `WALL_GAP` 60 → 100 | 89 | 73 | 26→16, 21→20, 42→37 | Worse, especially on Classic: more steering, less fighting. |
| Dodger `DODGE_RANGE` 220 → 140 | 89 | 86 | 26→29, 21→21, 42→36 | Roughly unchanged. |
| Orbiter `RANGE` 200 → 120 | 139 | 118 | 50→42, 51→39, 38→37 | A workable nerf on obstacle maps; Dodger gains most (98 wins). |
| Orbiter `LOCK_WIDTH` 16 → 32 | 139 | 141 | 50→57, 51→48, 38→36 | Unchanged overall; the shorter reach offsets the wider cone. |

Hunter's problems are not in its constants: neither change moves it off two wins.

### Rule sensitivity

Every robot program is unchanged; one `CONFIG` value changes at a time.

| Rule | Sentinel | Hunter | Dodger | Orbiter | Stacker | Draws | Mean ticks |
|---|---:|---:|---:|---:|---:|---:|---:|
| **Defaults** | **62** | **2** | **89** | **139** | **8** | **0** | **1659** |
| Mud speed 2 → 1 | 84 | 2 | 91 | 116 | 7 | 0 | 1535 |
| Mud speed 2 → 5 (no slowdown) | 41 | 2 | 76 | 174 | 7 | 0 | 1780 |
| Scan range factor 2400 → 1800 | 76 | 2 | 62 | 155 | 5 | 0 | 2105 |
| Scan range factor 2400 → 3200 | 59 | 0 | 76 | 156 | 9 | 0 | 1613 |
| CPU budget 50 → 35 | 56 | 2 | 88 | 148 | 6 | 0 | 2000 |
| CPU budget 50 → 65 | 52 | 0 | 75 | 163 | 9 | 1 | 1762 |
| Fire cooldown 15 → 10 | 52 | 1 | 68 | 167 | 11 | 1 | 1291 |
| Fire cooldown 15 → 20 | 55 | 1 | 79 | 162 | 2 | 1 | 2099 |
| Bullet speed 10 → 8 | 48 | 1 | 79 | 168 | 4 | 0 | 1834 |
| Bullet speed 10 → 12 | 46 | 0 | 85 | 163 | 6 | 0 | 1670 |
| Maximum forward speed 5 → 4 | 46 | 1 | 103 | 144 | 6 | 0 | 1836 |

- **Mud is the strongest balance lever measured.** Removing the slowdown raises Orbiter from 139 to 174 wins; a cap of 1 lowers it to 116 and lifts Sentinel to 84.
- **The current defaults are close to the most even setting.** Apart from a lower mud cap, every rule change tested gives Orbiter more wins than the defaults do.
- **Cooldown sets the pace.** A cooldown of 10 shortens matches by 22% and 20 lengthens them by 27%; Orbiter gains roughly 25 wins either way.
- **A shorter scan range mostly slows matches.** At factor 1800 matches run 27% longer; Sentinel gains, but so does Orbiter.
- **No rule change rescues Hunter or Stacker.** Their weaknesses are in their programs.

## Open issues

None. One earlier item is now a deliberate choice:

- **An emptied roster comes back as the examples after a reload.** `restore()` in `js/ui/app.js` starts with the examples whenever the saved roster is empty, so a beginner never opens the app to an empty arena with nothing to run. Load or create a robot, then remove the examples, to keep a roster of your own.

## Suggested next steps

1. **Improve Hunter and Stacker in code, not constants.** Hunter's 60° scan only reaches 309 units and its 45° sweep step exceeds the turret's 20°/tick limit; a wide-search, narrow-lock pattern like Orbiter's would help both. Add Stacker variants to `tools/balance.js` once it has tunable constants.
2. **Try Sentinel `SWEEP_STEP` 18 on a fresh seed range** (for example seeds 21–40) before adopting it.
3. **Consider a mud-aware example robot.** None of the examples read the `MUD` sensor yet, and mud is the biggest single influence on results.
4. **Keep testing on all three arenas.** Open reverses the Orbiter–Dodger order, so a single-arena result can mislead.
5. **If rule controls are exposed in the UI,** start with fire cooldown, match length and mud speed, with documented bounds and a reset-to-default action, and include the full ruleset in replays and CLI output so seeds stay meaningful. Expose bullet speed only after interception code uses the selected value.

No gameplay defaults or example programs were changed by this analysis.
