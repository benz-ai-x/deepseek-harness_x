/** Shared browser-only ownership of task-panel and child-view watch controls. */

/** One watch whose disposal settles after its transport and consumer stop. */
export interface TeamWatchControl {
  /** Begin consuming the watch. */
  start(): void
  /**
   * Stop the watch and await its admitted work.
   * @returns completion after the transport and consumer stop.
   */
  dispose(): Promise<void>
}

/** Retain watch closes until the contributing Client registration can await them. */
export interface TeamWatchOwner {
  /**
   * Transfer a watch to this registration; an already closed owner closes it immediately.
   * @param control - watch whose transport lifetime belongs to this registration.
   * @returns idempotent control whose close failures are reported by the owner.
   */
  own(control: TeamWatchControl): TeamWatchControl
  /**
   * Close admission and await live and already-closing watches.
   * @returns completion that rejects with one original error or an AggregateError after all closes settle.
   */
  dispose(): Promise<void>
}

/**
 * Share watch disposal between synchronous React cleanup and awaitable Cordis teardown.
 * @returns one registration's owner, with no Team data or Remote registration of its own.
 */
export function createTeamWatchOwner(): TeamWatchOwner {
  const controls = new Set<TeamWatchControl>()
  const pending = new Set<Promise<void>>()
  const failures: unknown[] = []
  let accepting = true
  return {
    own(control) {
      let completion: Promise<void> | undefined
      let disposed = false
      const owned: TeamWatchControl = {
        start() {
          if (!disposed) control.start()
        },
        dispose(): Promise<void> {
          if (completion !== undefined) return completion
          disposed = true
          controls.delete(owned)
          const closing = control.dispose()
          const observed = closing.catch((error: unknown) => { failures.push(error) })
          completion = observed
          pending.add(observed)
          void observed.then(() => { pending.delete(observed) })
          return observed
        },
      }
      if (accepting) controls.add(owned)
      else void owned.dispose()
      return owned
    },
    async dispose() {
      accepting = false
      for (const control of [...controls]) void control.dispose()
      await Promise.all([...pending])
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'Team watch controls failed to dispose')
    },
  }
}
