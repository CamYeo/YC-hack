import { Button } from '@radix-ui/themes'
import { useSeminarTheme } from '../lib/theme'
import { assetRoot } from '../lib/cast'
import { learningEvidence, learningEvidenceCaveat } from '../lib/learningEvidence'
import { Icon } from './Icon'
import { Avatar, Pumpkin, Sketch } from './Illustrations'
import { CoordinationExplorer } from './CoordinationExplorer'

export function LandingHero({ start }: { start: () => void }) {
  const { theme } = useSeminarTheme()
  return <section className="landing-hero" aria-labelledby="landing-title">
    <div className="landing-hero-copy"><h1 id="landing-title">AI should help us think <em>deeper<Sketch kind="underline"/></em>, not shallower.</h1><div className="landing-hero-actions"><Button className="button primary" size="3" radius="full" onClick={start}>Start a seminar <Icon name="arrow" size={18}/></Button><a href="#research">Research <span aria-hidden="true">↓</span></a></div></div>
    <figure className={`landing-hero-figure ${theme === 'halloween' ? 'is-haunted' : 'is-classroom'}`}>
      {theme === 'halloween' ? <img src={`${assetRoot}/reference/seminar-cast.png`} width="1536" height="1024" alt="Count Dracula, Jack Skellington and Wednesday Addams at a seminar table."/> : <div className="landing-classroom-portraits"><Avatar id="maya"/><Avatar id="facilitator"/><Avatar id="theo"/></div>}
      {theme === 'halloween' && <span className="hero-pumpkin-mark" aria-hidden="true"><Pumpkin size={35}/><Pumpkin size={25}/></span>}
    </figure>
  </section>
}

export function LearningPrinciples() {
  return <section id="how-it-works" className="learning-principles" aria-labelledby="principles-title"><div className="landing-section-heading"><h2 id="principles-title">How it works</h2><p>A facilitator and two AI peers discuss your question. Participate by voice or text, interrupt a turn, consult evidence, and review the discussion. The seminar uses questions and counterexamples to examine each participant’s reasoning.</p></div></section>
}

const studyTitles: Record<string, string> = { 'dialogic-teaching': 'Classroom dialogue', 'active-learning': 'Active learning', 'ai-learning-guardrails': 'AI-assisted practice' }
export function LearningResearch() {
  const { theme } = useSeminarTheme()
  return <section id="research" className="learning-research" aria-labelledby="research-title">
    <div className="research-intro"><h2 id="research-title">{theme === 'halloween' && <Pumpkin size={28}/>}Research</h2><p>Evidence on dialogue, active participation, and independent learning.</p></div>
    <div className="research-cards research-disclosure-cards">{learningEvidence.map(item => <article className="research-card" key={item.id}><div className="research-card-top"><span className="research-study-icon"><Icon name={item.id === 'dialogic-teaching' ? 'question' : item.id === 'active-learning' ? 'book' : 'compass'} size={25}/></span><span>{item.source.year}</span></div><h3>{studyTitles[item.id] ?? item.eyebrow}</h3><p className="research-claim">{item.claim}</p><details className="research-more"><summary>Study details & limitations <Icon name="chevron" size={12}/></summary><p className="research-context">{item.context}</p><p className="research-limitation"><strong>Limitations</strong>{item.limitation}</p></details><a className="research-source" href={item.source.url} target="_blank" rel="noreferrer"><span>{item.source.title}</span><span aria-hidden="true">↗</span></a></article>)}</div>
    <p className="research-caveat">{learningEvidenceCaveat}</p>
  </section>
}

export function SponsorStory() { return <CoordinationExplorer/> }
