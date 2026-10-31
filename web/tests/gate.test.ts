import { describe, expect, test } from 'bun:test'
import { PlaybackGate } from '../src/audio/gate'
describe('playback cancellation gate', () => {
  test('an interruption prevents late same-epoch audio before the server replies', () => {
    const gate = new PlaybackGate()
    expect(gate.accept('first', 4)).toBe(true)
    gate.interrupt(4)
    expect(gate.accept('late-provider-response', 4)).toBe(false)
    expect(gate.accept('next-turn', 5)).toBe(true)
  })
  test('snapshots cannot roll epochs backwards or replay an acknowledged utterance', () => {
    const gate = new PlaybackGate()
    gate.advance(8); gate.advance(3)
    expect(gate.accept('stale', 7)).toBe(false)
    expect(gate.accept('current', 8)).toBe(true)
    expect(gate.accept('current', 8)).toBe(false)
  })
  test('jumping in while a model thinks blocks its not-yet-delivered response', () => {
    const gate = new PlaybackGate()
    gate.advance(12)
    gate.interrupt()
    expect(gate.accept('old-proposal', 12)).toBe(false)
    expect(gate.accept('after-interruption', 13)).toBe(true)
  })
})
