import type { ProviderStatus } from '../../../shared/contracts'
export function Providers({ status, compact = false }: { status: ProviderStatus | null; compact?: boolean }) {
  if (!status) return <span className="muted small">Checking connections…</span>
  const entries = [['Terse', status.terse], ['Agent Relay', status.relay], ['OpenAI', status.reasoning], ['ElevenLabs', status.voice]] as const
  return <div className={compact ? 'provider-chips' : 'provider-list'}>{entries.map(([name, provider]) => <div className={`provider mode-${provider.mode}`} key={name}>
    <div><span className="status-dot"/><strong>{name}</strong><span className="provider-mode">{provider.mode}</span></div>
    {!compact && <><p>{provider.label}</p>{provider.lastError && <p className="error-text">{provider.lastError}</p>}{provider.missing.length > 0 && <details><summary>Setup needed</summary><ul>{provider.missing.map(key => <li key={key}><code>{key}</code></li>)}</ul></details>}</>}
  </div>)}</div>
}
