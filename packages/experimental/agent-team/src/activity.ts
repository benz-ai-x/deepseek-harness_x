/** Team change waiters and bounded followers independent of durable state projection. */

import type { TeamId, TeamView, TeamWaitResult, TeamWatchFrame } from './types.ts'
import { errorMessage, TeamError } from './error.ts'

interface Waiter {
  readonly resolve: () => void
}

/** Owns current Team change waiters and releases each at most once. */
export class TeamActivity {
  private readonly waiters = new Map<TeamId, Set<Waiter>>()
  private readonly followers = new Map<TeamId, Set<TeamFollower>>()
  private closed = false

  /**
   * Open one projection generation after synchronously registering its invalidation follower.
   * @param id - Team whose committed changes invalidate the projection.
   * @param baseline - exact authoritative projection read after follower registration.
   * @param signal - generation cancellation.
   * @returns one complete baseline followed by coalesced invalidations.
   */
  async *follow(id: TeamId, baseline: () => TeamView, signal: AbortSignal): AsyncIterable<TeamWatchFrame> {
    signal.throwIfAborted()
    if (this.closed) return
    const follower = new TeamFollower()
    let followers = this.followers.get(id)
    if (followers === undefined) {
      followers = new Set()
      this.followers.set(id, followers)
    }
    followers.add(follower)
    try {
      yield { type: 'baseline', value: baseline() }
      yield* follower.read(signal)
    } finally {
      followers.delete(follower)
      if (followers.size === 0) this.followers.delete(id)
      follower.close()
    }
  }

  /**
   * Wait for one later Team-domain or member-status change.
   * @param id - Team whose next edge wakes the caller.
   * @param timeoutMs - bounded wait duration from ten seconds through one hour.
   * @param signal - caller cancellation for this wait only.
   * @returns whether the wait ended by timeout.
   */
  async wait(id: TeamId, timeoutMs: number, signal: AbortSignal): Promise<TeamWaitResult> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 3_600_000) {
      throw new TeamError('timeoutMs must be an integer from 10000 through 3600000', 'TEAM_INVALID_TIMEOUT')
    }
    signal.throwIfAborted()
    if (this.closed) return { timedOut: false }
    const changed = await new Promise<boolean>((resolve, reject) => {
      let waiters = this.waiters.get(id)
      if (waiters === undefined) {
        waiters = new Set()
        this.waiters.set(id, waiters)
      }
      let settled = false
      const finish = (settle: () => void): void => {
        /* v8 ignore next -- timeout, abort, and notification may race after one winner removes the others. */
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        waiters.delete(waiter)
        if (waiters.size === 0) this.waiters.delete(id)
        settle()
      }
      const onAbort = (): void => {
        finish(() => {
          const reason: unknown = signal.reason
          reject(reason instanceof Error
            ? reason
            : new TeamError(`wait_agent aborted: ${errorMessage(reason)}`, 'TEAM_WAIT_ABORTED'))
        })
      }
      const waiter: Waiter = {
        resolve: () => {
          finish(() => { resolve(true) })
        },
      }
      waiters.add(waiter)
      const timer = setTimeout(() => { finish(() => { resolve(false) }) }, timeoutMs)
      signal.addEventListener('abort', onAbort, { once: true })
      // AbortSignal does not replay an abort that wins between the pre-check and listener registration.
      /* v8 ignore next -- requires an abort in the synchronous gap between the pre-check and listener registration. */
      if (signal.aborted) onAbort()
    })
    return { timedOut: !changed }
  }

  /**
   * Wake and remove every current waiter for one Team.
   * @param id - Team whose current waiters observe the change.
   */
  notify(id: TeamId): void {
    const waiters = this.waiters.get(id)
    if (waiters !== undefined) {
      this.waiters.delete(id)
      for (const waiter of waiters) waiter.resolve()
    }
    const followers = this.followers.get(id)
    if (followers !== undefined) {
      for (const follower of followers) follower.invalidate()
    }
  }

  /** Close admission and wake every current waiter during runtime disposal. */
  close(): void {
    this.closed = true
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) waiter.resolve()
    }
    this.waiters.clear()
    for (const followers of this.followers.values()) {
      for (const follower of followers) follower.close()
    }
    this.followers.clear()
  }
}

/** One stream generation retaining at most one pending invalidation. */
class TeamFollower {
  private invalidated = false
  private waiting: (() => void) | undefined
  private closed = false

  invalidate(): void {
    if (this.closed) return
    this.invalidated = true
    this.waiting?.()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.waiting?.()
  }

  async *read(signal: AbortSignal): AsyncIterable<TeamWatchFrame> {
    while (!this.closed && !signal.aborted) {
      if (this.invalidated) {
        this.invalidated = false
        yield { type: 'invalidated' }
        continue
      }
      await this.wait(signal)
    }
  }

  private wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        signal.removeEventListener('abort', finish)
        /* v8 ignore next -- one read owns the sole installed wait callback. */
        if (this.waiting === finish) this.waiting = undefined
        resolve()
      }
      this.waiting = finish
      signal.addEventListener('abort', finish, { once: true })
      /* v8 ignore next -- signal and pending bit cannot change during this synchronous setup. */
      if (signal.aborted || this.closed || this.invalidated) finish()
    })
  }
}
