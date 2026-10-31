import { useState } from 'react'
import { Button, Select, TextArea } from '@radix-ui/themes'
import type { CreateRoomRequest, ProviderStatus } from '../../../shared/contracts'
import type { TopicsResponse } from '../../../shared/topic'
import type { Difficulty, Participation, TopicCategory } from '../../../actor/src/roomTypes'
import { useSeminarTheme } from '../lib/theme'
import { Icon } from './Icon'
import { LandingHero, LearningPrinciples, LearningResearch, SponsorStory } from './LandingStory'
import '../landing.css'

const topicLabels: Record<string, string> = { 'swe-seminar': 'Software engineering', science: 'Science', 'general-knowledge': 'General knowledge', math: 'Mathematics', custom: 'Custom' }
export function Lobby({ data, busy, error, enter, retry }: { data: TopicsResponse | null; status: ProviderStatus | null; busy: boolean; error: string | null; enter: (input: CreateRoomRequest) => void; retry: () => void }) {
  const { theme } = useSeminarTheme()
  const [topicId, setTopicId] = useState('swe-retries')
  const [category, setCategory] = useState<TopicCategory>('software-engineering')
  const [difficulty, setDifficulty] = useState<Difficulty>('intermediate')
  const [participation, setParticipation] = useState<Participation>('participate')
  const [question, setQuestion] = useState('')
  const [reading, setReading] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const topic = data?.topics.find(item => item.id === topicId)
  const currentPreset = data?.presets.find(p => p.topicId === topicId)
  const showSetup = () => {
    requestAnimationFrame(() => document.getElementById('setup-title')?.focus({ preventScroll: true }))
    document.getElementById('seminar-setup')?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })
  }
  const selectTopic = (id: string) => {
    if (id === 'custom') { setTopicId('custom'); setCategory('custom'); return }
    const selected = data?.topics.find(item => item.id === id)
    if (selected) { setTopicId(selected.id); setCategory(selected.category) }
  }
  return <main className="lobby landing">
    <LandingHero start={showSetup}/>
    <section id="seminar-setup" className="setup-section" aria-labelledby="setup-title">
      <div className="section-heading"><h2 id="setup-title" tabIndex={-1}>Start a seminar</h2></div>
      {!data ? <div className="connection-card"><p role="status">{error ?? 'Loading topics…'}</p>{error && <Button size="2" radius="full" variant="soft" onClick={retry}>Try again</Button>}</div> : <>
        <div className="topic-cards" role="group" aria-label="Topic">{data.presets.map(preset => <Button className={`topic-card ${currentPreset?.id === preset.id ? 'selected' : ''}`} type="button" key={preset.id} size="2" radius="full" variant={currentPreset?.id === preset.id ? 'solid' : 'soft'} aria-pressed={currentPreset?.id === preset.id} disabled={busy} onClick={() => { setTopicId(preset.topicId); setCategory(preset.category); setDifficulty(preset.difficulty) }}>{topicLabels[preset.id] ?? preset.label}</Button>)}</div>
        <div className="setup-bottom">
          <div className="question-card">
            <div className="eyebrow">{topicId === 'swe-retries' ? 'Software engineering demo' : 'Discussion question'}</div>
            {category === 'custom' ? <label className="field-label" htmlFor="custom-question">Question<TextArea id="custom-question" size="3" radius="large" value={question} onChange={event => setQuestion(event.target.value)} placeholder="Enter a question" maxLength={400} rows={4} disabled={busy}/></label> : <h3>{topic?.openingQuestion ?? 'Select a topic.'}</h3>}
            {topic && topic.sources.length > 0 && <div className="question-foot"><span className="sources-inline"><Icon name="book" size={14}/>{topic.sources.length} source summaries</span></div>}
          </div>
          <div className="setup-options">
            <div className="form-grid">
              <div className="field-label"><label htmlFor="seminar-difficulty">Difficulty</label><Select.Root size="3" value={difficulty} onValueChange={value => setDifficulty(value as Difficulty)} disabled={busy}><Select.Trigger id="seminar-difficulty" radius="large"/><Select.Content position="popper"><Select.Item value="introductory">Introductory</Select.Item><Select.Item value="intermediate">Intermediate</Select.Item><Select.Item value="advanced">Advanced</Select.Item></Select.Content></Select.Root></div>
              <div className="field-label"><label htmlFor="seminar-participation">Participation</label><Select.Root size="3" value={participation} onValueChange={value => setParticipation(value as Participation)} disabled={busy}><Select.Trigger id="seminar-participation" radius="large"/><Select.Content position="popper"><Select.Item value="participate">Join the discussion</Select.Item><Select.Item value="observe">Observe</Select.Item><Select.Item value="lead">Lead with questions</Select.Item></Select.Content></Select.Root></div>
            </div>
            <Button className="setup-adjust" size="2" radius="large" variant="ghost" aria-expanded={advanced} aria-controls="advanced-setup" disabled={busy} onClick={() => setAdvanced(!advanced)}>Reading & more topics <Icon name="chevron" size={12}/></Button>
            {advanced && <div id="advanced-setup" className="advanced-options"><div className="field-label"><label htmlFor="seminar-topic">Topic</label><Select.Root size="3" value={topicId} onValueChange={selectTopic} disabled={busy}><Select.Trigger id="seminar-topic" radius="large"/><Select.Content position="popper"><Select.Item value="custom">Custom question</Select.Item>{data.topics.map(item => <Select.Item value={item.id} key={item.id}>{item.title}</Select.Item>)}</Select.Content></Select.Root></div><label className="field-label" htmlFor="seminar-reading">Reading material (optional)<TextArea id="seminar-reading" size="3" radius="large" value={reading} onChange={event => setReading(event.target.value)} placeholder="Paste reading material" rows={3} maxLength={6000} disabled={busy}/></label></div>}
            <Button className="button primary enter-button" size="3" radius="full" loading={busy} disabled={busy || (!topic && category !== 'custom') || (category === 'custom' && question.trim().length === 0)} onClick={() => enter({ topicId, category, format: 'socratic', theme, difficulty, participation, customQuestion: category === 'custom' ? question.trim() : null, reading: reading.trim() || null })}>{busy ? 'Creating seminar…' : 'Start a seminar'}<Icon name="arrow" size={18}/></Button>
            {busy && <p role="status">Connecting the agents and preparing your room…</p>}
            {error && <p className="error-text" role="alert">{error}</p>}
          </div>
        </div>
      </>}
    </section>
    <LearningPrinciples/>
    <LearningResearch/>
    <SponsorStory/>
  </main>
}
