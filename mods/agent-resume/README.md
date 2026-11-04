# agent-resume

A message sent to a subagent the user stopped is not a dead end. This mod lets core try to carry on, and when core refuses, it re-starts the same task and delivers the message there.

## What it fixes

Anthropics/claude-code issue [#107019](https://github.com/anthropics/claude-code/issues/107019), Bug 3: the documentation says `SendMessage` continues a spawned agent "with its context intact", but for an agent the user stopped it answers instead:

```text
spawn a background agent called plugin-auditor
stop it (the user's stop, or the app's)
SendMessage({ to: "plugin-auditor", message: "also audit the hooks folder" })

-> Agent plugin-auditor was stopped by the user and
   won't be resumed. Treat its work as cancelled;
   only launch a new agent if the user explicitly asks.
```

The message goes nowhere, and the turn ends with the model told to wait for the user's permission rather than to act. Reported on 2.1.317 (Linux, gnome-terminal).

Root cause, read out of the shipped 2.1.317 binary (`bin/claude.exe`, JS embedded at build time): the resume path exists and throws on purpose. Two throws are in the bundle:

```text
Agent ${id} was stopped by the user and won't be resumed. Treat its work as
cancelled; only launch a new agent if the user explicitly asks.
  — thrown when the task's own record says stoppedByUser

…Background agents are switched off in this session, and it no longer tracks
agent ${id}, so the agent cannot be resumed. Start a new agent if …
  — telemetry name: subagent_launch / subagent_resume_no_rule_diskless
```

So this is a deliberate rule in core, not a crash — which means the disagreement is with the documentation, and only Anthropic can settle it. What the resume path does *before* it throws shows the rest of the machinery is there (`subagent_resume_refused_by_rule`, a `confirm(...)` on the abort signal), so a stopped agent is not unrecoverable by design; the stopped-by-user case is simply given no way back.

## What it does

Two hooks, both inside the documented extension surface:

1. `agent.spawn` records what every subagent was started with — `prompt`, `description`, `subagentType`, `model`, `cwd` — keyed by **both** its `name` and the `agentId` core returns, because `SendMessage` accepts either spelling. A spawn core refused is not recorded, since nothing started.
2. `tool.call` on `SendMessage` **asks core first, always.** Core carries on with a finished agent and refuses only one stopped by the user, and the mod never presumes to know better. Only when core's answer is one of the three stopped-agent wordings does it act:

   - re-spawn the recorded task as a new agent addressed `<target>-resumed`, whose prompt says plainly that it is a **new** run, that nothing the stopped agent learned came across, and to re-check state before repeating anything with side effects — then the original task, then the pending message;
   - deliver the message to it through `SendMessage` itself, so the model gets core's own record back rather than one this plugin invented;
   - add one `context` line naming the new address and the fact that it is a new agent.

   Anything else — an address no spawn of this session recorded, a restart the Agent tool refused, a delivery that did not land, or a target that **is** already a restart this mod made (restarts are not chained, so a second stop ends the chain instead of spawning forever) — returns core's refusal unchanged, with a note saying why nothing was repaired and telling the model not to assume delivery.

## What it does not fix

**It does not resume the stopped agent, and it does not restore its context.** The engine's task table lives inside the compiled CLI; nothing a plugin can call reaches it. The replacement is a fresh agent that re-does the task from its original prompt. That is the honest form of the mitigation: the model's message is acted on, and the model is told exactly what did not carry over. A mod that claimed otherwise would be worse than the bug.

It also cannot resume across `/clear`, a restart, or another session — `agent.list()` and the ledger are per session. And where core's refusal is the *other* one ("background agents are switched off in this session"), the re-spawn is refused for the same reason, so the refusal stands with the reason beside it, which tests 4 covers.

Bugs 1 and 2 of #107019 are handled by [`env-truth`](env-truth) and [`read-keep`](read-keep).

## Testing

```bash
claude plugin test mods/agent-resume    # 8 pass, 0 fail; needs no login
```

Eight cases: a message to a stopped agent reaches a fresh run of the same task and the model is told it is fresh; an agent core still carries on with is left to core and nothing is started; an unrecorded address keeps core's refusal, explained; a refused restart keeps the refusal with the reason; a restart is not restarted again; the replacement carries the stopped agent's type, model and directory; an address given as the `agentId` resumes the same way; and a `SendMessage` that failed for another reason is passed back untouched.

Each assertion was confirmed to depend on the hooks: with `register()` reduced to an empty body the suite is **2 pass, 6 fail** — every repair case collapses and only the two pass-through controls stay green. `register()` restored, 8 pass.

```bash
claude plugin test mods/read-keep      # 6 pass
claude plugin test mods/env-truth      # 3 pass
npx -y -p typescript@5.6 tsc -p mods/tsconfig.json   # exit 0
```

Two harness facts worth recording, both measured rather than assumed:

- `$` may not be handed to a nested closure — the loader requires `$` to appear only at a `$.noun.event(...)` call site, which is why `repair` is a top-level declaration taking the ledger as data.
- a plugin's `$.agent.spawn` args are re-dispatched at `agent.spawn` in the Agent tool's own spelling (`subagent_type`, `run_in_background`), while a whole `AgentSpawnInput` keeps `subagentType`; the test reads both spellings so the assertion is about what the mod asked for.

## Loading it from source

```bash
claude --plugin-dir mods/agent-resume
```
