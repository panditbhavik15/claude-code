import type { On, PromptContextBlock } from 'claude-code'

/**
 * The openings of the two refusals this mod can explain, both of which come
 * from the engine having too little read state for the file rather than the
 * file being wrong:
 *
 * - `errorCode 9` — no entry at all for the path (`readFileState.get(path)`
 *   answered nothing), the failure the bug report shows.
 * - `errorCode 19` — an entry that `holdsOnlyStartOf` the file, or is a partial
 *   view, which is what a `Read` with an `offset` leaves behind.
 *
 * Matched on these fragments alone so the mod stays silent on every other edit
 * error — a missing directory, an `old_string` that is not there, a read-only
 * file — none of which a re-read would cure.
 */
const REFUSALS = ['File has not been read yet', 'only the start of this file']

/** True when `text` is one of the two read-state refusals. */
function isRefusal(text: string | undefined): boolean {
  const read = String(text ?? '')
  return REFUSALS.some((refusal) => read.includes(refusal))
}

/**
 * The reminder handed to the model after a refused edit, in the field it reads
 * and the user never sees.
 *
 * Named as a fact about what happened, not a guess about the file: the agent
 * did read it, and the engine's own record of that read did not survive the
 * compaction.
 *
 * @param path the file the edit was for
 */
function retryNote(path: string): string {
  return (
    `[read-keep] This refusal is a compaction artefact, not your mistake. You ` +
    `read ${path} earlier in this conversation, before the engine's per-file ` +
    `read state was reset. Do not conclude the file is unread or gone: Read it ` +
    `again in full now (no offset, no limit — a partial read of only part of ` +
    `what you mean to edit is what leaves an edit refused), then repeat this ` +
    `edit unchanged.`
  )
}

/**
 * The block the mod adds to a conversation once a compaction has happened.
 *
 * @param paths the files read before that compaction
 */
function contextBlockOf(paths: readonly string[]): PromptContextBlock {
  return {
    name: 'readKeep',
    text:
      `[read-keep] This conversation was compacted. The engine's per-file ` +
      `read state was reset by it, so an Edit or Write on a file listed below ` +
      `can fail with "${REFUSALS[0]}" even though it was read. Before editing one ` +
      `of these, Read it again in full rather than treating the refusal as a ` +
      `missing file: ${paths.join(', ')}`,
  }
}

/**
 * Registers the read-state carry-over for one session.
 *
 * Three kinds of hook. `tool.call` on Read keeps a ledger of the files this
 * session has read; `tool.call` on each editing tool answers a
 * "not been read yet" error for a ledger file with the retry note in `context`
 * — the refusal stands, the model simply learns what to do next.
 * `prompt.context` names the ledger once, on the conversation start after a
 * compaction reset the state behind those reads, so the model re-reads before
 * editing instead of spending a turn on the error.
 *
 * @param on the engine's registrar
 */
export function register(on: On): void {
  /** Files this session has Read, in the order first read. */
  const read: string[] = []

  /** True once the reads above may no longer have standing state behind them. */
  let stale = false

  /**
   * The note for a refused edit, when the file was read here and the engine's
   * own error says it holds no read state for it.
   *
   * @param path the file the edit named
   * @param text the error as the model read it (`answer.text`)
   * @returns the reminder to hand the model, or nothing to add
   */
  function noteFor(path: string, text: string | undefined): string | undefined {
    if (!isRefusal(text)) return undefined
    if (!read.includes(path)) return undefined
    stale = true
    return retryNote(path)
  }

  on('tool.call', { tool: 'Read' }, ($, e, next) => {
    if (!read.includes(e.file_path)) read.push(e.file_path)
    return next(e)
  })

  on('session.compact', ($, e, next) => {
    // A `precompute` compaction summarises for a branch that may never be
    // taken and resets nothing in this conversation, so it is left alone.
    if (e.trigger !== 'precompute') stale = true
    return next(e)
  })

  // Each hook narrows to the errored branch before adding its note: a deny and
  // an answered result carry no `context` of this shape, only an error does.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const answer = await next(e)
    if (answer.isError !== true) return answer
    const note = noteFor(e.file_path, answer.text)
    return note === undefined ? answer : { ...answer, context: [note] }
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const answer = await next(e)
    if (answer.isError !== true) return answer
    const note = noteFor(e.file_path, answer.text)
    return note === undefined ? answer : { ...answer, context: [note] }
  })

  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const answer = await next(e)
    if (answer.isError !== true) return answer
    const note = noteFor(e.notebook_path, answer.text)
    return note === undefined ? answer : { ...answer, context: [note] }
  })

  on('prompt.context', ($, e, next) => {
    if (!stale || read.length === 0) return next(e)
    stale = false
    return next({
      ...e,
      blocks: [...e.blocks, contextBlockOf(read)],
    })
  })
}
