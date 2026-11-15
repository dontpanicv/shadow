import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Bar, Collapse, Count, Phone, Roll, Stage, States, Stream, Window, useLook, type Act, type Layout } from '../../kit'
import './shadow.css'

// Shadow, the family assistant, in its own desktop look: the sidebar on the
// canvas, the chat in an inset panel, Inter, Ember's one rust accent. Beats: a
// person types a request into the composer and sends it; Shadow starts
// to work ("Working for 1s · Set heating", the pixel spinner, a shimmer), its
// step changes twice; the work folds into "Worked for 3s" with one accent
// pixel for each tool call; the answer streams in, its three cards drop in
// under the first line, and the last line streams under them. The payoff
// holds, then the exchange leaves in one reverse stagger around the earlier
// thread, which comes back down to where the loop began.
//
// Shadow's look is taken from its code, not invented: the logo and the glyphs
// are the paths of `bun run tokens` and `scripts/icon.ts`, the card icons are
// web/chats/cards.tsx, the sizes and colors are public/tokens.css
// and public/styles.css (.message, .work-summary, .step-strip, .card,
// .composer, .panel).
//
// Real strings: the request, the work line, the answer's two lines, the
// three cards, and the short turn before them; the sidebar's own nav and the
// thread title are chrome. Older turns are placeholder.

const Q = 'We land at 18:40. Warm the living room up before we get home, and tell me if it rains tonight.'
// The non-breaking space keeps the value one word, so it streams and bolds as one
const A1 = 'Done. The living room heats to 22 °C from 18:30, so it is warm when you come in at about 19:30.'
const A2 = 'Light rain starts at 21:00, so take the umbrella from the car.'
const W1 = A1.split(' ').length
const W2 = A2.split(' ').length
const STEPS = ['Set heating', 'Get forecast', 'Get car']

const CARDS = [
  { icon: 'heat', title: 'Living room', value: '17.2 → 22 °C', detail: 'from 18:30' },
  { icon: 'rain', title: 'Tonight', value: 'Rain at 21:00', detail: '70 %, light' },
  { icon: 'battery', title: 'Car', value: '78 %', detail: '412 km' },
] as const

// web/chats/cards.tsx: the pixel icons of cards, in the cells of an 8 × 8 grid
const PIXELS = {
  heat: 'M4 0H5V1H6V3H7V6H6V7H5V8H3V7H2V6H1V3H2V2H3V1H4Z',
  rain: 'M2 1H5V2H6V3H7V5H1V4H0V3H1V2H2ZM1 6H2V7H1ZM3 6H4V8H3ZM5 6H6V7H5Z',
  battery: 'M0 2H7V3H8V5H7V6H0ZM1 3V5H4V3Z',
}

// web/ui/pixels.ts: the 16 × 16 pixel icons
const GLYPHS = {
  shadow: 'M0 0H12V1H0ZM0 1H10V2H0ZM11 1H12V2H11ZM0 2H6V3H0ZM10 2H11V3H10ZM0 3H6V4H0ZM10 3H12V4H10ZM13 3H14V4H13ZM0 4H2V5H0ZM6 4H10V5H6ZM14 4H15V5H14ZM0 5H2V6H0ZM6 5H8V6H6ZM9 5H10V6H9ZM0 6H9V7H0ZM10 6H11V7H10ZM13 6H14V7H13ZM0 7H10V8H0ZM11 7H12V8H11ZM0 8H8V9H0ZM9 8H11V9H9ZM12 8H13V9H12ZM0 9H9V10H0ZM10 9H11V10H10ZM13 9H14V10H13ZM0 10H4V11H0ZM0 11H4V12H0ZM12 11H13V12H12ZM0 12H11V13H0ZM0 13H12V14H0ZM2 14H10V15H2ZM2 15H11V16H2Z',
  bell: 'M7 1H9V2H7ZM6 2H10V3H6ZM5 3H6V4H5ZM10 3H11V4H10ZM4 4H5V5H4ZM11 4H12V5H11ZM4 5H5V6H4ZM11 5H12V6H11ZM4 6H5V7H4ZM11 6H12V7H11ZM4 7H5V8H4ZM11 7H12V8H11ZM4 8H5V9H4ZM11 8H12V9H11ZM4 9H5V10H4ZM11 9H12V10H11ZM3 10H4V11H3ZM12 10H13V11H12ZM2 11H14V12H2ZM6 13H10V14H6Z',
  clock: 'M6 2H11V3H6ZM5 3H6V4H5ZM11 3H12V4H11ZM4 4H5V5H4ZM8 4H9V5H8ZM12 4H13V5H12ZM3 5H4V6H3ZM8 5H9V6H8ZM13 5H14V6H13ZM2 6H3V7H2ZM8 6H9V7H8ZM14 6H15V7H14ZM2 7H3V8H2ZM8 7H9V8H8ZM14 7H15V8H14ZM2 8H3V9H2ZM8 8H9V9H8ZM14 8H15V9H14ZM2 9H3V10H2ZM9 9H11V10H9ZM14 9H15V10H14ZM2 10H3V11H2ZM11 10H12V11H11ZM14 10H15V11H14ZM3 11H4V12H3ZM13 11H14V12H13ZM4 12H5V13H4ZM12 12H13V13H12ZM5 13H6V14H5ZM11 13H12V14H11ZM6 14H11V15H6Z',
  search: 'M4 1H9V2H4ZM3 2H4V3H3ZM9 2H10V3H9ZM2 3H3V4H2ZM10 3H11V4H10ZM1 4H2V5H1ZM11 4H12V5H11ZM1 5H2V6H1ZM11 5H12V6H11ZM1 6H2V7H1ZM11 6H12V7H11ZM1 7H2V8H1ZM11 7H12V8H11ZM1 8H2V9H1ZM11 8H12V9H11ZM2 9H3V10H2ZM10 9H11V10H10ZM3 10H4V11H3ZM9 10H11V11H9ZM4 11H9V12H4ZM11 11H12V12H11ZM12 12H13V13H12ZM13 13H14V14H13ZM14 14H15V15H14Z',
  hash: 'M5 1H6V2H5ZM10 1H11V2H10ZM5 2H6V3H5ZM10 2H11V3H10ZM5 3H6V4H5ZM10 3H11V4H10ZM5 4H6V5H5ZM10 4H11V5H10ZM1 5H15V6H1ZM5 6H6V7H5ZM10 6H11V7H10ZM5 7H6V8H5ZM10 7H11V8H10ZM5 8H6V9H5ZM10 8H11V9H10ZM5 9H6V10H5ZM10 9H11V10H10ZM1 10H15V11H1ZM5 11H6V12H5ZM10 11H11V12H10ZM5 12H6V13H5ZM10 12H11V13H10ZM5 13H6V14H5ZM10 13H11V14H10ZM5 14H6V15H5ZM10 14H11V15H10Z',
  compose: 'M12 1H13V2H12ZM2 2H9V3H2ZM13 2H14V3H13ZM2 3H3V4H2ZM12 3H13V4H12ZM14 3H15V4H14ZM2 4H3V5H2ZM11 4H12V5H11ZM2 5H3V6H2ZM10 5H11V6H10ZM2 6H3V7H2ZM9 6H10V7H9ZM2 7H3V8H2ZM8 7H9V8H8ZM13 7H14V8H13ZM2 8H3V9H2ZM7 8H8V9H7ZM13 8H14V9H13ZM2 9H3V10H2ZM13 9H14V10H13ZM2 10H3V11H2ZM13 10H14V11H13ZM2 11H3V12H2ZM13 11H14V12H13ZM2 12H3V13H2ZM13 12H14V13H13ZM2 13H14V14H2Z',
  panel: 'M1 2H15V3H1ZM1 3H2V4H1ZM10 3H11V4H10ZM14 3H15V4H14ZM1 4H2V5H1ZM10 4H11V5H10ZM14 4H15V5H14ZM1 5H2V6H1ZM10 5H11V6H10ZM14 5H15V6H14ZM1 6H2V7H1ZM10 6H11V7H10ZM14 6H15V7H14ZM1 7H2V8H1ZM10 7H11V8H10ZM14 7H15V8H14ZM1 8H2V9H1ZM10 8H11V9H10ZM14 8H15V9H14ZM1 9H2V10H1ZM10 9H11V10H10ZM14 9H15V10H14ZM1 10H2V11H1ZM10 10H11V11H10ZM14 10H15V11H14ZM1 11H2V12H1ZM10 11H11V12H10ZM14 11H15V12H14ZM1 12H2V13H1ZM10 12H11V13H10ZM14 12H15V13H14ZM1 13H15V14H1Z',
  attach: 'M8 1H10V2H8ZM7 2H8V3H7ZM10 2H11V3H10ZM6 3H7V4H6ZM11 3H12V4H11ZM6 4H7V5H6ZM11 4H12V5H11ZM4 5H5V6H4ZM6 5H7V6H6ZM9 5H10V6H9ZM11 5H12V6H11ZM4 6H5V7H4ZM6 6H7V7H6ZM9 6H10V7H9ZM11 6H12V7H11ZM4 7H5V8H4ZM6 7H7V8H6ZM9 7H10V8H9ZM11 7H12V8H11ZM4 8H5V9H4ZM6 8H7V9H6ZM9 8H10V9H9ZM11 8H12V9H11ZM4 9H5V10H4ZM6 9H7V10H6ZM9 9H10V10H9ZM11 9H12V10H11ZM4 10H5V11H4ZM6 10H7V11H6ZM9 10H10V11H9ZM11 10H12V11H11ZM4 11H5V12H4ZM7 11H9V12H7ZM11 11H12V12H11ZM5 12H6V13H5ZM10 12H11V13H10ZM6 13H10V14H6Z',
  send: 'M8 2H9V3H8ZM7 3H10V4H7ZM6 4H7V5H6ZM8 4H9V5H8ZM10 4H11V5H10ZM5 5H6V6H5ZM8 5H9V6H8ZM11 5H12V6H11ZM4 6H5V7H4ZM8 6H9V7H8ZM12 6H13V7H12ZM3 7H4V8H3ZM8 7H9V8H8ZM13 7H14V8H13ZM8 8H9V9H8ZM8 9H9V10H8ZM8 10H9V11H8ZM8 11H9V12H8ZM8 12H9V13H8ZM8 13H9V14H8ZM8 14H9V15H8Z',
  plus: 'M8 2H9V3H8ZM8 3H9V4H8ZM8 4H9V5H8ZM8 5H9V6H8ZM8 6H9V7H8ZM8 7H9V8H8ZM2 8H15V9H2ZM8 9H9V10H8ZM8 10H9V11H8ZM8 11H9V12H8ZM8 12H9V13H8ZM8 13H9V14H8ZM8 14H9V15H8Z',
  disclosure: 'M6 4H7V5H6ZM6 5H8V6H6ZM6 6H9V7H6ZM6 7H10V8H6ZM6 8H10V9H6ZM6 9H9V10H6ZM6 10H8V11H6ZM6 11H7V12H6Z',
}

// scripts/icon.ts: the logo at each side, 1 pt a cell
const LOGOS = {
  24: { ink: 'M3 3H7V4H3ZM2 4H8V5H2ZM2 5H8V6H2ZM2 6H8V7H2ZM2 7H8V8H2ZM4 8H6V9H4ZM3 10H7V11H3ZM2 11H8V12H2ZM2 12H8V13H2ZM2 13H8V14H2ZM2 14H8V15H2ZM2 15H4V16H2ZM6 15H8V16H6ZM2 16H4V17H2ZM6 16H8V17H6ZM2 17H4V18H2ZM6 17H8V18H6ZM2 18H4V19H2ZM6 18H8V19H6ZM2 19H4V20H2ZM6 19H8V20H6ZM2 20H4V21H2ZM6 20H8V21H6Z', accent: 'M17 5H18V6H17ZM19 5H20V6H19ZM17 6H18V7H17ZM16 7H17V8H16ZM18 7H19V8H18ZM16 8H17V9H16ZM19 8H20V9H19ZM17 9H18V10H17ZM11 10H12V11H11ZM13 10H14V11H13ZM18 10H19V11H18ZM11 11H13V12H11ZM14 11H15V12H14ZM10 12H11V13H10ZM12 12H13V13H12ZM14 12H16V13H14ZM8 13H12V14H8ZM13 13H14V14H13ZM15 13H16V14H15ZM9 14H10V15H9ZM11 14H12V15H11ZM13 14H15V15H13ZM8 15H9V16H8ZM10 15H11V16H10ZM12 15H13V16H12ZM14 15H15V16H14ZM11 16H14V17H11ZM11 17H12V18H11ZM9 18H12V19H9ZM8 19H9V20H8ZM10 19H11V20H10ZM8 20H10V21H8Z' },
  36: { ink: 'M5 5H9V6H5ZM4 6H10V7H4ZM3 7H11V8H3ZM3 8H11V9H3ZM3 9H11V10H3ZM3 10H11V11H3ZM3 11H11V12H3ZM4 12H10V13H4ZM5 13H9V14H5ZM3 16H11V17H3ZM2 17H12V18H2ZM2 18H12V19H2ZM2 19H12V20H2ZM2 20H12V21H2ZM2 21H12V22H2ZM2 22H12V23H2ZM2 23H12V24H2ZM3 24H6V25H3ZM8 24H11V25H8ZM3 25H6V26H3ZM8 25H11V26H8ZM3 26H6V27H3ZM8 26H11V27H8ZM3 27H6V28H3ZM8 27H11V28H8ZM3 28H6V29H3ZM8 28H11V29H8ZM3 29H6V30H3ZM8 29H11V30H8ZM3 30H6V31H3ZM8 30H11V31H8ZM3 31H6V32H3ZM8 31H11V32H8Z', accent: 'M25 7H26V8H25ZM27 7H28V8H27ZM28 8H29V9H28ZM30 8H31V9H30ZM24 9H25V10H24ZM26 9H27V10H26ZM31 9H32V10H31ZM25 10H26V11H25ZM27 10H28V11H27ZM29 10H30V11H29ZM23 11H24V12H23ZM25 11H26V12H25ZM30 11H31V12H30ZM32 11H33V12H32ZM24 12H25V13H24ZM26 12H27V13H26ZM28 12H29V13H28ZM24 13H25V14H24ZM27 13H28V14H27ZM29 13H30V14H29ZM31 13H32V14H31ZM23 14H24V15H23ZM25 14H26V15H25ZM27 14H28V15H27ZM30 14H31V15H30ZM17 15H18V16H17ZM19 15H20V16H19ZM26 15H27V16H26ZM28 15H29V16H28ZM15 16H16V17H15ZM17 16H18V17H17ZM19 16H21V17H19ZM14 17H17V18H14ZM18 17H19V18H18ZM20 17H21V18H20ZM14 18H15V19H14ZM16 18H18V19H16ZM19 18H20V19H19ZM21 18H22V19H21ZM12 19H14V20H12ZM15 19H16V20H15ZM17 19H18V20H17ZM19 19H21V20H19ZM22 19H23V20H22ZM13 20H14V21H13ZM15 20H17V21H15ZM18 20H19V21H18ZM20 20H21V21H20ZM22 20H23V21H22ZM12 21H15V22H12ZM16 21H17V22H16ZM18 21H20V22H18ZM21 21H22V22H21ZM23 21H24V22H23ZM12 22H16V23H12ZM17 22H18V23H17ZM19 22H20V23H19ZM21 22H23V23H21ZM13 23H14V24H13ZM15 23H19V24H15ZM20 23H21V24H20ZM22 23H23V24H22ZM12 24H13V25H12ZM16 24H17V25H16ZM18 24H19V25H18ZM20 24H22V25H20ZM15 25H18V26H15ZM19 25H20V26H19ZM15 26H16V27H15ZM17 26H20V27H17ZM13 27H17V28H13ZM18 27H19V28H18ZM12 28H13V29H12ZM14 28H17V29H14ZM12 29H16V30H12ZM13 30H15V31H13ZM12 31H14V32H12Z' },
}

// web/ui/pixels.ts: the letter of a person's tile, in a 12 × 12 grid
const LETTER_M = 'M3 2H4V3H3ZM3 3H4V4H3ZM3 4H4V5H3ZM3 5H4V6H3ZM3 6H4V7H3ZM3 7H4V8H3ZM3 8H4V9H3ZM4 3H5V4H4ZM5 4H6V5H5ZM5 5H6V6H5ZM6 3H7V4H6ZM7 2H8V3H7ZM7 3H8V4H7ZM7 4H8V5H7ZM7 5H8V6H7ZM7 6H8V7H7ZM7 7H8V8H7ZM7 8H8V9H7Z'

// web/ui/dither.ts: the selected row's edge, as a mask of 0.5 px Bayer cells
function selectedEdge(): string {
  let bayer = [[0]]
  for (let k = 0; k < 3; k++) {
    bayer = [...bayer.map((row, y) => [...row.map((v) => v * 4), ...row.map((_, x) => bayer[y]![x]! * 4 + 2)]), ...bayer.map((row, y) => [...row.map((v) => v * 4 + 3), ...row.map((_, x) => bayer[y]![x]! * 4 + 1)])]

  }
  const canvas = document.createElement('canvas')
  canvas.width = 96
  canvas.height = 16
  const context = canvas.getContext('2d')!
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 96; x++) {
      if (((x + 0.5) / 96) ** 1.25 > (bayer[y % 8]![x % 8]! + 0.5) / 64) context.fillRect(x, y, 1, 1)
    }
  }
  return `url("${canvas.toDataURL()}")`
}

const MarkSize = createContext<{ layout: Layout }>({ layout: 'wide' as Layout })

type Phase = 'idle' | 'working' | 'worked'
type S = {
  draft: string
  sent: boolean
  phase: Phase
  elapsed: number
  step: number
  w1: number
  cards: boolean
  w2: number
  leaving: boolean
}

const initial: S = { draft: '', sent: false, phase: 'idle', elapsed: 1, step: 0, w1: 0, cards: false, w2: 0, leaving: false }
const poster: S = { draft: '', sent: true, phase: 'worked', elapsed: 3, step: 2, w1: W1, cards: true, w2: W2, leaving: false }

const REST = { wide: { x: 812, y: 512 }, compact: { x: 236, y: 544 } }

async function script(a: Act<S>) {
  await a.wait(600)
  a.mark('type')
  await a.type('draft', Q, { interval: 26 })
  await a.wait(250)
  a.mark('send')
  await a.click({ at: 'send', x: 0.5, y: 0.5 })
  // The message starts to land before the composer empties, so the words are
  // never gone from both
  a.put({ sent: true })
  void a.move(REST)
  await a.wait(180)
  a.put({ draft: '' })
  await a.wait(450)

  // Shadow works: its step changes as each tool call starts
  a.mark('work')
  a.put({ phase: 'working' })
  await a.wait(1000)
  a.put({ elapsed: 2, step: 1 })
  await a.wait(1000)
  a.put({ elapsed: 3, step: 2 })
  await a.wait(900)

  a.mark('worked')
  a.put({ phase: 'worked' })
  await a.wait(450)

  a.mark('stream')
  for (let i = 1; i <= W1; i++) {
    a.put({ w1: i })
    await a.wait(38)
  }
  await a.wait(250)
  a.mark('cards')
  a.put({ cards: true })
  await a.wait(750)
  for (let i = 1; i <= W2; i++) {
    a.put({ w2: i })
    await a.wait(38)
  }

  a.mark('payoff')
  await a.wait(2600)

  // The exchange fades out as one, then the earlier thread comes back down
  // into its room, so the two never show at once
  a.mark('exit')
  a.put({ leaving: true })
  await a.wait(100)
  a.put({ sent: false, phase: 'idle', w1: 0, cards: false, w2: 0 })
  await a.wait(600)
  await a.snap({ elapsed: 1, step: 0, leaving: false })
  await a.wait(100)
}

export default function ShadowDemo() {
  useLayoutEffect(() => document.documentElement.style.setProperty('--gd-selected', selectedEdge()), [])
  // A phone is touched, never pointed at: the phone column gets the touch
  // cursor. The stage switches to compact below 600, so this does too
  const column = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  useLayoutEffect(() => {
    const observer = new ResizeObserver(([entry]) => setNarrow(entry!.contentRect.width < 600))
    observer.observe(column.current!)
    return () => observer.disconnect()
  }, [])
  return (
    <div ref={column}>
    <Stage
      width={960}
      height={564}
      compact={{ below: 600, width: 358, height: 624 }}
      initial={initial}
      poster={poster}
      script={script}
      cursor={{ at: REST, style: narrow ? 'touch' : 'real' }}
      className="gd"
    >
      {(s, _rect, layout) => <MarkSize.Provider value={{ layout }}><Scene s={s} layout={layout} /></MarkSize.Provider>}
    </Stage>
    </div>
  )
}

function Scene({ s, layout }: { s: S; layout: Layout }) {
  const { theme } = useLook()
  // The phone column gets Shadow's iOS app: the same thread, cropped at the
  // top so the composer and its send button stay whole
  if (layout === 'compact') {
    return (
      <Phone width={326} dark={theme === 'dark'} className="gd-phone">
        <Thread s={s} ios />
      </Phone>
    )
  }
  return (
    <Window className="gd-window" sidebar={<Sidebar />} sidebarWidth={200} lead={<Header />} toolbar={<span className="gd-tool"><Glyph name="panel" /></span>} body={{ className: 'gd-panel' }}>
      <Thread s={s} />
    </Window>
  )
}

function Header() {
  return (
    <span className="gd-title">
      <span className="gd-crumb">general ›</span> Flight home
    </span>
  )
}

function Sidebar() {
  return (
    <nav className="gd-side">
      <div className="gd-nav">
        <NavItem icon="shadow" label="Shadow" />
        <NavItem icon="bell" label="Inbox" />
        <NavItem icon="clock" label="Upcoming" />
        <NavItem icon="search" label="Search" />
      </div>
      <div className="gd-nav">
        <div className="gd-section">Topics</div>
        <NavItem icon="hash" label="general" />
        <div className="gd-sub">
          <NavItem icon="compose" label="Flight home" current />
          <span className="gd-nav-item"><Glyph name="compose" /><Bar w={64} h={5} tone={2} /></span>
        </div>
        {[44, 58, 36, 50, 40, 62, 46].map((w, i) => (
          <span className="gd-nav-item" key={i}><Glyph name="hash" /><Bar w={w} h={5} tone={2} /></span>
        ))}
      </div>
    </nav>
  )
}

function NavItem({ icon, label, current }: { icon: keyof typeof GLYPHS; label: string; current?: boolean }) {
  return (
    <span className="gd-nav-item" data-current={current || undefined}>
      <Glyph name={icon} />
      <span className="gd-nav-label">{label}</span>
    </span>
  )
}

function Thread({ s, ios }: { s: S; ios?: boolean }) {
  const working = s.phase === 'working'
  return (
    <div className="gd-body" data-ios={ios || undefined}>
      <div className="gd-transcript">
        {/* Earlier turns as placeholder: they fill the pane at the start and
            go up out of it as the answer grows */}
        <Message author={<Mark />} name={40} lines={['80%', '62%', '34%']} />
        <Message author={<Person />} name={36} lines={['66%', '52%', '30%']} />
        <Message author={<Mark />} name={40} lines={['86%', '70%', '44%']} />
        {/* The turns before are real, so the thread opens on real messages */}
        <Said author="Mia" time="07:36" text="Is the house locked?" />
        <Said author="Shadow" time="07:36" text="Yes, both doors are locked." />
        <Said author="Mia" time="07:40" text="Our flight home leaves at 16:20." />
        <Said author="Shadow" time="07:40" text="Have a safe flight." />

        <Collapse open={s.sent} reveal="drop" from="below" className="gd-new" data-leaving={s.leaving || undefined}>
          <div className="gd-message">
            <Person />
            <div className="gd-message-body">
              <Meta author="Mia" time="16:05" />
              <p className="gd-text">{Q}</p>
            </div>
          </div>
        </Collapse>

        <Collapse open={s.phase !== 'idle'} reveal="drop" from="below" className="gd-new" data-leaving={s.leaving || undefined}>
          <div className="gd-message">
            <Mark />
            <div className="gd-message-body">
              <Meta author="Shadow" time="16:05" />
              <States
                className="gd-work"
                align="start"
                value={working ? 'working' : 'worked'}
                states={{
                  working: (
                    <span className="gd-work-summary">
                      <PixelSpinner />
                      <span className="gd-shimmer">Working for <Count value={s.elapsed} format={(n) => `${n}s`} duration={420} /></span>
                      <span className="gd-work-now"><Roll variant="fade">{STEPS[s.step]!}</Roll></span>
                    </span>
                  ),
                  worked: (
                    <span className="gd-work-summary">
                      Worked for 3s
                      <span className="gd-disclosure"><Glyph name="disclosure" /></span>
                      <span className="gd-strip" data-on={s.phase === 'worked' || undefined}>
                        {STEPS.map((step) => <i key={step} />)}
                      </span>
                    </span>
                  ),
                }}
              />
              <div className="gd-prose">
                <Collapse open={s.w1 > 0}>
                  <p className="gd-text"><Stream text={A1} count={s.w1} mark={(word) => word.startsWith('22')} /></p>
                </Collapse>
                <Collapse open={s.cards} reveal="drop">
                  <div className="gd-cards" data-on={s.cards || undefined}>
                    {CARDS.map((card) => (
                      <div className="gd-card" key={card.title}>
                        <svg aria-hidden="true" className="gd-card-icon" shapeRendering="crispEdges" viewBox="-2 -2 12 12">
                          <path d={PIXELS[card.icon]} fillRule="evenodd" />
                        </svg>
                        <div className="gd-card-text">
                          <span className="gd-card-title">{card.title}</span>
                          <strong className="gd-card-value">{card.value}</strong>
                          <span className="gd-card-detail">{card.detail}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </Collapse>
                <Collapse open={s.w2 > 0}>
                  <p className="gd-text"><Stream text={A2} count={s.w2} /></p>
                </Collapse>
              </div>
            </div>
          </div>
        </Collapse>
      </div>

      <div className="gd-composer">
        {ios && <span className="gd-add"><Glyph name="plus" /></span>}
        <Grow className="gd-input">
          {/* Leaves on the first character, fades back once the composer empties */}
          <span className="gd-placeholder" data-typing data-hidden={s.draft ? true : undefined}>Message #general</span>
          {s.draft}
          {/* Keyed on the length, so every keystroke restarts the blink from solid */}
          {s.draft && <span key={s.draft.length} className="gd-caret" />}
        </Grow>
        <div className="gd-actions">
          {!ios && <span className="gd-attach"><Glyph name="attach" /></span>}
          <span className="gd-send" data-target="send" data-cursor="pointer"><Glyph name="send" /></span>
        </div>
      </div>
    </div>
  )
}

// The composer grows a line at a time as the request wraps, and back on send,
// easing its height so the thread above moves with it instead of jumping
function Grow({ className, children }: { className: string; children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState<number>()
  useLayoutEffect(() => {
    const node = inner.current!
    const observer = new ResizeObserver(() => setHeight(node.offsetHeight))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return (
    <div className="gd-grow" style={{ height }}>
      {/* The text itself wraps at once as it is typed; the box around it eases */}
      <div ref={inner} className={className} data-snap>{children}</div>
    </div>
  )
}

function Message({ author, name, lines }: { author: ReactNode; name: number; lines: string[] }) {
  return (
    <div className="gd-message gd-past">
      {author}
      <div className="gd-message-body">
        <span className="gd-meta"><Bar w={name} h={6} tone={3} /><Bar w={28} h={5} tone={2} /></span>
        <span className="gd-past-lines">
          {lines.map((w, i) => <Bar key={i} w={w} h={7} r={3} tone={2} />)}
        </span>
      </div>
    </div>
  )
}

function Said({ author, time, text }: { author: 'Mia' | 'Shadow'; time: string; text: string }) {
  return (
    <div className="gd-message">
      {author === 'Mia' ? <Person /> : <Mark />}
      <div className="gd-message-body">
        <Meta author={author} time={time} />
        <p className="gd-text">{text}</p>
      </div>
    </div>
  )
}

function Meta({ author, time }: { author: string; time: string }) {
  return (
    <span className="gd-meta">
      <span className="gd-author">{author}</span>
      <span className="gd-time">{time}</span>
    </span>
  )
}

function Person() {
  return (
    <span className="gd-avatar" aria-hidden="true">
      <svg fill="currentColor" shapeRendering="crispEdges" viewBox="0 0 12 12"><path d={LETTER_M} /></svg>
    </span>
  )
}

// web/ui/components.tsx (Mark): one drawing at every size, with one expression
function Mark() {
  const { layout } = useContext(MarkSize)
  const side = layout === 'compact' ? 36 : 24
  return (
    <svg aria-hidden="true" className="gd-face" shapeRendering="crispEdges" viewBox={`0 0 ${side} ${side}`}>
      <path d={LOGOS[side].ink} fill="#ffffff" />
      <path d={LOGOS[side].accent} fill="#c8603f" />
    </svg>
  )
}

function PixelSpinner() {
  return (
    <span className="gd-spinner" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  )
}

function Glyph({ name }: { name: keyof typeof GLYPHS }) {
  return (
    <svg aria-hidden="true" className="gd-icon" fill="currentColor" shapeRendering="crispEdges" viewBox="0 0 16 16">
      <path d={GLYPHS[name]} />
    </svg>
  )
}
