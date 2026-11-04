import type { AgentSpawnInput } from 'claude-code'

/**
 * One subagent spawn, as the Agent tool hands it to `agent.spawn`.
 *
 * The engine's own input type is complete, so a test sets what it cares about
 * (`prompt`, `name`, `model`, `cwd`) over this one whole call.
 *
 * @param over the fields this test cares about
 */
export function spawnInputOf(over: Partial<AgentSpawnInput>): AgentSpawnInput {
  return {
    tool_use_id: 'toolu_test',
    prompt: 'audit the plugins in this directory',
    description: 'audit plugins',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'sonnet',
    background: true,
    fork: false,
    name: 'plugin-auditor',
    ...over,
  }
}
