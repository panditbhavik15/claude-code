import { describe, expect, test, tier } from 'claude-code/testing'

import Fixtures from './fixtures'

tier('builtin')

/** The non-git folder the session starts in. */
const PARENT = '/home/wintery/repos'

/** The git checkout inside it, entered with `cd` after the session started. */
const CHECKOUT = '/home/wintery/repos/portaone-plugins'

describe('register', () => {
  test(
    'a subagent that runs in a checkout is told it is inside a repository, ' +
      'though the session started in a plain folder',
    async ($, on) => {
      const prompts: string[] = []

      on('session.cwd', () => ({ value: CHECKOUT }))
      on('process.run', () => ({
        value: { exitCode: 0, stdout: `${CHECKOUT}\n`, stderr: '' },
      }))
      on('agent.spawn', ($, e) => {
        prompts.push(e.prompt)
        return { model: 'sonnet', agentId: 'agent-1' }
      })

      await $.agent.spawn(Fixtures.spawnInputOf({}))

      const given = prompts[0] ?? ''
      expect(given).toContain('IS inside a git repository')
      expect(given).toContain(CHECKOUT)
      expect(given).not.toContain('is NOT inside a git repository')
      // the caller's own task still arrives whole
      expect(given).toContain('audit the plugins in this directory')
    },
  )

  test(
    'a subagent that runs in a plain folder is told it is not inside a ' +
      'repository, though a banner may say otherwise',
    async ($, on) => {
      const prompts: string[] = []

      on('session.cwd', () => ({ value: PARENT }))
      on('process.run', () => ({
        value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' },
      }))
      on('agent.spawn', ($, e) => {
        prompts.push(e.prompt)
        return { model: 'sonnet', agentId: 'agent-2' }
      })

      await $.agent.spawn(Fixtures.spawnInputOf({}))

      const given = prompts[0] ?? ''
      expect(given).toContain('is NOT inside a git repository')
      expect(given).toContain(PARENT)
      expect(given).not.toContain('IS inside a git repository')
    },
  )

  test(
    'a spawn that names its own cwd is checked there, not at the session',
    async ($, on) => {
      const asked: unknown[] = []
      const prompts: string[] = []

      on('session.cwd', () => ({ value: PARENT }))
      on('process.run', ($, e) => {
        asked.push(e)
        return { value: { exitCode: 0, stdout: `${CHECKOUT}\n`, stderr: '' } }
      })
      on('agent.spawn', ($, e) => {
        prompts.push(e.prompt)
        return { model: 'sonnet', agentId: 'agent-3' }
      })

      await $.agent.spawn(
        Fixtures.spawnInputOf({ prompt: 'audit the checkout', cwd: CHECKOUT }),
      )

      expect(asked).toHaveLength(1)
      const given = prompts[0] ?? ''
      expect(given).toContain(CHECKOUT)
      expect(given).toContain('IS inside a git repository')
    },
  )
})
