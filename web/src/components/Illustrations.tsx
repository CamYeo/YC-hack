import { useEffect, useRef } from 'react'
import rough from 'roughjs'
import type { SpeakerId } from '../../../actor/src/roomTypes'
import { assetRoot } from '../lib/cast'
import { useSeminarTheme } from '../lib/theme'

export function Sketch({ kind, className = '' }: { kind: 'table' | 'underline' | 'arrow' | 'notes'; className?: string }) {
  const svgRef = useRef<SVGSVGElement>(null)
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    svg.replaceChildren()
    const drawing = rough.svg(svg)
    const options = { seed: 17, stroke: '#474b3d', strokeWidth: 1.3, roughness: 1.4, bowing: 1 }
    if (kind === 'table') {
      svg.append(drawing.ellipse(180, 100, 280, 125, { ...options, fill: '#e8eadf', fillStyle: 'hachure', hachureGap: 10, fillWeight: .35 }))
      svg.append(drawing.path('M82 124 L68 171 M280 126 L293 171', options))
      svg.append(drawing.polygon([[142, 80], [180, 70], [200, 91], [163, 100]], { ...options, fill: '#fffdf6', fillStyle: 'solid' }))
      svg.append(drawing.path('M159 83 L177 79 M164 88 L184 84 M225 75 C211 66 211 88 224 84 C236 82 236 66 225 66 M237 72 C248 70 246 81 238 81', { ...options, strokeWidth: 1 }))
    } else if (kind === 'underline') svg.append(drawing.path('M5 12 Q112 2 242 8 M14 17 Q127 7 233 13', { ...options, stroke: '#a65d3e', strokeWidth: 1.5 }))
    else if (kind === 'arrow') svg.append(drawing.path('M7 9 C76 0 84 30 70 48 M57 41 L70 49 L82 39', options))
    else {
      svg.append(drawing.rectangle(14, 12, 81, 74, { ...options, fill: '#f4efda', fillStyle: 'solid' }))
      svg.append(drawing.path('M30 32 L78 30 M30 44 L69 42 M31 57 L74 55 M113 48 Q137 44 143 25 M132 28 L144 23 L146 37', options))
    }
  }, [kind])
  return <svg ref={svgRef} className={`sketch ${className}`} viewBox={kind === 'table' ? '0 0 360 180' : kind === 'underline' ? '0 0 250 23' : kind === 'arrow' ? '0 0 100 60' : '0 0 160 100'} aria-hidden="true"/>
}

export function Pumpkin({ size = 19 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17 8c-2-5 0-6 3-6M15 8c-5-4-12 1-12 10 0 8 7 11 13 10 7 1 13-4 13-10S22 4 16 8Z"/><path d="M13 9c-5 5-4 15 1 19m4-19c5 6 5 13 0 19M9 17l3-3 2 4Zm11 1 2-4 3 3ZM11 22c4 3 8 3 11-1"/></svg>
}

export function Avatar({ id, small = false }: { id: SpeakerId; small?: boolean }) {
  const { theme, names } = useSeminarTheme()
  if (theme === 'halloween') return <div className={`drawn-avatar halloween-avatar avatar-${id} ${small ? 'small-avatar' : ''}`} role="img" aria-label={names[id]}>{id !== 'facilitator' && <img src={`${assetRoot}/portraits/${id === 'maya' ? 'dracula' : 'wednesday'}.png`} alt=""/>}</div>
  return <div className={`drawn-avatar avatar-${id} ${small ? 'small-avatar' : ''}`}><svg viewBox="0 0 100 104" role="img" aria-label={names[id]} fill="none" stroke="#34382e" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path fill={id === 'maya' ? '#e2c5ad' : id === 'theo' ? '#bec9bb' : '#d8d5a9'} stroke="none" d="M13 99C12 72 25 62 49 63c25-1 39 12 39 36Z"/><path d="M13 99C12 72 25 62 49 63c25-1 39 12 39 36M35 67l14 14 15-14M49 81v21"/>{id === 'maya' ? <><path fill="#48483c" d="M26 49C15 15 31 5 51 6c24-1 35 20 24 47l-10 8-35-3Z"/><path fill="#f5e5ce" d="M29 27c8 2 20-4 27-12 1 12 10 17 15 19l-4 18c-4 15-25 17-34 3Z"/><path d="M37 38h3m16-1h3M48 40l-1 9 4 1m-11 7q8 5 15-1M24 38l-4 21m52-22 4 24"/></> : id === 'theo' ? <><path fill="#f4dfc4" d="M29 26c-2 16 1 36 20 39 20-1 26-19 22-36L56 14Z"/><path fill="#696c56" d="M28 34c-12-15 0-25 11-24 0-10 21-10 25 0 17-2 20 16 7 25l-5-15c-12 8-19 6-30 3Z"/><path d="M34 39h11v9H33Zm20 0h12v9H54Zm-9 4h9M49 46l-2 7 4 1m-9 5 14-1"/></> : <><path fill="#e8d4b6" d="M28 26c0-15 43-18 43 1l-2 24c-7 19-28 18-37-1Z"/><path fill="#d0cbc0" d="M29 30C15 13 31 2 46 9c12-11 37 6 25 23l-7-13c-9 5-20 5-30 2Z"/><path d="M33 38c0-5 13-5 13 1s-13 7-13-1Zm22 0c0-5 13-5 13 1s-13 7-13-1Zm-9 1h9m-4 4-3 9h4m-10 6c7 3 12 2 16-2"/></>}<path d="m22 88 10 4m36-4 10 4" strokeOpacity=".5"/></svg></div>
}

export function SeminarDrawing() {
  const { theme } = useSeminarTheme()
  return <div className="seminar-drawing" aria-hidden="true"><div className="drawing-peer drawing-maya"><Avatar id="maya" small/></div><div className="drawing-peer drawing-facilitator"><Avatar id="facilitator" small/></div><div className="drawing-peer drawing-theo"><Avatar id="theo" small/></div><Sketch kind="table"/><div className="empty-seat"><svg viewBox="0 0 66 70" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M12 40 10 17q22-10 44 0l-2 24M12 40q21-5 40 1l6 10q-26 7-52-1Zm0 12-3 16m43-15 5 16"/></svg><span>your seat</span></div><div className="drawing-annotation">Come as you are.<Sketch kind="arrow"/></div>{theme === 'halloween' && <div className="drawing-pumpkin"><Pumpkin size={30}/></div>}</div>
}
