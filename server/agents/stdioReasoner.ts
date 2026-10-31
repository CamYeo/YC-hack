import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { ProposalDraftSchema } from '../../shared/contracts'
import type { Reasoner } from './types'

/** JSONL adapter for a caller-owned agent. No provider credentials cross this interface. */
export function createStdioReasoner(input: Readable, output: Writable) {
  const lines = createInterface({ input })
  const pending = new Map<string, { resolve: (draft: unknown) => void; reject: (error: Error) => void }>()
  lines.on('line', line => {
    try {
      const response: unknown = JSON.parse(line)
      if (!response || typeof response !== 'object' || !('requestId' in response) || typeof response.requestId !== 'string' || !('draft' in response)) return
      pending.get(response.requestId)?.resolve(response.draft)
    } catch { /* A malformed line cannot select a pending request. */ }
  })
  const close = () => { for (const request of pending.values()) request.reject(new Error('External agent disconnected')); pending.clear(); lines.close() }
  lines.on('close', () => { for (const request of pending.values()) request.reject(new Error('External agent disconnected')); pending.clear() })
  const reasoner: Reasoner = {
    mode: 'external', label: 'External agent · JSONL',
    async propose(context, signal) {
      const started = Date.now(), requestId = crypto.randomUUID()
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
      let timer: ReturnType<typeof setTimeout> | undefined
      let cancel = () => {}
      try {
        const result = await new Promise<unknown>((resolve, reject) => {
          pending.set(requestId, { resolve, reject })
          cancel = () => reject(new DOMException('Cancelled', 'AbortError'))
          signal.addEventListener('abort', cancel, { once: true })
          timer = setTimeout(() => reject(new Error('External agent exceeded its 45-second turn limit')), 45_000)
          output.write(`${JSON.stringify({ type: 'turn.request', requestId, context })}\n`)
        })
        return { draft: ProposalDraftSchema.parse(result), latencyMs: Date.now() - started }
      } finally { if (timer) clearTimeout(timer); signal.removeEventListener('abort', cancel); pending.delete(requestId) }
    },
    async reflect() { throw new Error('External peers do not generate the session reflection') },
  }
  return { reasoner, close }
}
