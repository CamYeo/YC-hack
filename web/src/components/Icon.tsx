type IconName = 'arrow' | 'home' | 'mic' | 'pause' | 'play' | 'sound' | 'mute' | 'close' | 'book' | 'chevron' | 'code' | 'question' | 'math' | 'compass' | 'spark' | 'check' | 'settings'
const paths: Record<IconName, string> = {
  home: 'm3 10 9-7 9 7M5 9v12h5v-7h4v7h5V9',
  arrow: 'M4 12h16m-6-6 6 6-6 6', mic: 'M12 15a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v7a3 3 0 0 0 3 3Zm-6-4v1a6 6 0 0 0 12 0v-1M12 18v4m-4 0h8',
  pause: 'M8 5v14M16 5v14', play: 'm8 5 11 7-11 7Z', sound: 'm11 5-6 4H2v6h3l6 4V5Zm4 3a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14',
  mute: 'm11 5-6 4H2v6h3l6 4V5Zm6 4 5 6m0-6-5 6', close: 'm6 6 12 12M6 18 18 6', book: 'M12 6c-3-3-7-3-10-2v15c4-1 7-1 10 2m0-15c3-3 7-3 10-2v15c-4-1-7-1-10 2V6Z',
  chevron: 'm9 5 7 7-7 7', code: 'm8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18', question: 'M9 8a3 3 0 0 1 6 0c0 2-3 2-3 5m0 4v.01M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z',
  math: 'M4 6h7m-3.5-3v6m7-3h6M4 17l7 0m4-3 6 6m0-6-6 6', compass: 'm16 8-3 5-5 3 3-5 5-3ZM12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z',
  spark: 'm12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7Z', check: 'm5 12 4 4L19 6', settings: 'M4 7h16M4 17h16M8 4v6m8 4v6',
}
export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}
