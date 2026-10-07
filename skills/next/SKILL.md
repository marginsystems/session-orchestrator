---
name: next
description: Bring the front item of the queue into the Boss Office (orchestrator session)
disable-model-invocation: true
allowed-tools: Read, Write, Edit
---

Take the front item of the queue, show it to the user, write `~/.session-orchestrator/focus.json` as `{"sessionId": "<its id>", "at": "<ISO now>"}`, remove it from the queue and rewrite `~/.session-orchestrator/queue.json` (`{"at", "orchestrator", "items": [{"sessionId"}]}`, queue order, `orchestrator` unchanged).

If this session is not the orchestrator, say so in one line and point to `/orchestrate`.
