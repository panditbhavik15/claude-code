# env-truth

Verified git status for the directory a subagent actually runs in.

## What it fixes

Anthropics/claude-code issue [#107019](https://github.com/anthropics/claude-code/issues/107019), Bug 1: the environment banner's `Is a git repository` field can describe a **different directory** than the `Primary working directory` line beside it. Reported on 2.1.317 (Linux, gnome-terminal):

```text
start a session in /repos                     (not a repository)
cd /repos/portaone-plugins                    (a git checkout)
spawn a subagent

banner: Primary working directory: /repos/portaone-plugins
        Is a git repository: false            <- wrong; that path is a repo
```

Started directly in the checkout, both lines read `true`. A subagent that believes the flag skips git checks it should have run — the reporter's own words: "a subagent trusting it skips git checks."

Root cause, read out of the shipped 2.1.317 binary: the engine's session git notion is bound to the session, not to the directory a subagent was sent to. `$.session.repo()` takes **no arguments** ("read from the working copy on each call"), the check's directory argument defaults to the session path and short-circuits on a memoised hit, and the environment reducer carries the previous flag across a directory change rather than recomputing it (`isGitRepo: r?.isGitRepo ?? !1`).

## What it does

One hook, on `agent.spawn`. It resolves the directory the subagent will actually run in — the call's own `cwd`, else `$.session.cwd()` — asks git there, and appends the verified answer to the spawn's `prompt`, telling the agent to trust that check over its banner field:

```text
[env-truth] Environment check for the directory you run in, taken at spawn time:
/home/wintery/repos/portaone-plugins IS inside a git repository (root: …). The
session banner's "Is a git repository" field can name a different directory (a
stale session-start value); on this point, trust this check, not that field…
```

A directory git rejects is reported as **not** a repository. A command that cannot start or times out also reads as no repository, so the mod never asserts a repo it has not confirmed.

## What it does not fix

**The banner itself.** `Is a git repository` is rendered inside the compiled CLI (`bin/claude.exe`, JS embedded at build time); this repository holds no CLI source — no `package.json`, `src/`, or `lib/`. This mod changes no banner field. It gives the subagent a correct, independently verified statement to act on, which is the outcome the bug report asks for, delivered through the supported extension surface.

Bugs 2 and 3 of #107019 (read state lost across compaction; unresumable stopped agents) are **not addressed here**.

## Testing

```bash
claude plugin test mods/env-truth    # 3 pass, 0 fail; needs no login
```

Three cases: a subagent in a checkout reached from a non-git session start is told it **is** in a repository; a subagent in a plain folder is told it **is not**; and a spawn that names its own `cwd` is checked **there** rather than at the session.

Each assertion was confirmed to depend on the hook: detaching `on('agent.spawn')` fails all three, with the subagent's prompt arriving unaltered — the bug's own failure mode.

```bash
claude plugin test mods/agents-md    # 5 pass — no regression to shipped mods
```

## Loading it from source

```bash
claude --plugin-dir mods/env-truth
```
