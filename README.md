# session-orchestrator

A local-only, retro pixel-art "agent office" for your Claude Code sessions.

![Session Orchestrator: floors of pixel critters at their desks, the Boss Office on top](docs/office.gif)

<!-- The recording lives at docs/office.gif. Record the office in demo mode (index.html?demo=1&onboarding=0, around 1280x720, 10 to 20 seconds, under 5 MB) so no real project names appear, and replace that one file. -->

Every project folder is a floor, every Claude Code session is a pixel critter at its desk, and a Boss Office sits on top. Sessions that are waiting for you take a number and sit in the Secretary's waiting room, ordered by floor priority and then by how long they have waited. An elevator carries agents between floors.

Everything on screen reflects something that really happens:

- Working: the critter types and the CRT scrolls. Waiting: a thought bubble, or a seat in the waiting room. Idle: blinks, sips coffee, stretches, and eventually naps.
- You prompt a session directly: the boss gets up, rides the elevator to that session's desk, they exchange a short line, and he goes back to his chair.
- One session messages another: the sender walks to the recipient's desk (via the elevator when on another floor).
- A new session starts: a desk drops in on the project's floor, a dust puff, and the new critter rides up from the Lobby and sits. A brand-new project gets a new floor that slides in.
- `next` (see below): the front of the line gets waved through by the secretary and walks into the Boss Office.

Nothing leaves your machine. See [Privacy](#privacy).

## Install

### As a Claude Code plugin

In a Claude Code session:

```
/plugin marketplace add marginsystems/session-orchestrator
/plugin install session-orchestrator@session-orchestrator
```

Then run `/office` (also available as `/session-orchestrator:office`). It starts `node scan.mjs` in the background if it is not already running and prints the local URL, `http://127.0.0.1:7777`.

From a shell, the same thing is:

```
claude plugin marketplace add marginsystems/session-orchestrator
claude plugin install session-orchestrator@session-orchestrator
```

The repository is private for now, so the marketplace add needs git credentials that can read it.

### Plain `git clone`

```
git clone https://github.com/marginsystems/session-orchestrator
cd session-orchestrator
node scan.mjs
```

Open http://127.0.0.1:7777. Node 18 or newer, no `npm install`.

### Demo, no server

Open `index.html?demo=1` straight from disk. It runs a scripted office with generic names: ten agents in four rooms, a boss queue, boss visits, new sessions joining and the secretary flow. Add `&night=1` for dimmed lights, `&hud=0` to hide the header, `&speed=2` to speed it up, `&onboarding=0` to skip the tour. Settings persist in `localStorage` there.

## Run options

```
node scan.mjs                 # serves http://127.0.0.1:7777
node scan.mjs --once          # prints counts only
node scan.mjs --once --json   # prints the state.json snapshot
node scan.mjs --ensure        # starts the server in the background if it is not running
```

Flags: `--port <n>`, `--anonymize-rooms` (rooms become Room A, B, C, for screen recordings), `--show-titles` (shows session titles as name tags above the critters), `--max <n>` (agent cap, default 30; at most 6 agents per room and 12 rooms).

Floors show the real project folder name (the repo root for a worktree). Session titles are hidden unless you opt in.

## Settings

Click the gear in the header. The panel is a small retro window over the office.

- **Floor priority**: the list of projects. Drag a row, or use the up and down buttons (or the arrow keys on a focused row). Floor order is priority: the highest priority sits right under the Boss Office, the lowest just above the Lobby. The building re-stacks with the floors sliding into place. Projects you have not ordered go below the ordered ones, most recently active first.
- **Anonymize rooms**: hides project names (Room A, B, C).
- **Show session titles**: shows a small name tag above each critter.
- **Demo speed**: 1x, 2x or 3x, for the demo.
- **Sound**: stored for later, nothing plays yet.
- **Reset onboarding**: replays the tour.

Settings are saved to `~/.session-orchestrator/settings.json` through the loopback server (`GET /settings`, `POST /settings`). `POST` takes a JSON object with only the known keys (`order`, `anonymize`, `titles`, `speed`, `sound`, `onboardedAt`), is limited to 4 KB, requires `Content-Type: application/json`, and is accepted only from the same origin. Without a server (demo, or a copy of the page opened from disk) settings fall back to `localStorage`.

## Onboarding

The first time you open the office, the Boss walks you through six short steps: your office, floors and critters, the three states, setting priorities (you drag a floor, and confetti follows), the boss queue and `next`, and the privacy promise. Skip any time with Skip or Esc. Add `?onboarding=1` to force it, or `?onboarding=0` to suppress it.

## The `next` contract

An orchestrator session (or anything else) writes `~/.session-orchestrator/focus.json` when you want a session brought to the boss:

```
{"sessionId": "local_...", "at": "2026-10-06T12:00:00Z"}
```

`sessionId` may be a desktop `local_...` id or a transcript uuid. `scan.mjs` only reads the file, never writes it, maps the id to an agent the same way message senders are mapped, and adds `focus: {agentId, at}` to `state.json`. The secretary waves that agent through, it walks into the Boss Office, stands in front of his desk and says a generic line while the boss looks up. It goes back to its desk when focus changes or clears. An unknown session sends a Guest up from the Lobby. A missing file or one older than 24 hours means no focus.

The front of the waiting line is the agent `next` would bring in: waiting agents ordered by floor priority, then by how long they have waited. `state.json` lists them in `queue`.

## state.json

```
{
  generatedAt,
  rooms:  [{id, label}],
  agents: [{id, name, room, state, title?}],
  events: [{id, kind: "message", at, from, to}
         | {id, kind: "boss_visit", at, to}
         | {id, kind: "join", at, agentId}],
  focus:  {agentId, at} | null,
  queue:  [agentId, ...]
}
```

- `rooms` are already in priority order.
- A `boss_visit` is emitted for a genuine human prompt in a transcript. Tool results, cross-session messages, task notifications, system reminders, scheduled-task wrappers and other injected turns do not count (`lib/prompts.mjs`).
- A `join` is emitted when a session whose transcript was created recently appears after the server started. Sessions that existed at startup are not announced.

## Privacy

- No network calls. The server binds to 127.0.0.1 only, rejects other Host headers, and the page loads no external resource. Zero npm dependencies; Node built-ins only.
- Everything under `~/.claude` and the Claude desktop session metadata is only read, never written. The only file this tool writes is `~/.session-orchestrator/settings.json`.
- Transcript content, file paths, branch names and message text are never emitted. Agents get names derived from a hash of the session id, and ids in `state.json` are hashes too. Session titles appear only if you turn them on. Speech bubbles come from a fixed generic set.
- The demo uses generic names only.

## How state is detected

For each transcript in `~/.claude/projects/<slug>/<uuid>.jsonl` modified in the last 7 days, the tail of the file gives the working directory and the last conversation entry. A session is `working` if the file changed within 30 seconds, or its last entry is a tool call or a user prompt with no reply yet (up to 2 minutes). A tool call left pending for 2 to 10 minutes counts as `waiting`; anything else is `idle`, and idle for 30 minutes shows the sleepy "z". Cross-session messages are found as `<cross-session-message from-session="local_...">` turns in the recipient transcript; the sender id is mapped to a transcript through the Claude desktop session metadata, and an unmapped sender walks in from the lobby as a visitor.

## Known limits

- Tested on macOS only. Transcripts are read from `~/.claude/projects` on any OS, but the Claude desktop app session metadata is read from `~/Library/Application Support/Claude`, so on Linux and Windows cross-session senders show as visitors, `local_...` ids in `focus.json` do not resolve, and session titles are unavailable.
- `local_...` session ids exist only for sessions started in the Claude desktop app. For a terminal session, write its transcript uuid to `focus.json` instead.
- State is a guess from transcript timing, not a live signal: `waiting` means a tool call has been pending for 2 to 10 minutes, usually a permission prompt. A session that has finished its turn and waits for your next prompt shows as idle.
- Only transcripts changed in the last 7 days are shown, at most 30 agents, 6 per floor and 12 floors (`--max` raises the agent cap only).
- The office is a browser tab on `127.0.0.1:7777`; `/office` always uses that port. There is no in-app pane yet.
- No sound yet.

## Code layout

`scan.mjs` is the server and `lib/` holds its helpers. `index.html` holds the markup and styles; the page code lives in `office/*.js`, classic scripts loaded in this order:

- `base.js`: query params, constants, palette, math and random helpers, pixel fonts and text drawing, the typed lookups (`elementById`, `canvasById`, `context2d`) and the `TYPE_ONLY` type-example constant.
- `sprites.js`: critter sprite data and the head and body canvases.
- `props.js`: windows, furniture and desk drawing.
- `building.js`: state, layout, floors, walls, labels, static layers and the floor animation.
- `actors.js`: the task system, walking, elevator, trips, boss visits, focus, queue and join or leave.
- `render.js`: per-frame drawing of agents, bubbles, the elevator cab and effects.
- `data.js`: applying server state, polling, settings load and save.
- `demo.js`: the scripted demo.
- `ui.js`: settings panel, hit buttons, drag and keyboard.
- `tour.js`: the onboarding tour.
- `main.js`: boot, the frame loop and the `window.__office` test hook.

## Tests

The app itself has no runtime dependencies. `npm install` installs dev tools only (ESLint and TypeScript); `npm run check` runs lint, typecheck (the server and the page scripts) and the dependency-free unit tests (`node --test test/unit.mjs`).

`test/check.mjs` is a dev-only Playwright script and not a dependency of the app. Install Playwright in a scratch directory outside the repo and run:

```
PW_DIR=<dir containing node_modules/playwright> SHOTS=<scratch dir> node test/check.mjs
```

The server and live sections bind free ports picked at start; set `SO_TEST_PORT=<n>` to use `n`, `n+1` and `n+2` instead.

`ONLY=unit,server,live,demo,ui,perf` runs a subset. It covers human prompt detection against synthetic fixtures, the settings API (validation, size limit, origin checks, persistence, priority and queue order) against a temporary `HOME`, the settings panel, the tour, the queue and secretary, boss visits and joins, layout and alignment, console errors, CPU and pause-when-hidden at 1280x720, 1920x1080, 750x1000 and 390x844 at device pixel ratios 1 and 2.

## Roadmap

- An in-app pane, so the office lives inside the Claude Code window instead of a browser tab. Planned, not built.
- Sound.
- A hook that writes `focus.json` for you.

MIT licensed.
