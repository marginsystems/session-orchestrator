---
name: office
description: Start the Session Orchestrator agent office on this machine and show its local URL
disable-model-invocation: true
allowed-tools: Bash(node *)
---

The Session Orchestrator server was just started, or was already running. Its status:

!`node "${CLAUDE_PLUGIN_ROOT}/scan.mjs" --ensure`

Tell the user the local URL from the status line above so they can open it in a browser. The server listens on 127.0.0.1 only, reads Claude Code session data read-only and makes no network calls. Do nothing else.
