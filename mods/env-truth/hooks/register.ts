import type { EngineInterface, On } from 'claude-code'

/**
 * A repository's root as `git rev-parse --show-toplevel` reports it, or null
 * when the directory asked about is not inside one.
 */
type Root = string | null

/**
 * The line that replaces the unverified banner field for one subagent.
 *
 * Named as a check the agent can act on, not as an instruction file, so it
 * reads as a fact about the directory it was computed in.
 *
 * @param cwd the directory the subagent runs in, verified now
 * @param root its repository's root, or null when it has none
 */
function noteOf(cwd: string, root: Root): string {
  return (
    '\n\n[env-truth] Environment check for the directory you run in, taken at ' +
    `spawn time: ${cwd} ` +
    (root === null
      ? 'is NOT inside a git repository. The session banner\'s "Is a git ' +
        'repository" field can name a different directory (a stale ' +
        'session-start value); on this point, trust this check, not that ' +
        'field. Do not run git commands here expecting them to succeed, and ' +
        'do not skip git checks on the strength of that field either.'
      : `IS inside a git repository (root: ${root}). The session banner's ` +
        '"Is a git repository" field can name a different directory (a stale ' +
        'session-start value); on this point, trust this check, not that ' +
        'field, and run your git work with this repository as its target.')
  )
}

/**
 * The repository root of `cwd`, or null when git says it is not inside one.
 *
 * Asked of git in `cwd` itself, which is the point: the engine's session repo
 * notion is read from the session, not from the directory a subagent was sent
 * to, so a second answer is needed. A command that cannot start, or times out,
 * reads as no repository rather than a false claim of one.
 *
 * @param $ the engine
 * @param cwd the directory to ask about
 */
async function rootOf($: EngineInterface, cwd: string): Promise<Root> {
  try {
    const { exitCode, stdout } = await $.process.run(
      ['git', 'rev-parse', '--show-toplevel'],
      { cwd },
    )
    if (exitCode !== 0) return null
    const root = stdout.trim()
    return root === '' ? null : root
  } catch {
    return null
  }
}

/**
 * Registers the environment check for every subagent this session starts.
 *
 * One hook, on `agent.spawn`: it resolves the directory the subagent will
 * actually run in (the call's own `cwd`, else the session's), asks git there,
 * and hands the answer down inside the spawn's `prompt`, where the subagent
 * reads it before it trusts anything its banner says.
 *
 * @param on the engine's registrar
 */
export function register(on: On): void {
  on('agent.spawn', async ($, e, next) => {
    const cwd = e.cwd ?? (await $.session.cwd())
    const root = await rootOf($, cwd)
    return next({ ...e, cwd, prompt: `${e.prompt}${noteOf(cwd, root)}` })
  })
}
