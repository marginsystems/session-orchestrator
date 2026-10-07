---
name: orchestrate
description: Make this session the orchestrator; it keeps the queue and answers /next
disable-model-invocation: true
allowed-tools: Bash(node *), Read, Write, Edit
---

This session is now the orchestrator. Only one session orchestrates; running `/orchestrate` in another session hands the job to that one.

!`node "${CLAUDE_PLUGIN_ROOT}/scan.mjs" --ensure`

1. Keep the queue: the items that need the user, in order, front first. Use the user's existing queue file if their instructions name one; otherwise keep it in `~/.session-orchestrator/queue.md`. Each item records its session id (desktop `local_...` id or transcript uuid) when it has one.
2. After every change to the queue, write `~/.session-orchestrator/queue.json` in queue order: `{"at": "<ISO now>", "orchestrator": "<this session's id>", "items": [{"sessionId": "<id or null>"}]}` (write a temp file, then rename). That is the waiting room. `orchestrator` is this session's own id (desktop `local_...` id or transcript uuid); prompts typed here then do not send the boss out of his office.
3. On `/next` (or `next`): follow the `/next` command exactly: run `node "${CLAUDE_PLUGIN_ROOT}/scan.mjs" --next-info`, get the session's context % from the host's session usage tool, and show the item with its required `Session: "<exact title>" (<project>) · Context: <N>% used` line. Then write `~/.session-orchestrator/focus.json` as `{"sessionId": "<its id>", "at": "<ISO now>"}`, remove the item at `QUEUE_INDEX` (not always the front) from the queue and rewrite `queue.json`. If the output is `QUEUE: nothing on air`, say `Nothing on air in the queue.` and stop. While streamer mode is on, never mention or show deferred items. That agent walks into the Boss Office.

Reply in one line: this session is the orchestrator, N items queued.
