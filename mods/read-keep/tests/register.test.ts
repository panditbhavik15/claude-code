import type { SessionMessage } from 'claude-code'

import { describe, expect, test, tier } from 'claude-code/testing'

tier('builtin')

/** The file from the bug report: read, edited, then edited again after a compaction. */
const FILE = '/home/wintery/repos/portaone-plugins/CLAUDE.md'

/** What the engine answers when its read state for a file is gone. */
const NOT_READ = {
  result: '',
  text: 'File has not been read yet. Read it first before writing to it.',
  isError: true as const,
}

/**
 * The transcript a test hands `$.session.compact`.
 *
 * A compaction leaves the conversation with something in it, so the engine
 * refuses an empty list; one message of `SessionMessage`'s shape is the least
 * a test can give it.
 */
const TRANSCRIPT: SessionMessage[] = [
  { role: 'user', text: 'Update the plugin READMEs.', toolUses: [] },
]

describe('register', () => {
  test('a compaction names the files whose read state it reset', async ($, on) => {
    on('tool.call', () => ({ result: 'read ok' }))
    on('session.compact', () => ({ messages: TRANSCRIPT }))
    on('prompt.context', ($, e) => ({ blocks: e.blocks }))

    await $.tool.call({ tool: 'Read', file_path: FILE })
    await $.session.compact({ trigger: 'auto', messages: TRANSCRIPT })
    const context = await $.prompt.context({ blocks: [] })

    const note = context.blocks?.find((b) => b.name === 'readKeep')
    expect(note?.text).toContain(FILE)
    expect(note?.text).toContain('File has not been read yet')
  })

  test('the warning is given once, not on every context ask', async ($, on) => {
    on('tool.call', () => ({ result: 'read ok' }))
    on('session.compact', () => ({ messages: TRANSCRIPT }))
    on('prompt.context', ($, e) => ({ blocks: e.blocks }))

    await $.tool.call({ tool: 'Read', file_path: FILE })
    await $.session.compact({ trigger: 'auto', messages: TRANSCRIPT })

    const first = await $.prompt.context({ blocks: [] })
    const second = await $.prompt.context({ blocks: [] })

    expect(first.blocks?.find((b) => b.name === 'readKeep')).toBeDefined()
    expect(second.blocks?.find((b) => b.name === 'readKeep')).toBeUndefined()
  })

  test(
    'an edit refused after a read is answered with what to do, and the ' +
      'refusal still stands',
    async ($, on) => {
      on('tool.call', ($, e) =>
        e.tool === 'Read' ? { result: 'read ok' } : NOT_READ,
      )
      on('prompt.context', ($, e) => ({ blocks: e.blocks }))

      await $.tool.call({ tool: 'Read', file_path: FILE })
      const answer = await $.tool.call({
        tool: 'Edit',
        file_path: FILE,
        old_string: 'a',
        new_string: 'b',
      })

      expect(answer.isError).toBe(true)
      const notes = answer.context ?? []
      expect(notes.join(' ')).toContain('compaction artefact')
      expect(notes.join(' ')).toContain('Read it again in full')
    },
  )

  test('an edit of a file never read gets no reassurance', async ($, on) => {
    on('tool.call', () => NOT_READ)
    on('prompt.context', ($, e) => ({ blocks: e.blocks }))

    const answer = await $.tool.call({
      tool: 'Edit',
      file_path: '/elsewhere/other.md',
      old_string: 'a',
      new_string: 'b',
    })

    expect(answer.isError).toBe(true)
    expect(answer.context).toBeUndefined()
  })

  test('a session that never compacted adds nothing to its context', async ($, on) => {
    on('tool.call', () => ({ result: 'read ok' }))
    on('prompt.context', ($, e) => ({ blocks: e.blocks }))

    await $.tool.call({ tool: 'Read', file_path: FILE })
    const context = await $.prompt.context({ blocks: [] })

    expect(context.blocks?.find((b) => b.name === 'readKeep')).toBeUndefined()
  })

  test(
    'a write refused for holding only the start of a read file is answered ' +
      'too, since a re-read cures that one as well',
    async ($, on) => {
      on('tool.call', ($, e) =>
        e.tool === 'Read'
          ? { result: 'read ok' }
          : {
              result: '',
              text:
                'You were given only the start of this file, and nothing shows ' +
                'that you have since read all of it in one call.',
              isError: true as const,
            },
      )

      await $.tool.call({ tool: 'Read', file_path: FILE, offset: 240 })
      const answer = await $.tool.call({
        tool: 'Write',
        file_path: FILE,
        content: '# plugins\n',
      })

      expect(answer.isError).toBe(true)
      expect((answer.context ?? []).join(' ')).toContain('Read it again in full')
    },
  )
})
