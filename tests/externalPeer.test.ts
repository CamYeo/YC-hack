import { expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { createStdioReasoner } from '../server/agents/stdioReasoner'
import type { AgentContext } from '../server/agents/types'

const context = { agentId: 'theo', roomId: 'external-test', privateNotes: [] } as unknown as AgentContext
const draft = { action: 'contribute', replyToContributionId: null, addressedTo: 'group', text: 'What evidence would distinguish failure from a delayed response?', sourceIds: [], evidenceRequest: null, boardUpdate: null, privateNote: '' }
test('external peer receives a scoped request and returns a validated proposal', async () => {
  const input = new PassThrough(), output = new PassThrough()
  const adapter = createStdioReasoner(input, output)
  output.once('data', bytes => { const request = JSON.parse(bytes.toString()); expect(request.type).toBe('turn.request'); expect(request.context.agentId).toBe('theo'); input.write(JSON.stringify({ requestId: request.requestId, draft }) + '\n') })
  try { const result = await adapter.reasoner.propose(context, new AbortController().signal); expect(result.draft.text).toBe(draft.text); expect(adapter.reasoner.mode).toBe('external') }
  finally { adapter.close() }
})
test('cancelled external work cannot resolve from a late response', async () => {
  const input = new PassThrough(), output = new PassThrough(), abort = new AbortController()
  const adapter = createStdioReasoner(input, output)
  let requestId = ''
  output.once('data', bytes => { requestId = JSON.parse(bytes.toString()).requestId })
  const work = adapter.reasoner.propose(context, abort.signal)
  abort.abort()
  await expect(work).rejects.toMatchObject({ name: 'AbortError' })
  input.write(JSON.stringify({ requestId, draft }) + '\n')
  adapter.close()
})
test('invalid external output is rejected before a proposal can enter Relay', async () => {
  const input = new PassThrough(), output = new PassThrough(), adapter = createStdioReasoner(input, output)
  output.once('data', bytes => input.write(JSON.stringify({ requestId: JSON.parse(bytes.toString()).requestId, draft: { text: 'missing contract fields' } }) + '\n'))
  try { await expect(adapter.reasoner.propose(context, new AbortController().signal)).rejects.toBeDefined() }
  finally { adapter.close() }
})
