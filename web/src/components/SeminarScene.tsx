import type { ReactNode } from 'react'
import type { SpeakerId } from '../../../actor/src/roomTypes'
import { assetRoot, speakingIds } from '../lib/cast'
import { useSeminarTheme } from '../lib/theme'
import { Avatar } from './Illustrations'

type Props = {
  speaker: SpeakerId | null
  playing: boolean
  reading: boolean
  thinking: SpeakerId[]
  paused: boolean
  ended: boolean
  listening: boolean
  awaitingHuman: boolean
  children: ReactNode
}

/** The artwork is scenery; all speaker states and dialogue remain live, accessible UI. */
export function SeminarScene({ speaker, playing, reading, thinking, paused, ended, listening, awaitingHuman, children }: Props) {
  const { theme, names } = useSeminarTheme()
  const halloween = theme === 'halloween'
  const status = paused ? 'Paused' : ended ? 'Session complete' : listening ? 'Listening to you' : awaitingHuman ? 'Your turn' : 'In conversation'
  return <div className={`seminar-stage seminar-scene scene-${theme} ${paused ? 'stage-paused' : ''}`}>
    <div className="stage-top scene-heading"><span className="eyebrow">Participants</span><span className="room-state"><span className="status-dot"/>{status}</span></div>
    <div className={`scene-table ${halloween ? 'scene-table-illustrated' : ''}`}>
      {halloween && <>
        <img className="scene-cast-art" src={`${assetRoot}/reference/seminar-cast.png`} alt="Count Dracula, Jack Skellington, and Wednesday Addams gathered around a candlelit library table, with an empty chair for you." width={1536} height={1024} fetchPriority="high"/>
        <div className="scene-art-vignette" aria-hidden="true"/>
        {playing && speaker && !paused && <div className={`scene-speaker-light light-${speaker}`} aria-hidden="true"/>}
      </>}
      <div className="seminar-seats scene-participants">{speakingIds.map(id => {
        const active = speaker === id && playing && !paused
        const preparing = thinking.includes(id) && !paused && !ended && !active
        return <div className={`participant-label participant-${id} ${active ? 'is-speaking' : ''} ${preparing ? 'is-thinking' : ''}`} key={id} aria-label={`${names[id]}, AI ${id === 'facilitator' ? 'facilitator' : 'peer'}, ${active ? reading ? 'reading' : 'speaking' : preparing ? 'thinking' : 'listening'}`}>
          {!halloween && <Avatar id={id}/>}
          <span className="participant-pill">{active && <span className="voice-bars" aria-hidden="true"><i/><i/><i/></span>}{names[id]}</span>
          <span className="participant-state">{active ? reading ? 'Reading' : 'Speaking' : preparing ? 'Thinking' : 'Listening'}<span aria-hidden="true"> · </span>{id === 'facilitator' ? 'AI host' : 'AI peer'}</span>
        </div>
      })}</div>

    </div>
    {children}
  </div>
}
