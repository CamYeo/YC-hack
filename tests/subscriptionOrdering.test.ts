import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadHackathonConfig } from '../server/config/hackathonConfig'
import { createReasoner } from '../server/agents/reasoner'
import type { Reasoner } from '../server/agents/types'
import { createMemoryRelay } from '../server/providers/relay/memoryRelay'
import { createMemoryRoomStore } from '../server/seminar/memoryRoomStore'
import { SeminarService } from '../server/seminar/service'
import type { PublicRoomState } from '../actor/src/roomTypes'
import type { ServerMessage } from '../shared/contracts'

type Speak = Extract<ServerMessage, { type: 'speak' }>
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function waitFor<T>(read: () => T | undefined, label: string): Promise<T> {
  const deadline = Date.now() + 2500
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function harness(reasoner = createReasoner(null), releasePending = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'apprentice-subscription-order-'))
  const memory = createMemoryRoomStore()
  const listeners = new Set<(state: PublicRoomState) => void>()
  // Actor transport and Relay are deliberately independent: tests decide when snapshots arrive.
  const store = { ...memory, async subscribe(_roomId: string, callback: (state: PublicRoomState) => void) {
    listeners.add(callback)
    return () => { listeners.delete(callback) }
  } }
  const service = new SeminarService(loadHackathonConfig(root), store, createMemoryRelay(), { reasoner })
  cleanups.push(async () => { releasePending(); await service.stop(); rmSync(root, { recursive: true, force: true }) })
  const messages: ServerMessage[] = []
  await service.start()
  const room = await service.createRoom({ topicId: 'swe-retries', category: 'software-engineering', format: 'socratic', theme: 'classroom', difficulty: 'intermediate', participation: 'participate', customQuestion: null, reading: null })
  await service.connect(room.roomId, room.roomToken, { send: data => messages.push(JSON.parse(data) as ServerMessage), close() {} })
  const snapshot = async () => {
    const { processedEventKeys: _processed, pendingOutbound: _outbox, ...state } = await store.getSnapshot(room.roomId)
    return state
  }
  const publish = (state: PublicRoomState) => { for (const listener of listeners) listener(structuredClone(state)) }
  return { service, store, room, messages, snapshot, publish }
}

test('a delayed actor snapshot preserves reasoning already started in that same epoch', async () => {
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  let reasoning: { signal: AbortSignal; epoch: number } | undefined
  const fixture = createReasoner(null)
  const reasoner: Reasoner = { ...fixture, async propose(context, signal) {
    reasoning = { signal, epoch: context.generationEpoch }
    await gate
    return fixture.propose(context, signal)
  } }
  const h = await harness(reasoner, release)
  const previous = await h.snapshot()
  h.publish(previous)

  // The new-epoch Relay event reaches the worker before its actor socket update does.
  await h.service.handle(h.room.roomId, { type: 'human.contribution', eventId: 'new-epoch-question', text: 'A missing response might hide a successful charge.', inputMode: 'text', replyToContributionId: null, addressedTo: 'maya' })
  const currentWork = await waitFor(() => reasoning, 'new-epoch reasoning')
  const delayedSnapshot = await h.snapshot()
  expect(currentWork.epoch).toBeGreaterThan(previous.generationEpoch)
  expect(currentWork.epoch).toBe(delayedSnapshot.generationEpoch)
  h.publish(delayedSnapshot)

  // Current work must survive observing its own epoch; old work still needs cancellation.
  expect(currentWork.signal.aborted).toBe(false)
  release()
  const speech = await waitFor(() => h.messages.find((message): message is Speak => message.type === 'speak'), 'approved current-epoch speech')
  expect(speech.speakerId).toBe('maya')
  expect(speech.generationEpoch).toBe(currentWork.epoch)
  expect((await h.snapshot()).floor?.utteranceId).toBe(speech.utteranceId)
})

test('a stale actor snapshot cannot roll the browser back after a newer snapshot', async () => {
  const h = await harness()
  const stale = await h.snapshot()
  h.publish(stale)
  await h.store.pauseSession(h.room.roomId, 'speaker-timeout')
  const current = await h.snapshot()
  h.publish(current)
  expect(current.generationEpoch).toBeGreaterThan(stale.generationEpoch)
  expect(h.messages.some(message => message.type === 'snapshot' && message.state.phase === 'paused' && message.state.generationEpoch === current.generationEpoch)).toBe(true)

  // A previously initiated polling read may return after the actor socket has delivered current.
  const beforeStaleDelivery = h.messages.length
  h.publish(stale)
  await Promise.resolve()
  const emittedAfterStale = h.messages.slice(beforeStaleDelivery)
  expect(emittedAfterStale.some(message => message.type === 'snapshot' && message.state.generationEpoch < current.generationEpoch)).toBe(false)
  expect(emittedAfterStale.some(message => message.type === 'stop' && message.generationEpoch < current.generationEpoch)).toBe(false)
  const latest = h.messages.filter((message): message is Extract<ServerMessage, { type: 'snapshot' }> => message.type === 'snapshot').at(-1)
  expect(latest?.state.phase).toBe('paused')
  expect(latest?.state.version).toBe(current.version)
})
