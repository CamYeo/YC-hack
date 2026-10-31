import { resolve } from 'node:path'
import { loadHackathonConfig } from '../config/hackathonConfig'
import { createLiveRelay } from '../providers/relay/liveRelay'
import { createTerseRoomStore } from '../terse/terseRoomStore'
import { SeminarService } from '../seminar/service'
import { createStdioReasoner } from './stdioReasoner'

const role = process.argv[2]
if (!['facilitator', 'maya', 'theo', 'evidence'].includes(role ?? '') || process.argv.slice(3).some(arg => arg !== '--stdio')) {
  process.stderr.write('Usage: bun server/agents/worker.ts <facilitator|maya|theo|evidence> [--stdio]\n')
  process.exit(2)
}
if (role !== 'facilitator' && role !== 'maya' && role !== 'theo' && role !== 'evidence') throw new Error('Invalid worker role')
if (role === 'evidence' && process.argv.includes('--stdio')) throw new Error('The evidence worker runs deterministic tools')
const config = loadHackathonConfig(resolve(import.meta.dir, '../..'))
if (!config.relay) throw new Error('Separate workers require the hackathon Agent Relay workspace')
const external = process.argv.includes('--stdio') ? createStdioReasoner(process.stdin, process.stdout) : null
const relay = await createLiveRelay(config.relay, config.repoRoot)
const service = new SeminarService(config, createTerseRoomStore(config.terse), relay, { role, ...(external ? { reasoner: external.reasoner } : {}) })
await service.start()
process.stderr.write(`Agent worker ready: ${role}; process ${process.pid}; ${external ? 'external JSONL agent' : role === 'evidence' ? 'evidence tools' : service.reasoner.label}\n`)
let stopping = false
const stop = async () => { if (stopping) return; stopping = true; external?.close(); await service.stop(); process.exit(0) }
process.on('SIGINT', () => { void stop() }); process.on('SIGTERM', () => { void stop() })
await new Promise(() => {})
