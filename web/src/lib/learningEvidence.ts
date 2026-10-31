/** Primary research checked 2026-10-31. These are broader findings, not Apprentice efficacy claims. */
export interface LearningEvidenceCard {
  id: string
  eyebrow: string
  title: string
  claim: string
  context: string
  limitation: string
  source: { title: string; url: string; year: number }
}

export const learningEvidenceCaveat =
  'These studies inform the practices behind Apprentice. They studied classroom teaching and specific AI tools; Apprentice has not yet been evaluated for learning outcomes.'

export const learningEvidence: readonly LearningEvidenceCard[] = [
  {
    id: 'dialogic-teaching',
    eyebrow: 'Classroom dialogue',
    title: 'Make room for reasoning.',
    claim: 'A randomized trial of reasoning-rich classroom talk reported small short-term gains in English and science.',
    context: 'Year 5 pupils in 76 English primary schools; a 20-week programme of teacher training, dialogue and mentoring.',
    limitation: 'A later follow-up found no statistically significant gains in national tests. This was human-led teaching, not an AI seminar.',
    source: {
      title: 'Dialogic Teaching: evaluation and follow-up',
      url: 'https://educationendowmentfoundation.org.uk/projects-and-evaluation/projects/dialogic-teaching/',
      year: 2017,
    },
  },
  {
    id: 'active-learning',
    eyebrow: 'Broader learning evidence',
    title: 'Give learners something to do.',
    claim: 'A meta-analysis of 225 undergraduate STEM studies found higher exam performance and lower failure rates with active learning than with traditional lectures.',
    context: 'Freeman and colleagues compared many approaches, including problem-solving and peer instruction.',
    limitation: 'This supports active participation broadly. It does not isolate Socratic seminars or establish that AI peers improve learning.',
    source: {
      title: 'Active learning increases student performance in science, engineering, and mathematics',
      url: 'https://doi.org/10.1073/pnas.1319030111',
      year: 2014,
    },
  },
  {
    id: 'ai-learning-guardrails',
    eyebrow: 'AI and independent learning',
    title: 'Keep the learner thinking.',
    claim: 'GPT-4 improved practice scores in a school math trial. Students using an unrestricted version later scored lower when working without AI.',
    context: 'A randomized trial with nearly 1,000 students at one Turkish high school compared unrestricted AI, a hint-focused tutor and no AI.',
    limitation: 'The teacher-informed tutor showed no significant unaided-score difference from the control. This was short-term math learning, not a verdict on all AI assistance.',
    source: {
      title: 'Generative AI without guardrails can harm learning: Evidence from high school mathematics',
      url: 'https://doi.org/10.1073/pnas.2422633122',
      year: 2025,
    },
  },
]

// Audit trail for the compact claims and their limitations:
// EEF original evaluation: executive summary / Table 1; maths was not statistically significant.
// https://d2tic4wvo1iusb.cloudfront.net/production/documents/projects/Dialogic_Teaching_Evaluation_Report.pdf
// EEF April 2019 addendum: executive summary, later KS2 reading/mathematics outcomes.
// https://d2tic4wvo1iusb.cloudfront.net/production/documents/projects/Dialogic_Teaching_addendum_report__final_for_publication.pdf
// Freeman et al.: abstract, interventions paragraph, and methodological qualifications.
// Primary paper copy: https://math.stanford.edu/~conrad/papers/PNAS.pdf
// Bastani et al.: randomized design, unassisted-exam results, and short-term-outcome limitation.
// Author's paper copy: https://hamsabastani.github.io/education_llm.pdf
