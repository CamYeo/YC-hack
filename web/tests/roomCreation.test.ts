import { afterEach, expect, test } from 'bun:test'
import { createRoom } from '../src/lib/api'
import type { CreateRoomRequest } from '../../shared/contracts'

const originalFetch = globalThis.fetch
const input: CreateRoomRequest = { topicId: 'swe-retries', category: 'software-engineering', format: 'socratic', theme: 'halloween', difficulty: 'intermediate', participation: 'participate', customQuestion: null, reading: null }
afterEach(() => { globalThis.fetch = originalFetch })
test('Relay outage explains why creation failed and how to retry without silently replaying a POST', async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return Response.json({ error: { message: 'Agent Relay could not be reached' } }, { status: 500 })
  }) as typeof fetch
  await expect(createRoom(input)).rejects.toThrow('Agent Relay could not be reached, so the seminar could not start.')
  expect(calls).toBe(1)
})
test('setup timeout and unreachable local server have actionable errors', async () => {
  globalThis.fetch = (async () => { throw new DOMException('Timeout', 'TimeoutError') }) as typeof fetch
  await expect(createRoom(input)).rejects.toThrow('Room setup took too long.')
  globalThis.fetch = (async () => { throw new TypeError('Failed to fetch') }) as typeof fetch
  await expect(createRoom(input)).rejects.toThrow('The local seminar service could not be reached.')
})
test('successful room creation and validation failures retain their actual result', async () => {
  const result = { roomId: 'test', roomToken: 'test-token', sessionId: 'test-session' }
  globalThis.fetch = (async () => Response.json(result, { status: 201 })) as typeof fetch
  expect(await createRoom(input)).toEqual(result)
  globalThis.fetch = (async () => Response.json({ error: { message: 'Check the topic and seminar options' } }, { status: 400 })) as typeof fetch
  await expect(createRoom(input)).rejects.toThrow('Check the topic and seminar options')
})
