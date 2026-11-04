import type { On } from 'claude-code'

import { describe, expect, test, tier } from 'claude-code/testing'

import Fixtures from './fixtures'

tier('builtin')

/** The address of the agent the user stopped, as the model knows it. */
const DEAD = 'plugin-auditor'

/** The address the mod gives the replacement run. */
const RESUMED = 'plugin-auditor-resumed'

/** The message that found the target stopped. */
const MESSAGE = 'also audit the hooks folder'

/**
 * Core's refusal, in the words the shipped 2.1.317 bundle builds it in.
 */
const STOPPED_TEXT = `Agent ${DEAD} was stopped by the user and won't be resumed. Treat its work as cancelled; only launch a new agent if the user explicitly asks.`

/** One spawn the Agent tool was asked for, as the seat saw it. */
type Started = {
  prompt: string
  type?: string
  model?: string
  cwd?: string
  name?: string
}

/**
 * The agent type as a seat sees it.
 *
 * A test's own `$.agent.spawn` of a whole `AgentSpawnInput` arrives with
 * `subagentType`; a plugin's spawn of the same field arrives spelled as the
 * Agent tool spells it, `subagent_type` — the engine turns a plugin's args
 * back into the tool's own parameters before dispatching `agent.spawn`. Both
 * spellings are read so the assertion is about what the mod asked for.
 *
 * @param e the spawn input the seat got
 */
function typeOf(e: { subagentType?: string; subagent_type?: string }): string | undefined {
  return e.subagentType ?? e.subagent_type
}

/**
 * Seats the engine beneath the mod: an Agent tool that starts one agent per
 * call, and a SendMessage that refuses every address in `stops` and delivers to
 * the rest.
 *
 * `stops` is a live list, so a test can have an agent go stopped partway
 * through, which is what the bug report does.
 *
 * @param on the test's registrar
 * @param stops the addresses core reports as stopped, to start with
 * @param denyFor the name whose spawn core refuses
 */
function seatOf(on: On, stops: string[], denyFor?: string) {
  /** Every spawn the Agent tool was asked for, the test's own included. */
  const spawned: Started[] = []

  /** Every address a SendMessage reached core with, in order. */
  const sent: string[] = []

  let ids = 0

  on('agent.spawn', ($, e) => {
    spawned.push({
      prompt: e.prompt,
      type: typeOf(e as { subagentType?: string; subagent_type?: string }),
      model: e.model,
      cwd: e.cwd,
      name: e.name,
    })
    if (denyFor !== undefined && e.name === denyFor) {
      return { deny: 'background agents are switched off in this session' }
    }
    return { model: e.model ?? 'sonnet', agentId: `agent-${(ids += 1)}` }
  })

  on('tool.call', ($, e) => {
    if (e.tool !== 'SendMessage') return { result: 'not this tool' }
    const to = String(e.to)
    sent.push(to)
    return stops.includes(to)
      ? { result: to, text: STOPPED_TEXT.replace(DEAD, to), isError: true as const }
      : { result: { delivered: to } }
  })

  return { spawned, sent, stops }
}

describe('register', () => {
  test(
    'a message to an agent the user stopped reaches a fresh run of the same ' +
      'task, and the model is told it is a fresh run',
    async ($, on) => {
      const { spawned, sent } = seatOf(on, [DEAD])
      await $.agent.spawn(Fixtures.spawnInputOf({}))

      const answer = await $.tool.call({ tool: 'SendMessage', to: DEAD, message: MESSAGE })

      expect(answer.isError).toBeUndefined()
      expect(sent).toEqual([DEAD, RESUMED])
      expect(spawned.map((one) => one.name)).toEqual([DEAD, RESUMED])
      expect(spawned[1]?.prompt).toContain('NEW run')
      expect(spawned[1]?.prompt).toContain('audit the plugins in this directory')
      expect(spawned[1]?.prompt).toContain(MESSAGE)
      const notes = (answer.context ?? []).join(' ')
      expect(notes).toContain(RESUMED)
      expect(notes).toContain('It is a NEW agent')
    },
  )

  test(
    'core is asked first: an agent core still carries on with is left to core, ' +
      'and nothing is started',
    async ($, on) => {
      const { spawned, sent } = seatOf(on, [])
      await $.agent.spawn(Fixtures.spawnInputOf({}))

      const answer = await $.tool.call({ tool: 'SendMessage', to: DEAD, message: MESSAGE })

      expect(answer.result).toEqual({ delivered: DEAD })
      expect(sent).toEqual([DEAD])
      expect(spawned).toHaveLength(1)
    },
  )

  test(
    'an address no spawn of this session recorded keeps core’s refusal, ' +
      'explained rather than replaced',
    async ($, on) => {
      const { spawned } = seatOf(on, ['someone-elses-agent'])

      const answer = await $.tool.call({
        tool: 'SendMessage',
        to: 'someone-elses-agent',
        message: MESSAGE,
      })

      expect(answer.isError).toBe(true)
      expect(answer.text).toBe(STOPPED_TEXT.replace(DEAD, 'someone-elses-agent'))
      expect(spawned).toHaveLength(0)
      expect((answer.context ?? []).join(' ')).toContain('no spawn of this session')
    },
  )

  test(
    'a replacement the Agent tool refuses leaves the refusal standing, with ' +
      'the reason beside it',
    async ($, on) => {
      const { sent } = seatOf(on, [DEAD], RESUMED)
      await $.agent.spawn(Fixtures.spawnInputOf({}))

      const answer = await $.tool.call({ tool: 'SendMessage', to: DEAD, message: MESSAGE })

      expect(answer.isError).toBe(true)
      expect(answer.text).toContain("won't be resumed")
      expect(sent).toEqual([DEAD])
      expect((answer.context ?? []).join(' ')).toContain(
        'background agents are switched off',
      )
    },
  )

  test(
    'a restart this mod made is not restarted again, so a second stop ends ' +
      'the chain instead of spawning forever',
    async ($, on) => {
      const { spawned, sent, stops } = seatOf(on, [DEAD])
      await $.agent.spawn(Fixtures.spawnInputOf({}))

      const first = await $.tool.call({ tool: 'SendMessage', to: DEAD, message: MESSAGE })
      stops.push(RESUMED)
      const second = await $.tool.call({
        tool: 'SendMessage',
        to: RESUMED,
        message: 'and again',
      })

      expect(first.isError).toBeUndefined()
      expect(second.isError).toBe(true)
      expect(spawned.map((one) => one.name)).toEqual([DEAD, RESUMED])
      // Dead address, the delivery to the replacement, then the second address
      // the test itself sent: three calls reach core, one restart is made.
      expect(sent).toEqual([DEAD, RESUMED, RESUMED])
      expect((second.context ?? []).join(' ')).toContain('already a restart')
    },
  )

  test(
    'the replacement is the same task: the stopped agent’s type, model and ' +
      'directory carry over',
    async ($, on) => {
      const { spawned } = seatOf(on, [DEAD])
      await $.agent.spawn(
        Fixtures.spawnInputOf({ model: 'haiku', cwd: '/home/wintery/other' }),
      )

      await $.tool.call({ tool: 'SendMessage', to: DEAD, message: MESSAGE })

      expect(spawned[1]?.type).toBe('general-purpose')
      expect(spawned[1]?.model).toBe('haiku')
      expect(spawned[1]?.cwd).toBe('/home/wintery/other')
      expect(spawned[1]?.name).toBe(RESUMED)
    },
  )

  test(
    'an address given as the agent id resumes the same run, because the ' +
      'ledger keys both spellings',
    async ($, on) => {
      const { spawned, sent } = seatOf(on, ['agent-1'])
      await $.agent.spawn(Fixtures.spawnInputOf({}))

      const answer = await $.tool.call({
        tool: 'SendMessage',
        to: 'agent-1',
        message: MESSAGE,
      })

      expect(answer.isError).toBeUndefined()
      expect(sent).toEqual(['agent-1', 'agent-1-resumed'])
      expect(spawned).toHaveLength(2)
      expect((answer.context ?? []).join(' ')).toContain('agent-1-resumed')
    },
  )

  test(
    'a SendMessage that failed for a reason that is not a stopped agent is ' +
      'passed back exactly as core answered it',
    async ($, on) => {
      const { spawned, sent } = seatOf(on, [])
      await $.agent.spawn(Fixtures.spawnInputOf({}))

      const answer = await $.tool.call({
        tool: 'SendMessage',
        to: DEAD,
        message: MESSAGE,
      })

      expect(spawned).toHaveLength(1)
      expect(sent).toEqual([DEAD])
      expect(answer.context).toBeUndefined()
    },
  )
})
