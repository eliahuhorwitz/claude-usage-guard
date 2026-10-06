# Usage Guard

A Claude Code plugin that stops Claude from using up your Claude plan.

It runs before every tool call, in every session, and reads your plan's usage: the same numbers as
`/usage`. No prompt is sent, so checking costs nothing.

- **Warns at 70%** of any limit (the 5-hour window, the weekly limit, a model's weekly limit), once
  per window. The weekly limit also warns when it runs more than 15 points ahead of the week: at
  45% used with two of seven days gone, say.
- **Pauses at 90%**: every tool call is refused until you approve, from your own shell. Claude is
  told to wait for you and never to approve on its own.
- **Pauses again at 95%**, the same way. One interactive build can use about 5 points, and work
  that is already running cannot be stopped, so the second stop is a backstop for the first.

The thresholds are yours to change (see [Thresholds](#thresholds)). If your account has extra usage
switched on, going past 100% is billed, which is why the guard exists.

## Install

In Claude Code:

```
/plugin marketplace add eliahuhorwitz/usage-guard
/plugin install usage-guard@usage-guard
```

Then start a new session (or run `/reload-plugins`). Claude Code installs the plugin's one
dependency itself. Nothing in your `~/.claude/settings.json` is edited.

Requires Claude Code 2.1 or later and Node 20 or later on your `PATH`.

## What you will see

Below 70% the guard is silent. At 70% a line appears in the transcript:

```
Usage guard: past 70%: 5-hour window at 72% (resets Tue 6 Oct, 16:50). Work stops at 90%.
```

At 90% Claude's next tool call is refused and you see:

```
Usage guard: Claude Code is paused at 90% (5-hour window at 90% (resets Tue 6 Oct, 16:50)).
To continue, run:  ! node "/Users/you/.claude/plugins/cache/usage-guard/usage-guard/<version>/src/approve.mjs"
```

Type that line into Claude Code as given. The leading `!` runs it in your shell, outside Claude, so
only you can approve. It approves the windows that are currently stopped, up to the stop they have
reached, until they reset. At 95% the same happens again. Approval is never given in advance: below
a stop there is nothing to approve.

`/usage-guard:status` shows the current usage, the thresholds and what has been approved.

## Thresholds

The defaults are:

| setting | default | meaning |
|---|---|---|
| `warnAt` | `70` | warn once per window from here on |
| `stopAt` | `[90, 95]` | pause at each of these until you approve (ascending; one or more) |
| `paceAhead` | `15` | the weekly limit also warns when it is this many points ahead of the share of the week gone |

To change them, write `~/.claude/usage-guard/config.json` (create the folder if it is not there):

```json
{ "warnAt": 60, "stopAt": [80, 90, 95] }
```

Keys you leave out keep their defaults. A file that does not parse, or that sets a bad value, is
ignored as a whole and the guard says so, in the transcript, on every tool call until it is fixed.

The guard's state (what it has warned about and approved) is in `~/.claude/usage-guard/state.json`.
Both files survive plugin updates and uninstalls.

## How it works, and what it cannot do

- The usage comes from the Claude Agent SDK's usage call, which the SDK marks experimental. The
  plugin pins the SDK version for that reason. If the call ever breaks, or your login has no plan
  limits (an API key, for example), **the guard fails open**: work continues and the transcript says
  `Usage guard could not read your plan usage (...). Continuing without it.` Take that line
  seriously: it means the guard is off.
- Below 80% a reading up to a minute old is reused. From 80% on (ten points below the first stop),
  every tool call reads afresh.
- It stops the *next* tool call. It cannot stop a call that is already running, so a long build
  or test run started at 89% finishes.
- It runs for subagents too, since they make tool calls through the same hook.
- Claude is told, in the refusal it sees, not to work around the pause and not to run the approve
  script. That is an instruction, not a mechanism; the mechanism is that every tool call is refused.

## Update, disable, uninstall

- Update: `/plugin update usage-guard@usage-guard` (or turn on auto-update for the marketplace
  under `/plugin` → Marketplaces).
- Disable for a while: `/plugin disable usage-guard@usage-guard`.
- Uninstall: `/plugin uninstall usage-guard@usage-guard`. Your config and state in
  `~/.claude/usage-guard/` stay; delete them yourself if you want.

## If you installed the earlier, hand-wired version

The first version of this guard lived in `~/.claude/usage-guard/` with its own `hook.mjs`, registered
by hand in `~/.claude/settings.json`. After installing the plugin:

1. Remove the `node ~/.claude/usage-guard/hook.mjs` entry from `PreToolUse` in `~/.claude/settings.json`,
   or both guards run.
2. Delete the old code (`*.mjs`, `node_modules`, `package.json`, `package-lock.json`) from
   `~/.claude/usage-guard/`. Keep `state.json`: the plugin reads the same file, so approvals carry over.

## Development

```
npm ci
npm test
claude plugin validate .
```

To try a checkout in a session without installing it: `claude --plugin-dir /path/to/usage-guard`.
`USAGE_GUARD_FAKE='{"rows":[{"name":"five_hour","used":91,"resets":"2030-01-01T00:00:00Z"}]}'`
feeds the hook a made-up reading, and `USAGE_GUARD_DIR` moves its state and config, so you can
watch it pause without touching your own state.

Changes land on `main`, and users get them with `/plugin update`: the plugin sets no version, so each
commit is a version.
