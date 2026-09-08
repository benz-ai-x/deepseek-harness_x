import { describe, expect, it, vi } from 'vitest'
import { createTeamWatchOwner } from '../src/client/watch-owner.ts'

describe('Team watch ownership', () => {
  it('awaits a component-triggered close together with still-live controls', async () => {
    const release = Promise.withResolvers<undefined>()
    const first = { start: vi.fn(), dispose: vi.fn(() => release.promise) }
    const second = { start: vi.fn(), dispose: vi.fn(() => Promise.resolve()) }
    const owner = createTeamWatchOwner()
    const firstControl = owner.own(first)
    const secondControl = owner.own(second)
    firstControl.start()
    secondControl.start()
    const firstClose = firstControl.dispose()
    let settled = false
    const closing = owner.dispose().then(() => { settled = true })
    try {
      expect(firstControl.dispose()).toBe(firstClose)
      firstControl.start()
      secondControl.start()
      expect(first.start).toHaveBeenCalledOnce()
      expect(second.start).toHaveBeenCalledOnce()
      expect(first.dispose).toHaveBeenCalledOnce()
      expect(second.dispose).toHaveBeenCalledOnce()
      await Promise.resolve()
      expect(settled).toBe(false)
    } finally {
      release.resolve(undefined)
      await closing
    }
    expect(settled).toBe(true)
    await owner.dispose()
    expect(first.dispose).toHaveBeenCalledOnce()
    expect(second.dispose).toHaveBeenCalledOnce()
  })

  it.each([1, 2])('reports %i close failures at the owner after every control stops', async (count) => {
    const owner = createTeamWatchOwner()
    const failures = Array.from({ length: count }, (_, index) => new Error(`transport ${index} failed`))
    const controls = failures.map(error => owner.own({
      start() {},
      dispose: () => Promise.reject(error),
    }))
    await Promise.all(controls.map(control => control.dispose()))
    if (count === 1) {
      await expect(owner.dispose()).rejects.toBe(failures[0])
    } else {
      await expect(owner.dispose()).rejects.toMatchObject({ errors: failures })
    }
  })

  it('immediately closes a watch retained by an already disposed registration', async () => {
    const owner = createTeamWatchOwner()
    await owner.dispose()
    const control = { start: vi.fn(), dispose: vi.fn(() => Promise.resolve()) }
    const retired = owner.own(control)
    retired.start()
    expect(control.start).not.toHaveBeenCalled()
    expect(control.dispose).toHaveBeenCalledOnce()
    await retired.dispose()
    await owner.dispose()
    expect(control.dispose).toHaveBeenCalledOnce()
  })
})
