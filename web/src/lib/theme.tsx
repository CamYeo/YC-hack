import { createContext, useContext, useState, type ReactNode } from 'react'
import type { ParticipantId } from '../../../actor/src/roomTypes'

export type SeminarTheme = 'classroom' | 'halloween'
const classroomNames: Record<ParticipantId, string> = { facilitator: 'Facilitator', maya: 'Maya', theo: 'Theo', human: 'You', evidence: 'Evidence' }
const halloweenNames: Record<ParticipantId, string> = { facilitator: 'Jack Skellington', maya: 'Count Dracula', theo: 'Wednesday Addams', human: 'You', evidence: 'Evidence' }
const halloweenShort: Record<ParticipantId, string> = { ...halloweenNames, facilitator: 'Jack', maya: 'Dracula', theo: 'Wednesday' }
const ThemeContext = createContext({ theme: 'classroom' as SeminarTheme, setTheme: (_theme: SeminarTheme) => {}, names: classroomNames, shortNames: classroomNames })

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, updateTheme] = useState<SeminarTheme>(() => { try { return localStorage.getItem('apprentice.theme.v1') === 'classroom' ? 'classroom' : 'halloween' } catch { return 'halloween' } })
  const setTheme = (next: SeminarTheme) => { updateTheme(next); try { localStorage.setItem('apprentice.theme.v1', next) } catch { /* The visual preference still works without local storage. */ } }
  return <ThemeContext.Provider value={{ theme, setTheme, names: theme === 'halloween' ? halloweenNames : classroomNames, shortNames: theme === 'halloween' ? halloweenShort : classroomNames }}>{children}</ThemeContext.Provider>
}

export function useSeminarTheme() { return useContext(ThemeContext) }
