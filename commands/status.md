---
description: Show the Claude plan's usage, the guard's thresholds and what has been approved
---
Run this command and show the person its output as a short table (one row per limit: name, used, resets), followed by the thresholds and any approvals:

```
node "${CLAUDE_PLUGIN_ROOT}/src/status.mjs"
```

Do not run the approve script. Only the person runs it, from their own shell.
