import { useCallback, useEffect, useState } from 'react'
import { Button, Switch, Theme } from '@radix-ui/themes'
import type { CreateRoomRequest, ProviderStatus } from '../../shared/contracts'
import type { TopicsResponse } from '../../shared/topic'
import { createRoom, forgetRoom, getStatus, getTopics, readSavedRoom, saveRoom, type SavedRoom } from './lib/api'
import { Lobby } from './components/Lobby'
import { Room } from './components/Room'
import { Icon } from './components/Icon'
import { ThemeProvider, useSeminarTheme } from './lib/theme'
import { Pumpkin } from './components/Illustrations'

export function App() { return <ThemeProvider><Workspace/></ThemeProvider> }

function Workspace() {
  const { theme, setTheme } = useSeminarTheme()
  const [room, setRoom] = useState<SavedRoom | null>(readSavedRoom)
  const [topics, setTopics] = useState<TopicsResponse | null>(null)
  const [status, setStatus] = useState<ProviderStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => {
    void Promise.allSettled([getTopics(), getStatus()]).then(results => {
      const topicResult = results[0]; const statusResult = results[1]
      if (topicResult.status === 'fulfilled') setTopics(topicResult.value)
      else setError('The seminar service is not ready yet. Start the local app, then try again.')
      if (statusResult.status === 'fulfilled') setStatus(statusResult.value)
    })
  }, [])
  useEffect(load, [load])
  const enter = async (input: CreateRoomRequest) => {
    if (busy) return
    setBusy(true); setError(null)
    // A user gesture primes audio before the asynchronous room setup.
    const audio = new AudioContext(); void audio.resume().then(() => audio.close()).catch(() => {})
    try { const created = await createRoom(input); saveRoom(created); setRoom({ ...created, resumed: false }); window.scrollTo({ top: 0 }) }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'The room could not be created. Try again.') }
    finally { setBusy(false) }
  }
  const leave = () => { forgetRoom(); setRoom(null); setError(null); window.scrollTo({ top: 0 }); load() }
  const goHome = () => { if (room) leave(); else window.scrollTo({ top: 0, behavior: 'smooth' }) }
  return <Theme appearance="light" accentColor={theme === 'halloween' ? 'orange' : 'grass'} grayColor="sand" radius="full" className={`app-shell theme-${theme} ${room ? 'has-room' : 'has-home'}`}>
    <header className="app-header">
      <a className="brand brand-home" href="#home" aria-label="Apprentice homepage" onClick={event => { event.preventDefault(); goHome() }}>
        <span className="brand-mark">{theme === 'halloween' ? <Pumpkin size={29}/> : <Icon name="book" size={26}/>}</span>
        <div><div className="brand-name">Apprentice<span className="brand-period">.</span></div><div className="brand-edition">Socratic seminars with AI</div></div>
      </a>
      <nav className="header-right" aria-label="Main navigation">
        {status?.reasoning.mode === 'fixture' && <span className="mode-badge">Sample dialogue</span>}
        <label className="theme-control"><Pumpkin/><span>Halloween</span><Switch size="2" checked={theme === 'halloween'} onCheckedChange={checked => setTheme(checked ? 'halloween' : 'classroom')} aria-label="Halloween theme"/></label>
        <Button variant="ghost" radius="full" className="home-button" onClick={goHome} aria-label="Homepage" aria-current={room ? undefined : 'page'}><Icon name="home" size={17}/><span>Home</span></Button>
      </nav>
    </header>
    {room ? <Room key={room.roomId} room={room} status={status} topics={topics} leave={leave} again={input => { leave(); void enter(input) }}/>:<Lobby data={topics} status={status} busy={busy} error={error} enter={input => void enter(input)} retry={() => { setError(null); load() }}/>}
  </Theme>
}
