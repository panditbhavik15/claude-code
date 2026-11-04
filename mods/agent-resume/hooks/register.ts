import type { AgentSpawnInput, EngineInterface, On, ToolCallResult } from 'claude-code'

/**
 * What `agent.spawn` gave a subagent, kept so the same task can be started
 * again: exactly the fields `$.agent.spawn` can be handed back.
 */
type Origin = Pick<
  AgentSpawnInput,
  'prompt' | 'description' | 'subagentType' | 'model' | 'cwd'
>

/** What one `SendMessage` hook can answer for. */
type Answer = ToolCallResult<'SendMessage'>

/**
 * What this session knows of the subagents it has seen started.
 *
 * Held by `register` and passed to `repair` as data, because the hooks loader
 * lets `$` be used only at a `$.noun.event(...)` call site: the engine itself
 * never travels into a helper.
 */
type Ledger = {
  /** What each started subagent was given, by every address it answers to. */
  origins: Map<string, Origin>
  /** Addresses this mod started, so a stopped one is not restarted in a chain. */
  restarted: Set<string>
}

/**
 * The fragments of the engine's refusal to speak to an agent that was stopped.
 *
 * Read out of the shipped 2.1.317 bundle, where the resume path throws
 * `Agent ${id} was stopped by the user and won't be resumed. Treat its work as
 * cancelled; only launch a new agent if the user explicitly asks.` and, once
 * the session no longer tracks the id, `…so the agent cannot be resumed.` The
 * bug report quotes the model-facing wording as "was stopped by the user and
 * was not resumed", so all three spellings are matched.
 */
const STOPPED = ['stopped by the user', 'not be resumed', 'cannot be resumed']

/** True when `text` is one of the engine's stopped-agent refusals. */
function isStoppedRefusal(text: string): boolean {
  return STOPPED.some((fragment) => text.includes(fragment))
}

/**
 * The prompt of the replacement run.
 *
 * Honest about what it is: not the stopped agent, and not carrying what that
 * agent learned. An agent that believes it continues a finished run repeats
 * work with side effects, which is worse than the dead-end this mod fixes.
 *
 * @param origin what the stopped agent was started with
 * @param message the delivery that found it stopped
 */
function continuationOf(origin: Origin, message: string): string {
  return [
    `[agent-resume] You are a NEW run of a task whose previous agent was ` +
      `stopped. Nothing that agent learned, read, or changed came across with ` +
      `you: treat its work as unknown, and check the current state of anything ` +
      `before repeating an action with side effects.`,
    `The task, as it was originally given:\n${origin.prompt}`,
    `The message that arrived while the earlier run was found stopped, and is ` +
      `now yours to act on:\n${message}`,
  ].join('\n\n')
}

/**
 * The note that goes with a delivered repair: what happened, and where to send
 * the next message.
 *
 * @param target what the model addressed
 * @param name the replacement's address
 * @param agentId its id, where the engine gave one
 */
function resumedNote(target: string, name: string, agentId?: string): string {
  return (
    `[agent-resume] "${target}" was stopped, so core would not deliver to it. ` +
    `This mod started the same task again as a fresh agent addressed "${name}"` +
    `${agentId === undefined ? '' : ` (id ${agentId})`} and delivered your ` +
    `message there. It is a NEW agent: the stopped one's findings are not in ` +
    `it, as its first prompt says. Address later messages to "${name}", not to ` +
    `"${target}".`
  )
}

/**
 * The note for a repair that could not be made, so core's refusal is explained
 * rather than papered over.
 *
 * @param target what the model addressed
 * @param why what stood in the way
 */
function refusedNote(target: string, why: string): string {
  return (
    `[agent-resume] "${target}" was stopped and this mod did not restart the ` +
    `task for it: ${why}. The refusal above stands — do not assume the message ` +
    `was delivered. If the work is still wanted, start an Agent of your own ` +
    `with the task and what you know of its progress.`
  )
}

/**
 * Core's refusal, handed back untouched, with the reason no repair was made.
 *
 * @param target what the model addressed
 * @param text core's refusal text
 * @param why what stood in the way
 * @returns the errored answer the model reads
 */
function asRefused(target: string, text: string, why: string): Answer {
  return { result: text, text, isError: true, context: [refusedNote(target, why)] }
}

/**
 * Re-starts the stopped task, delivers the message to it, and answers with what
 * that delivery returned.
 *
 * A top-level declaration rather than a closure: the hooks loader follows `$`
 * only where a hook calls `$.noun.event(...)` itself.
 *
 * @param $ the engine
 * @param ledger what this session has seen started
 * @param target the address the model used
 * @param message the delivery that found the target stopped
 * @param text core's refusal, handed back when the repair fails
 * @param summary the model's own label for its row, passed on
 */
export async function repair(
  $: EngineInterface,
  ledger: Ledger,
  target: string,
  message: string,
  text: string,
  summary?: string,
): Promise<Answer> {
  if (ledger.restarted.has(target)) {
    return asRefused(
      target,
      text,
      'it is already a restart this mod made, and restarts are not chained',
    )
  }

  const origin = ledger.origins.get(target)
  if (origin === undefined) {
    return asRefused(
      target,
      text,
      'no spawn of this session recorded that address, so there is no task to ' +
        'start again',
    )
  }

  const name = `${target}-resumed`
  const started = await $
    .agent.spawn({
      prompt: continuationOf(origin, message),
      description: origin.description,
      subagentType: origin.subagentType,
      model: origin.model,
      cwd: origin.cwd,
      name,
    })
    .catch(() => undefined)

  // A spawn that is not refused is one the Agent tool took: `agentId` is set by
  // core and a hook that answers without `next` has started none, so the id is
  // reported when it is there and never required to be.
  if (started === undefined || started.deny !== undefined) {
    return asRefused(
      target,
      text,
      started?.deny ?? 'the Agent tool refused or failed to start the replacement',
    )
  }

  const agentId = started.agentId
  ledger.restarted.add(name)
  if (agentId !== undefined) ledger.restarted.add(agentId)

  // Deliver through the tool itself: for a live agent the engine's own answer
  // is the record shape the model expects, so nothing here has to be guessed.
  const delivered = await $
    .tool.call({ tool: 'SendMessage', to: name, message, summary })
    .catch(() => undefined)

  if (
    delivered === undefined ||
    delivered.deny !== undefined ||
    delivered.isError === true
  ) {
    return asRefused(
      target,
      text,
      'the replacement started, but the message was not delivered to it',
    )
  }

  return {
    ...delivered,
    context: [
      ...(delivered.context ?? []),
      resumedNote(target, name, agentId),
    ],
  }
}

/**
 * Registers the stopped-agent carry-over for one session.
 *
 * Two hooks. `agent.spawn` records what each subagent was started with, keyed
 * by both its `name` (what `SendMessage` addresses) and the `agentId` core
 * gives back. `tool.call` on `SendMessage` lets core answer first — core does
 * carry on with a finished agent, and only refuses one stopped by the user —
 * and when core's answer says stopped, `repair` re-starts that recorded task
 * and delivers the message to the new agent through a second `SendMessage`.
 *
 * @param on the engine's registrar
 */
export function register(on: On): void {
  const ledger: Ledger = { origins: new Map(), restarted: new Set() }

  on('agent.spawn', async ($, e, next) => {
    const answer = await next(e)
    const origin: Origin = {
      prompt: e.prompt,
      description: e.description,
      subagentType: e.subagentType,
      model: e.model,
      cwd: e.cwd,
    }
    // Keyed twice on purpose: a named agent is addressed by its name, and the
    // same agent by its id, which is what a background agent's row shows. A
    // refused spawn started nothing, so it is not recorded at all.
    if (answer.deny === undefined && e.name !== undefined) {
      ledger.origins.set(e.name, origin)
      if (answer.agentId !== undefined) ledger.origins.set(answer.agentId, origin)
    }
    return answer
  })

  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    const target = String(e.to ?? '')
    const message = e.message

    let answer: Answer

    try {
      answer = await next(e)
    } catch (error) {
      // Core's resume path throws instead of returning an error result; the
      // engine turns that into the tool's error, so both shapes are possible.
      const text = error instanceof Error ? error.message : String(error)
      if (!isStoppedRefusal(text)) throw error
      return repair($, ledger, target, message, text, e.summary)
    }

    if (answer.isError !== true) return answer
    const text = String(answer.text ?? '')
    if (!isStoppedRefusal(text)) return answer
    return repair($, ledger, target, message, text, e.summary)
  })
}
