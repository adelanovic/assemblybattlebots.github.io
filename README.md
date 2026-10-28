# Battle Bots

Program robots in a small assembly language and watch them fight in a 2D arena.

![Battle Bots: a match in progress, with the roster, code editor and CPU inspector](docs/screenshot.png)

## Quick start

There is nothing to install and no build step.

1. Open `index.html` in a modern browser (Chrome, Edge or Firefox). Double-clicking the file works.
2. Five example robots are preloaded. Press **▶ Start**.
3. New to programming? Open the **🎯 Missions** tab for fifteen short guided challenges.

If you prefer to serve it, any static server works, for example `python -m http.server` and then http://localhost:8000.

**Hosting:** the repository root is a complete static site, so it can be served as-is from GitHub Pages or any other static host.

Node.js (v20+) is only needed for the optional command-line tools:

```sh
npm test              # assembler, VM and simulation tests
npm run match         # one headless match between the examples, printed to the terminal
npm run tournament    # 50 seeds, win counts per robot
node tools/headless.js --seed 7 my_bot.asm examples/hunter.asm
node tools/headless.js --rounds 50 --arena random my_bot.asm examples/*.asm   # test across 50 random maps
node tools/headless.js --teams 2 a.asm b.asm c.asm d.asm   # 2v2: first two files are team A, the rest team B
npm run build         # regenerate examples/*.asm, docs/LANGUAGE.md and index.html ?v= tags (run after editing JS or CSS)
node tools/balance.js 20 --out docs/balance-results.json  # compare arenas, bot constants, rules and 1v1 duels
```

## Using the sandbox

| Control | What it does |
|---|---|
| **▶ Start / ❚❚ Pause** (Space) | Run or pause the match. |
| **⏭ Step** (`.`) | Advance exactly one tick. While paused, the CPU inspector and the yellow line marker in the editor show the next line the selected robot will execute. |
| **↺ Reset** (`R`) | Respawn every robot with its *applied* code. The seed decides spawn points and `RAND`, so a seed always replays the same match. |
| **Mode** | **Free-for-all**, **Teams 2v2** or **Teams 3v3**. In a team mode each robot card gets **A / B / Bench** buttons, and **⧉** duplicates a robot so you can field several copies. A team match only starts when both teams have exactly the right number of working robots. |
| **Arena** | **Classic** is the fixed default layout, with four mud patches. **Random** generates a mirrored layout of obstacles and mud from the seed, so 🎲 gives a new map and the same seed always gives the same map. **Open** has no obstacles or mud, which is useful for testing aim and dodging. |
| **Speed** | 0.1× to 60× (6 to 3600 ticks per second). |
| **Scans** | Show or hide each robot's scan cone. |
| **Highlight mine** | The selected robot's bullets get a white ring and everyone else's are drawn fainter, so you can follow your own shots. On by default. |
| **Calm effects** | Fewer sparks, casings and smoke so a match is easier to follow. On by default in Simple view or when the computer asks for reduced motion; ticking or unticking it by hand sticks. |
| **⚙ Settings** | Shown in Simple view: reveals Mode, Arena, Seed, Scans, Highlight mine and Calm effects, which are tucked away to keep the toolbar simple for beginners. Untick Simple view to always see them. |
| **Simple view** | On by default. Plain-language hover help and trace notes, and a CPU inspector that shows only the registers and sensors your program uses. Untick it for every detail. |
| **🎯 Missions** tab | Short guided challenges, one idea each. See [Missions and Simple view](#missions-and-simple-view). |
| **+ New robot / 📂 Load .asm files… / + Add example** | Add robots. Loading accepts several files at once, and you can also drag and drop `.asm` files onto the page. **Each file becomes one robot.** |
| **Editor → Apply** (Ctrl+Enter) | Assemble the code and use it. Before the match starts, the arena resets. During a match, the robot hot-swaps to the new program without losing its position or health. In a mission, changed code starts the attempt again instead, so a correct fix is never failed for mistakes the old code made. **▶ Start** and **Step** apply the selected robot's edits automatically, so the code in the editor is always what runs; if it has syntax errors, nothing runs and the errors are shown. |
| **➕ Insert code…** | Ready-made patterns with comments (main loop, IF, IF / ELSE, repeat, function, scan and fire, wall check, dodge), inserted where the cursor is in one undoable step: on a blank line it replaces that line, at the start of a line it goes above it, and otherwise below it (never above the name or appearance header). The cursor then waits on a new, indented line where your own code goes: under the pattern's `; code here` comment, or right after the pattern. Pressing Enter after a label line (`loop:`) indents the next line too. If the code lands right after a `JMP`, `RET` or `HALT`, where it could never run, a message says so. Label names are renamed automatically if your program already uses them. |
| **Reference** tab | Every instruction, sensor and rule. Search as you type, or jump to a section. In the editor, a tooltip's **More in Reference →** link opens the matching entry. |
| **Autocomplete** | While typing, suggestions appear for what fits where the cursor is: instructions at the start of a line, sensors after `GET R0,`, your own labels after a jump or `CALL`, and registers or constants elsewhere. ↑ ↓ to choose, Enter or Tab to use, Esc to close. |
| **Ctrl+/** | Comment the selected lines out, or back in (the name line is never touched). Handy for experiments. |
| **Divider** | Drag the line between the arena and the code panel to resize them (arrow keys work too; double-click to reset). Your layout is remembered. |
| **?** | Keyboard shortcuts: press **?** or click the **?** button. |
| **💾 Save .asm** (Ctrl+S) | Download the editor contents as a `.asm` file. |
| **Undo changes** | Go back to the code you last applied (Ctrl+Z brings your edits back). |
| **A− / A+** | Make the code text smaller or bigger (11 to 24 px), for small screens or a projector. Remembered in this browser. |

The editor checks your code as you type. Errors appear under the editor and in the line gutter, and clicking an error jumps to that line. The messages are written for beginners: a missing comma (`MOV R0 5`), a label without its colon (`main` instead of `main:`), `R0 = 5`, a minus sign pasted from a document, or code that would always crash (`DIV R0, 0`) each get a specific fix. Warnings (in yellow) don't stop the code from running: for example `SPEED 10` (it drives at 5), `JMP 3` (instruction 3, not line 3) or code left on line 1, which is only the robot's name. Robots with syntax errors stay in the roster but are left out of the arena until fixed. The **CPU inspector** under the editor shows the selected robot's registers and sensors live, plus a **memory** row with the slots the program names (like `[0]`) and any that hold a value. Hover a `[...]` memory value in the code to see which slot it means right now. Click its heading to collapse it and give the editor more room.

**Debugging tools.** Click a line number to set a breakpoint (a red dot); click it again to clear it. When that robot reaches the line, the match pauses just *before* the line runs, the robot is selected, and the yellow marker and the CPU inspector show the state going into that line. Press Step or Start to carry on. The robot gives up the rest of that tick's CPU cycles when it stops, and runs the line on the next tick. Breakpoints are saved with the robot and can only go on lines that hold an instruction. Tick **Run counts** to see how many times each line has run this match, with lines that never ran dimmed: a quick way to spot a routine that never gets called. Whenever the match is paused, the inspector also lists the selected robot's **last tick** instruction by instruction, with what each one did (`R0 = 42`, `5 < 100`, `jump to line 12`) and why the turn ended (WAIT, a breakpoint, or running out of cycles). Click a row to jump to that line.

**Seeing what the robot is told to do.** For the selected robot, a light-blue arrow shows the direction its body is turning toward and a dotted line shows where its turret is turning. While paused, a label spells it out (`speed 2.5 → 4`, `turning to 270°`, `aiming at 315°`).

### Missions and Simple view

The app is built for middle-school beginners and experienced programmers alike, and **Simple view** (in the toolbar) switches between the two:

- **Hover help:** point at any instruction, sensor or register in the editor. Simple view explains it in plain words with beginner-friendly terms ("boxes" for registers, "coins" for cycles), and shows the live value of a register or sensor. With Simple view off, the tooltip shows the technical summary instead.
- **Trace notes:** Simple view words the last-tick trace as sentences, for example `80 is not less than 30, so keep going` or `Look in a 10° cone: enemy 560 away!`.
- **Inspector:** Simple view shows only the registers and sensors your program uses. Untick it to see all 8 registers, the common sensors, the stack, the compare result and cycle use.

The **🎯 Missions** tab has fifteen short challenges in three units. Each one has starter code with one thing to fix, a goal, a hint, and a pass check. When a mission fails, the message says what went wrong (for example "You stopped after 1.0 laps. The goal is 3." or "Every CALL needs a RET").

**Unit 1: Getting started** (one instruction at a time)

1. **Full speed ahead** (`SPEED`): drive into the goal zone.
2. **Which way is up?** (`HEAD` and angles): face up and reach the goal.
3. **Hit the target** (`AIM`, `FIRE`): work out the angle to a target.
4. **Find it with SCAN** (`SCAN`, reading `CMP` and jumps): add the missing shot to a scanning robot.
5. **Dodge!** (`RADAR`): survive a turret for 600 ticks with at least 50 health.

**Unit 2: Registers, loops and functions** (each mission builds on the one before)

6. **Park it** (registers, `GET`, `CMP`, first jump): stop inside a zone by comparing your X position in a register, writing the `JGE` yourself.
7. **Three in a row** (changing a register in a loop): add 30 to the aim angle after each shot. More than 6 shots for the 3 targets fails, so aiming matters.
8. **Three laps** (counting with `INC`): count ticks in a register and stop after exactly 3 laps.
9. **Come back!** (`CALL` and `RET`): one "fire_at" function for two targets, missing its `RET`.
10. **Boss: dodge and attack** (building a program from functions): finish a `dodge` function; `attack` is already written.

**Unit 3: Sensors, math and science** (real-world STEM ideas)

11. **Don't crash** (sensor loops with `FRONT`): explore for 600 ticks, turning before obstacles. The robot must visit 5 of the arena's 12 areas, so driving in circles doesn't count.
12. **Follow the leader** (IF / ELSE): drive when far, wait when close. The same feedback idea as cruise control. The IF / ELSE shape is given; students add its two jumps. The Leader circles the arena, so parking in one spot fails.
13. **Mission control** (coordinates, memory and `ATAN2`): the target's position arrives in memory `[0]` and `[1]`; work out dx, dy and the angle. The target moves every attempt and has a stealth shield SCAN can't see, so the math has to be right, not memorized.
14. **Lead the target** (experimenting): hit a moving target by aiming ahead. The mission reports whether misses passed in front or behind, so students adjust `LEAD` like a real experiment (8 to 14 all work).
15. **Graduation match** (putting it all together): build a robot from earlier functions and beat Rival. Optional extra: add the dodge and test whether it helps (it doesn't always!).

**Help grows with each failed attempt**, so students stay challenged but never stuck: the first hint is a nudge; after two failed attempts a bigger hint appears that is nearly the answer; after four, **Show me a working answer** reveals a solution with a prompt to type it in themselves. If a program crashes, the attempt ends at once and Simple view explains the crash in plain words (for example "it tried to divide by zero").

While a mission runs, your own robots sit out. Click a robot card or **Exit mission** to return to them. Mission code and progress are saved in the browser. The tests check that every mission's starter code fails and its reference solution passes.

### For teachers

- **Progress lives in the browser.** Robots, mission progress and mission code are saved in the browser's `localStorage`, separately for each browser profile. On computers that students share under one login, everyone sees the same progress: give each student their own browser profile or login, or use **Reset mission progress…** at the bottom of the Missions tab between classes (it clears the ✓ marks, unlocked hints and mission code, and keeps the robots).
- **Keeping work.** **💾 Save .asm** downloads a robot's code as a file, and **📂 Load .asm files…** (or drag and drop) brings it back on any computer. That is also how students hand in a robot.
- **Nothing to install, nothing sent anywhere.** The app is a static page with no accounts, no network requests and no tracking. It works offline from a downloaded copy.
- **Pacing.** Each mission teaches one idea and each unit builds on the one before, so you can stop after any mission. The help ladder (hint, bigger hint, working answer) means no one stays stuck, and the Reference tab and hover help cover every instruction.

Apply rejects drafts with syntax errors and keeps the robot's previously applied program. The draft remains in the editor so you can fix it. Single-robot command-line practice runs stop after 6000 ticks and report a practice result; browser practice mode continues until paused.

The roster, seed and arena choice are saved in your browser's `localStorage`. Keyboard shortcuts (Space, `.`, `R`) are ignored while you're typing in the editor or a form field.

The arena shows each robot as a tank. The hull points where it's driving, and the turret turns separately. Damaged robots show scorch marks, and below 25% health they trail smoke. A blinking ⚠ marks a robot whose CPU crashed, and a dimmed robot has halted its program.

## Robot files

Customize your bot with up to nine optional lines below its name, before any labels, constants or instructions. This example uses three; the table below lists all nine:

```asm
Iron Beetle
.shape hexagon
.drive wheels
.turret twin

main:
    WAIT
    JMP main
```

| Setting | Presets | Default |
|---|---|---|
| `.shape` | `tank`, `circle`, `hexagon`, `wedge` | `tank` |
| `.drive` | `tracks`, `wheels`, `hover` | `tracks` |
| `.turret` | `standard`, `short`, `twin` | `standard` |
| `.color` | `red`, `blue`, `yellow`, `green`, `purple`, `orange`, `cyan`, `pink`, `white`, `gray`, `lime`, `indigo`, `brown` | `auto` (by roster position) |
| `.decal` | `stripes`, `flames`, `lightning`, `spots`, `checker` | `none` |
| `.badge` | `star`, `bolt`, `heart`, `crown`, `paw`, `shield`, or a number from 1 to 99 | `none` |
| `.trail` | `smoke`, `sparks`, `bubbles`, `rainbow` | `none` |
| `.boom` | `fire`, `confetti`, `pixels`, `fireworks` (how it explodes when destroyed) | `fire` |
| `.shot` | `shell`, `laser`, `plasma`, `rocket`, `star` (how its bullets look) | `shell` |

These are cosmetic: every bot keeps the same collision radius, movement, bullet origin and firing stats. Twin turrets still fire one shot. The badge also appears next to the robot's name, where it's readable during a match. If two robots choose the same `.color`, the first in the roster keeps it and the other gets the next free color (the match log says so); team matches keep team colors. Each setting may appear once; comments and blank lines are allowed between them. Omitted settings retain the default tank appearance. Appearance is saved in the robot source and updates when you press **Apply**.

```asm
Sniper Sam
; Line 1 is the robot's name (no comment on it); the code starts on line 2.
.def STEP 15              ; optional constants
main:
    SCAN 20               ; look for an enemy in a 20° cone around the turret
    GET  R0, SCAN_DIST
    CMP  R0, 0
    JL   sweep            ; -1 = nothing found
    GET  R1, SCAN_ANGLE
    AIM  R1
    FIRE
    WAIT                  ; end this tick
    JMP  main
sweep:
    GET  R1, TURRET
    ADD  R1, STEP
    AIM  R1
    WAIT
    JMP  main
```

The full instruction and sensor reference is on the in-app **Reference** tab and in [docs/LANGUAGE.md](docs/LANGUAGE.md). Both are generated from the same table the assembler uses. In summary:

- **Registers:** R0 to R7. **Memory:** 256 words (`[12]`, `[R1]`, `[R1+4]`). **Stack:** 64 entries, shared by PUSH/POP and CALL/RET.
- **Data and arithmetic:** MOV PUSH POP ADD SUB MUL DIV MOD INC DEC NEG ABS MIN MAX AND OR XOR RAND
- **Math:** ATAN2 SIN COS SQRT NORM
- **Flow:** CMP JMP JE JNE JL JLE JG JGE CALL RET NOP WAIT HALT
- **Robot:** GET (read a sensor), SPEED, TURN, HEAD, AIM, FIRE, SCAN (enemies), RADAR (incoming projectiles)
- **Sensors:** X Y HEADING SPEED HEALTH COOLDOWN TURRET SCAN_* (including SCAN_RANGE) THREAT_* FRONT LAST_HIT TICK ENEMIES ALLIES ARENA_W ARENA_H MUD

There is no "dodge" instruction. Robots dodge by calling `RADAR` to find an incoming projectile and its direction, then moving out of its path with `HEAD` and `SPEED`. See `dodge:` in the Sentinel and Dodger examples.

### Example robots (`examples/`)

| Robot | Appearance | Strategy |
|---|---|---|
| **Sentinel** | Hexagon, tracks, standard turret | Stationary sniper. Narrow sweeping scan, leads moving targets, sidesteps bullets (and reverses when that needs less turning). |
| **Hunter** | Wedge, wheels, twin turret | Aggressive chaser. Wide scan, charges straight at the enemy, fires when lined up, never dodges. |
| **Dodger** | Circle, wheels, short turret | Evasive skirmisher. Always moving, bounces off walls, swerves away from every projectile, independent turret. |
| **Orbiter** | Tank, hover, standard turret | Circle-strafer. Locks on, orbits at about 200 units while firing, flips direction near walls. |
| **Stacker** | Hexagon, wheels, twin turret | Cautious patrol with a sweeping turret. Demonstrates nested calls, explicit register saves and reverse-order restoration. |

**Learning the stack:** load [examples/stacker.asm](examples/stacker.asm) and Step through its routines with the CPU inspector open. `main → combat → fire_if_aligned → angle_error` nests three calls while saving registers with `PUSH`; each routine restores them with `POP` before `RET`. The deepest path uses 11 of the 64 stack entries. The stack is empty at the main loop's `WAIT`, and register `R6` counts completed patrol/turret passes. Helpers can span several CPU ticks without losing their saved values. `CMP` state is not saved by `PUSH`, so each branch checks a fresh comparison after a helper returns.

## Rules of the arena

- 800×600 arena. Rectangular obstacles block movement, bullets and scans.
- Arena layouts:
  - **Classic:** five fixed obstacles.
  - **Open:** none.
  - **Random:** 4 to 9 obstacles generated from the seed, with these guarantees:
    - **Fair:** every obstacle has a twin mirrored through the arena center.
    - **Passable:** obstacles keep a 44-unit gap from each other and the walls, wider than a robot, so every open area can be reached.
    - **Solid:** obstacles are at least 20 units thick, so bullets can't pass through.
    - **Open enough:** obstacles cover at most 11% of the arena.
- Each tick, every living robot gets **the same 50-cycle budget** (SCAN and RADAR cost 3, everything else costs 1). The order robots run in rotates every tick, and the world is frozen while programs run, so order gives no advantage.
- Movement is physical. Speed is −3 to 5, acceleration 0.5 per tick, the body turns up to 8° per tick and the turret up to 20° per tick.
- Bullets travel 10 units per tick and deal 10 damage, with a 15-tick cooldown between shots.
- **Collisions:** touching a wall or obstacle *at any angle* stops the robot (its speed drops to 0) and deals speed ÷ 2 damage, rounded down. So a contact at speed 1 is free, and at full speed it costs 2. Sliding along a wall at a slight angle counts as a contact every tick. Ramming another robot deals 1 damage to both when they close in at more than 1 unit per tick.
- A robot at 0 HP is destroyed. **The last robot standing wins.** After 6000 ticks, the highest health wins, and a tie is a draw. A single robot runs in practice mode with no victory check.

### Team matches (2v2 and 3v3)

- **No friendly fire:** bullets pass through teammates, and teammates can't damage each other by ramming (they still bump).
- **Teammates are invisible to sensors:** `SCAN` skips them, `RADAR` ignores their bullets, and `ENEMIES` counts opponents only. The `ALLIES` sensor gives the number of living teammates. Any free-for-all robot works in a team unchanged.
- **Fair spawns:** team A starts in the left half. Each team B robot starts at the mirror image of its team A counterpart, through the arena center, facing the mirrored direction. All three arena layouts are point-symmetric, so both teams get identical terrain.
- **Victory:** the last team with a robot alive wins. At the time limit, the team with the most total health wins.
- Team A is drawn in warm colors and team B in cool colors, with an "A ·" or "B ·" before each robot's name.

## Limits

Out-of-range values are clamped, so `SPEED 100` gives 5 and `SCAN 500` gives 90. When the value is written in the code, the editor shows a warning saying so; the code still runs.

| Thing | Limit |
|---|---|
| Speed | −3 to 5 units/tick, acceleration 0.5/tick; capped at 2 either way while your center is in mud |
| Turning | body 8°/tick, turret 20°/tick |
| Firing | 1 shot per 15 ticks; bullets: speed 10, damage 10 |
| Health | 100, no healing |
| Scan / radar | scan cone 1° to 90°, reach 2400 / √width (90° reaches 252 units, 16° reaches 600), blocked by obstacles; radar 250 units, nearest bullet only |
| CPU | 50 cycles per tick, 8 registers, 256 memory words, 64 stack entries, 32-bit integers that wrap around |
| Robot name | 24 characters |
| Match length | 6000 ticks |

There's no limit on the number of robots in a match or on program length. Colors repeat after 13 robots, and a very crowded arena spawns extra robots at a fallback point. All values live in `CONFIG` in `js/core/isa.js`.

## How the virtual CPU works

Each robot runs its assembly program on a small virtual CPU implemented in JavaScript. Pressing **Apply** assembles the source into instructions: labels become instruction positions, constants become numbers, and operands are checked against the language rules. Each instruction keeps its source line so errors and the CPU inspector can point back to your code.

Each CPU owns 8 registers (`R0`–`R7`), 256 memory words, a 64-entry stack shared by data and subroutine calls, a program counter pointing to the next instruction, and the result of the last `CMP`. Registers and memory start at zero. Values use signed 32-bit integers and wrap on overflow.

Every simulation tick, each living robot gets **up to 50 CPU cycles**. Most instructions cost 1 cycle; `SCAN` and `RADAR` cost 3. `WAIT` ends the CPU's turn and discards unused cycles. When the budget runs out, execution resumes at the next pending instruction on the following tick. Running past the end of the program wraps to its first instruction; `HALT` stops the CPU until reset or program reload.

For example, this robot scans for an enemy and requests movement toward it:

```asm
Chaser
main:
    SCAN 60
    GET  R0, SCAN_DIST
    CMP  R0, 0
    JL   idle
    GET  R1, SCAN_ANGLE
    HEAD R1
    SPEED 5
idle:
    WAIT
    JMP  main
```

`SCAN_DIST` is −1 when no enemy is found, so `JL idle` skips the movement commands in that case. Otherwise, `HEAD` sets a desired body heading and `SPEED` sets a desired speed. Existing movement commands persist, so losing sight of an enemy does not stop this robot automatically.

Commands request actions rather than instantly changing the body. All CPUs run before physical movement; then the world applies turning, acceleration, movement, collisions, requested shots, and projectile motion. This gives every CPU the same physical state to inspect during a tick. `SCAN` and `RADAR` update their result sensors immediately, while a command such as `AIM` takes effect during the later physical update. Even a halted or faulted CPU leaves its body following its last movement and aiming commands.

See [docs/LANGUAGE.md](docs/LANGUAGE.md) for instruction details, sensor behavior, and execution order.

## Safety: bad code can't break the arena

- **Infinite loops:** the VM stops after the robot's cycle budget each tick and resumes on the next tick, so a `loop: JMP loop` only wastes its own robot's time.
- **Runtime errors** (division by zero, stack overflow, memory out of range, SQRT of a negative number): the robot's CPU *faults* and halts with a message such as `Line 12: division by zero`, shown in the inspector and the match log, and the crashing line is marked red in the editor. Its body stays in the arena. Other robots are unaffected. When the bad value is written right in the code (`DIV R0, 0`, `[300]`), the assembler reports it before the match instead.
- **Isolation:** a VM only has its own registers, memory and stack, plus a narrow I/O interface (`sense`, `speed`, `aim`, …). It never touches world objects directly. JavaScript exceptions are trapped per robot.

## Keeping robots private

Robot files you don't want published, such as competition entries, can stay in the folder: name them `something.private.asm` or put them in a `private/` folder, and `.gitignore` keeps them out of Git. They still load in your local copy through **📂 Load .asm files…**, but they're never committed or served from GitHub Pages.

## Architecture

See [docs/REVIEW_AND_BALANCE.md](docs/REVIEW_AND_BALANCE.md) for the second review, adjustable-parameter interactions, and seeded balance measurements. The reusable `tools/balance.js` experiment changes rules only in its own process.

```
index.html            page layout; loads scripts in order (no bundler, works from file://)
css/style.css
js/core/              pure logic, no DOM: runs in the browser and in Node
  isa.js              instruction set, sensors, constants (single source of truth)
  assembler.js        source -> program, or a list of { line, message } errors
  vm.js               isolated CPU with cycle budget and fault handling
  geometry.js         angles, ray/rect tests, collision push-out, seeded RNG
  world.js            arena simulation: tick loop, physics, sensors, damage, victory
  examples.js         built-in example robots
  missions.js         guided missions: starter code, goals, pass checks, mission worlds
js/ui/
  explain.js          plain-language help and trace notes for Simple view
  snippets.js         Insert-menu code patterns
  assist.js           autocomplete suggestions and Ctrl+/ comment toggling
  terrain.js          arena floor, trees, mud and battle-scar drawing
  renderer.js         canvas drawing and visual effects (read-only view of the world)
  editor.js           textarea editor with highlighting, gutter, markers, hover help
  app.js              roster, controls, editor wiring, inspector, persistence, main loop
tools/                Node CLI: headless matches, doc and example generation
tests/run-tests.js    dependency-free test suite
examples/*.asm        example robots as loadable files
docs/LANGUAGE.md      generated language reference
```

Data flows one way: **source → `assemble()` → program → `VM` (one per robot) → `World.step()` → `Renderer.draw()`**. To add an instruction, add a row to `INSTRUCTIONS` in `isa.js`, a `case` in `VM.exec`, and a plain-language sentence in `js/ui/explain.js` (a test checks that every instruction and sensor has one). The assembler, the in-app reference and `docs/LANGUAGE.md` (after `npm run build`) pick it up automatically.

## License

Open source under the [MIT License](LICENSE). Battle Bots is a free, independent educational project. It is not affiliated with, sponsored by or endorsed by BattleBots, Inc. or the *BattleBots* television series.
