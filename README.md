# session-orchestrator

A local-only pixel-art "agent office" for Claude Code sessions. One building is drawn in cross-section: every project folder is a floor, every session is a cute pixel critter at a desk (colour, ears and one accessory come from a hash of its id), and a single elevator carries agents between floors when one session messages another. A Boss Office penthouse sits on top, and the Lobby at the bottom is where unknown visitors walk in.

- Working: the agent types with a focused face and the CRT scrolls text.
- Idle: blinks, looks around, sips coffee, stretches; after a long idle the head goes down on the desk with a pixel "Z".
- Waiting: a "..." thought bubble.
- Cross-session message: the sender stands up, walks to the elevator (or straight along the floor), rides to the recipient's floor, shows a short bubble at their desk, and returns. When the building is mostly idle the lights dim slightly.

## Run

```
node scan.mjs                 # serves http://127.0.0.1:7777
node scan.mjs --once          # prints counts only
node scan.mjs --once --json   # prints the state.json snapshot
```

Open `index.html?demo=1` (straight from disk, no server) for the scripted demo with 10 fake agents in 4 rooms; every 12 to 15 seconds it simulates a `next` that summons one agent to the Boss Office. Add `&night=1` to see the dimmed lights, `&hud=0` to hide the header.

Flags: `--port <n>`, `--anonymize-rooms` (rooms become Room A, B, C), `--show-titles` (shows real session titles locally; off by default), `--max <n>` (agent cap, default 30; at most 6 agents per room and 12 rooms).

## Next: summoning an agent to the Boss Office

The orchestrator session writes `~/.session-orchestrator/focus.json` when Mark types `next`, so the item's agent walks into his office:

```
{"sessionId": "local_...", "at": "2026-10-06T12:00:00Z"}
```

`sessionId` may be a desktop `local_...` id or a transcript uuid. `scan.mjs` only reads the file (never writes it), maps the id to an agent the same way message senders are mapped, and adds `focus: {agentId, at}` to `state.json`. When focus changes, that agent takes the elevator up, stands in front of the boss's desk and says a generic line while the boss looks up; it walks back to its desk when focus changes or clears. An unknown session sends a Guest up from the Lobby. A missing file or one older than 24 hours means no focus.

## Privacy guarantees

- No network calls. The server binds to 127.0.0.1 only, rejects other Host headers, and the page loads no external resource. Zero npm dependencies; Node built-ins only.
- Everything is read-only. `~/.claude/projects` and the Claude desktop session metadata are only read, never written.
- Transcript content, session titles, file paths, branch names and message text are never emitted (the focus file's session id is only mapped to an agent hash and never forwarded). Agents get names derived from a hash of the session id, and ids in `state.json` are hashes too. Rooms show the folder name (the repo root for a worktree) or "Room A/B/C" with `--anonymize-rooms`. Speech bubbles come from a fixed generic set.

## How state is detected

For each transcript in `~/.claude/projects/<slug>/<uuid>.jsonl` modified in the last 7 days, the tail of the file gives the working directory and the last conversation entry. A session is `working` if the file changed within 30 seconds, or its last entry is a tool call or a user prompt with no reply yet (up to 2 minutes). A tool call left pending for 2 to 10 minutes counts as `waiting`; anything else is `idle`, and idle for 30 minutes shows the sleepy "z". Cross-session messages are found as `<cross-session-message from-session="local_...">` turns in the recipient transcript; the sender id is mapped to a transcript through the Claude desktop session metadata, and an unmapped sender walks in from the lobby as a visitor.

## state.json

```
{generatedAt, rooms:[{id,label}], agents:[{id,name,room,state}], events:[{id,at,from,to}], focus:{agentId,at}|null}
```

## Tests

`test/check.mjs` is a dev-only Playwright script (not a dependency of the app): layout and alignment assertions, walker and elevator paths, bubbles, console errors, CPU and pause-when-hidden at several viewport sizes and DPRs. Run with `PW_DIR=<dir containing node_modules/playwright> node test/check.mjs`.

MIT licensed.
