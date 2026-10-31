import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryRoomStore } from '../server/seminar/memoryRoomStore'
import { createMemoryRelay } from '../server/providers/relay/memoryRelay'
import { loadHackathonConfig } from '../server/config/hackathonConfig'
import { SeminarService } from '../server/seminar/service'
import type { PublicRoomState } from '../actor/src/roomTypes'
import type { ServerMessage } from '../shared/contracts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
const wait = async <T>(read: () => T | undefined, label: string): Promise<T> => {
  const until = Date.now() + 6000
  while (Date.now() < until) { const value = read(); if (value !== undefined) return value; await Bun.sleep(20) }
  throw new Error(`Timed out: ${label}`)
}

test('coordinator cannot generate a turn; separate role workers deliver proposals through Relay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'apprentice-workers-'))
  const store = createMemoryRoomStore(), relay = createMemoryRelay(), config = loadHackathonConfig(root)
  const coordinator = new SeminarService(config, store, relay, { role: 'coordinator' })
  const facilitator = new SeminarService(config, store, relay, { role: 'facilitator' })
  const peer = new SeminarService(config, store, relay, { role: 'maya' })
  cleanup.push(async () => { await Promise.all([coordinator.stop(), facilitator.stop(), peer.stop()]); rmSync(root, { recursive: true, force: true }) })
  // Workers start before room creation, as they do in the dev launcher.
  await peer.start(); await coordinator.start()
  const room = await coordinator.createRoom({ topicId: 'swe-retries', category: 'software-engineering', format: 'socratic', theme: 'classroom', difficulty: 'intermediate', participation: 'participate', customQuestion: null, reading: null })
  const messages: ServerMessage[] = []
  await coordinator.connect(room.roomId, room.roomToken, { send: data => messages.push(JSON.parse(data)), close() {} })
  await coordinator.handle(room.roomId, { type: 'hello', clientId: 'test', resume: false })
  await Bun.sleep(200)
  expect(messages.some(message => message.type === 'speak')).toBe(false)
  await facilitator.start()
  const first = await wait(() => messages.find((message): message is Extract<ServerMessage, { type: 'speak' }> => message.type === 'speak'), 'facilitator worker')
  expect(first.speakerId).toBe('facilitator')
  for (let segmentIndex = 0; segmentIndex < first.segments.length; segmentIndex++) await coordinator.handle(room.roomId, { type: 'playback.segment', utteranceId: first.utteranceId, segmentIndex, event: 'ended' })
  await coordinator.handle(room.roomId, { type: 'playback.finished', utteranceId: first.utteranceId, outcome: 'completed', error: null })
  const next = await wait(() => messages.find((message): message is Extract<ServerMessage, { type: 'speak' }> => message.type === 'speak' && message.utteranceId !== first.utteranceId), 'peer worker')
  expect(next.speakerId).toBe('maya')
  const state = await store.getSnapshot(room.roomId)
  expect(state.trace.some(event => event.kind === 'floor.requested' && event.from === 'maya' && event.to === 'bridge' && event.direction === 'in')).toBe(true)
  expect(state.contributions.at(-1)?.replyToContributionId).toBe(first.contributionId)
  expect(state.trace.filter(event => event.kind === 'worker.thinking').map(event => event.from)).toContain('facilitator')
})

test('an actor-pushed expiry revokes browser speech without a client action', async () => {
  const root = mkdtempSync(join(tmpdir(), 'apprentice-observer-'))
  const memory = createMemoryRoomStore()
  let publish: ((state: PublicRoomState) => void) | undefined
  const store = { ...memory, async subscribe(_room: string, callback: (state: PublicRoomState) => void) { publish = callback; return () => { publish = undefined } } }
  const service = new SeminarService(loadHackathonConfig(root), store, createMemoryRelay())
  cleanup.push(async () => { await service.stop(); rmSync(root, { recursive: true, force: true }) })
  await service.start()
  const room = await service.createRoom({ topicId: 'swe-retries', category: 'software-engineering', format: 'socratic', difficulty: 'intermediate', participation: 'participate', customQuestion: null, reading: null })
  const messages: ServerMessage[] = []
  await service.connect(room.roomId, room.roomToken, { send: data => messages.push(JSON.parse(data)), close() {} })
  const publicSnapshot = async () => { const { processedEventKeys: _, pendingOutbound: __, ...state } = await store.getSnapshot(room.roomId); return state }
  publish?.(await publicSnapshot())
  await store.pauseSession(room.roomId, 'speaker-timeout')
  const expired = await publicSnapshot(); publish?.(expired)
  const stopped = await wait(() => messages.find((message): message is Extract<ServerMessage, { type: 'stop' }> => message.type === 'stop' && message.reason === 'speaker-timeout'), 'actor stop event')
  expect(stopped.generationEpoch).toBe(expired.generationEpoch)
  expect(messages.some(message => message.type === 'snapshot' && message.state.phase === 'paused')).toBe(true)
})
