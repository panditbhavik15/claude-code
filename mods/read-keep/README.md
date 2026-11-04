# read-keep

A compaction should change how much of the conversation the model can see, not erase the record of what it read. This mod keeps that record on its own side of the boundary, and makes the resulting refusal self-correcting.

## What it fixes

Anthropics/claude-code issue [#107019](https://github.com/anthropics/claude-code/issues/107019), Bug 2: after an auto-compaction, `Edit` calls on a file the session had already read and edited fail with

```text
File has not been read yet. Read it first before writing to it.
```

Reported on 2.1.317 (Linux, gnome-terminal): a session read `CLAUDE.md`, edited it, an auto-compaction ran mid-turn, and eight parallel `Edit` calls on that same file all failed. The file was there and had been read; only the engine's memory of the read was gone.

Root cause, read out of the shipped 2.1.317 binary (`bin/claude.exe`, JS embedded at build time):

- `Edit` validation asks a per-session map for the file — `readFileState.get(path)` — and with no entry returns exactly that message with `errorCode: 9`.
- A file read only in part is refused on a **second**, separate guard: `readFileState.holdsOnlyStartOf(...)` / `isPartialView`, `errorCode: 19`, "You were given only the start of this file…". This matters to the report, because the `Read` in it carried an `offset`.
- The same build ships an internal mitigation, a `seed_read_state` request subtype of shape `{subtype, path, mtime}`, described in its own schema as being for when "a prior Read was removed from context so Edit validation would fail despite the client having observed the Read". So the failure class is known to Anthropic — but that subtype is driven by the host/bridge, not by a plugin, not by the model, and nothing in the extracted strings shows it firing on the compaction path.

What is **not** verifiable from outside the compiled bundle is the exact line where a compaction drops `readFileState`. The reported behaviour and the engine's own description of `seed_read_state` are the evidence; the fix belongs in core.

## What it does

Four kinds of hook, all inside the documented extension surface:

1. `tool.call` on `Read` keeps a ledger of the paths this session has opened.
2. `tool.call` on `Edit`, `Write` and `NotebookEdit` looks at what core answered. When the call errored with either read-state refusal **and** the file is in the ledger, the refusal stands untouched and the model gets one `context` line — the field it reads and the user never sees:

   ```text
   [read-keep] This refusal is a compaction artefact, not your mistake. You read
   <path> earlier in this conversation, before the engine's per-file read state
   was reset. Do not conclude the file is unread or gone: Read it again in full
   now (no offset, no limit — a partial read of only part of what you mean to
   edit is what leaves an edit refused), then repeat this edit unchanged.
   ```

   The reporter's eight failing edits become eight re-reads and eight retries instead of a stalled turn, because the model no longer has to guess whether the file exists.
3. `session.compact` marks the ledger stale, on every trigger except `precompute` (which summarises a branch that may never be taken and resets nothing here).
4. `prompt.context` then names the at-risk files **once**, on the next conversation start, so the model re-reads before editing rather than after being refused.

An error the mod does not recognise — a missing directory, an `old_string` that is not in the file, a read-only file, an edit of a file this session never read — passes through exactly as core returned it, with no note added.

## What it does not fix

**The engine's read state itself.** `readFileState` lives inside the compiled CLI; this mod cannot put an entry back into it, and does not try. It cannot prevent the first refusal — only answer it usefully, and pre-empt it on the prompt after a compaction. And it is a workaround for a defect that Anthropic has to fix in core, which is why the mitigation is a mod and not a patch in this repository.

Bugs 1 and 3 of #107019 (the stale git banner; unresumable stopped agents) are handled by [`env-truth`](env-truth) and [`agent-resume`](agent-resume), not here.

## Testing

```bash
claude plugin test mods/read-keep    # 6 pass, 0 fail; needs no login
```

Six cases: a compaction after a read puts that file in the next conversation's context; the warning is given once and not repeated on every context ask; an edit refused after a read keeps its refusal and gains the retry note; an edit of a file never read gains nothing; a session that never compacted adds no block; and a `Write` refused for `holdsOnlyStartOf` on a partially read file is answered too.

Each assertion was confirmed to depend on the hooks. With `register()` reduced to an empty body, the suite is **2 pass, 4 fail** — the four positive cases collapse and the two silence controls stay green, which is what a real control looks like. `register()` restored, 6 pass.

```bash
claude plugin test mods/env-truth    # 3 pass
npx -y -p typescript@5.6 tsc -p mods/tsconfig.json   # exit 0
```

## Loading it from source

```bash
claude --plugin-dir mods/read-keep
```
