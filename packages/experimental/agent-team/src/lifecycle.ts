/** Shared admission cutoff and abort-grace cleanup for the Team runtime. */

import { TeamError } from './error.ts'

/** Owns the single Team runtime cancellation fact and cleanup abort grace period. */
export class TeamRuntimeLifecycle {
  private readonly controller = new AbortController()

  /**
   * @param disposalTimeoutMs - grace period before an interruptible native cleanup is aborted.
   */
  constructor(private readonly disposalTimeoutMs: number) {}

  /** Signal aborted exactly when Team runtime admission closes. */
  get signal(): AbortSignal {
    return this.controller.signal
  }

  /** Whether Team runtime admission is closed. */
  get disposed(): boolean {
    return this.signal.aborted
  }

  /** The exact cancellation reason used to distinguish expected disposal rejection. */
  get reason(): unknown {
    const reason: unknown = this.signal.reason
    return reason
  }

  /** Whether a rejection is the runtime cancellation, directly or through an Error cause chain. */
  private isCancellation(reason: unknown): boolean {
    const seen = new Set<unknown>()
    let current = reason
    while (!seen.has(current)) {
      if (this.disposed && current === this.reason) return true
      if (this.disposed && current instanceof TeamError && current.code === 'TEAM_DISPOSED') return true
      if (!(current instanceof Error)) return false
      seen.add(current)
      current = current.cause
    }
    return false
  }

  /** Close Team runtime admission and cancel admitted interruptible work. */
  close(): void {
    this.controller.abort(new TeamError('Agent Teams service disposed', 'TEAM_DISPOSED'))
  }

  /**
   * Await admitted operations and retain failures other than runtime cancellation.
   * @param operations - admitted operations captured after the admission cutoff.
   * @param failures - aggregate destination for unexpected rejection.
   */
  async settle(operations: readonly Promise<unknown>[], failures: unknown[]): Promise<void> {
    if (operations.length === 0) return
    const outcomes = await Promise.allSettled(operations)
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected' && !this.isCancellation(outcome.reason)) failures.push(outcome.reason)
    }
  }

  /**
   * Abort cleanup at the configured deadline but keep awaiting real settlement.
   * @param operation - cleanup operation that must reach quiescence before return.
   * @returns the cleanup result after it actually settles.
   */
  async settleWithAbortDeadline<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort(new TeamError(
        `Agent Teams runtime disposal exceeded ${this.disposalTimeoutMs}ms`,
        'TEAM_DISPOSAL_TIMEOUT',
      ))
    }, this.disposalTimeoutMs)
    try {
      return await operation(controller.signal)
    } finally {
      clearTimeout(timer)
    }
  }
}
