/**
 * HATEOAS-style response envelope for agent consumers.
 * Every command returns this shape — agents always know what to do next.
 */

export interface NextAction {
  readonly command: string
  readonly description: string
}

export interface IgsResponse {
  readonly ok: boolean
  readonly command: string
  readonly result: unknown
  readonly next_actions: readonly NextAction[]
}

export const respond = (
  command: string,
  result: unknown,
  nextActions: readonly NextAction[],
  ok = true
): string =>
  JSON.stringify(
    {
      ok,
      command: `igs ${command}`,
      result,
      next_actions: nextActions,
    } satisfies IgsResponse,
    null,
    2
  )
