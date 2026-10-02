import { useEffect, useRef, useState } from 'react'
import type { CurvePoint } from '@shared/summary'

// diverging pair (validated for the dark surface: lightness band, CVD ΔE 23)
const AHEAD = '#2f95dc'
const BEHIND = '#e2553f'

const clock = (s: number): string => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
const kfmt = (g: number): string => `${g > 0 ? '+' : g < 0 ? '−' : ''}${(Math.abs(g) / 1000).toFixed(1)}k`

/**
 * Gold lead over time from your team's point of view – blue above the line (ahead), red below
 * (behind) – with every champion kill as a dot on the strip underneath. Hover for exact values.
 */
export function WinCurve({ curve, kills, duration }: { curve: CurvePoint[]; kills: { t: number; ally: boolean }[]; duration: number }) {
  const box = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(800)
  const [hover, setHover] = useState<number | null>(null)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  if (curve.length < 2) return <p className="text-sm text-muted">No timeline for this game.</p>
  const H = 220
  const pad = { l: 48, r: 14, t: 12, b: 26 }
  const strip = 22
  const tMax = Math.max(duration, curve[curve.length - 1].t)
  const gMax = Math.max(1000, ...curve.map((p) => Math.abs(p.gold))) * 1.12
  const x = (t: number) => pad.l + (t / tMax) * (w - pad.l - pad.r)
  const y = (g: number) => pad.t + ((gMax - g) / (2 * gMax)) * (H - pad.t - pad.b - strip)
  const zero = y(0)
  const line = curve.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.gold).toFixed(1)}`).join('')
  const area = `${line}L${x(curve[curve.length - 1].t)},${zero}L${x(curve[0].t)},${zero}Z`
  const ticksY = [-gMax / 1.12, -gMax / 2.24, 0, gMax / 2.24, gMax / 1.12].map((g) => Math.round(g / 500) * 500)
  const ticksX = Array.from({ length: Math.floor(tMax / 300) + 1 }, (_, i) => i * 300)
  const hp = hover !== null ? curve[hover] : null

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const t = ((e.clientX - r.left - pad.l) / (w - pad.l - pad.r)) * tMax
    let best = 0
    curve.forEach((p, i) => {
      if (Math.abs(p.t - t) < Math.abs(curve[best].t - t)) best = i
    })
    setHover(best)
  }

  return (
    <div ref={box} className="relative w-full">
      <svg width={w} height={H} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label="Gold lead over time">
        <defs>
          <clipPath id="wc-above">
            <rect x={0} y={0} width={w} height={zero} />
          </clipPath>
          <clipPath id="wc-below">
            <rect x={0} y={zero} width={w} height={H} />
          </clipPath>
        </defs>
        {ticksY.map((g) => (
          <g key={g}>
            <line x1={pad.l} x2={w - pad.r} y1={y(g)} y2={y(g)} stroke="rgb(255 255 255 / 0.07)" />
            <text x={pad.l - 8} y={y(g) + 4} textAnchor="end" fontSize="10" fill="#a39cc0">
              {g === 0 ? '0' : kfmt(g)}
            </text>
          </g>
        ))}
        {ticksX.map((t) => (
          <text key={t} x={x(t)} y={H - 6} textAnchor="middle" fontSize="10" fill="#a39cc0">
            {t / 60}m
          </text>
        ))}
        <path d={area} fill={AHEAD} fillOpacity={0.22} clipPath="url(#wc-above)" />
        <path d={area} fill={BEHIND} fillOpacity={0.22} clipPath="url(#wc-below)" />
        <path d={line} fill="none" stroke={AHEAD} strokeWidth={2} clipPath="url(#wc-above)" strokeLinejoin="round" />
        <path d={line} fill="none" stroke={BEHIND} strokeWidth={2} clipPath="url(#wc-below)" strokeLinejoin="round" />
        <line x1={pad.l} x2={w - pad.r} y1={zero} y2={zero} stroke="rgb(255 255 255 / 0.35)" />
        <text x={w - pad.r} y={pad.t + 10} textAnchor="end" fontSize="11" fontWeight="700" fill="#f1edfb">
          ▲ ahead
        </text>
        <text x={w - pad.r} y={H - pad.b - strip - 4} textAnchor="end" fontSize="11" fontWeight="700" fill="#f1edfb">
          ▼ behind
        </text>
        {/* kills strip */}
        {kills.map((kk, i) => (
          <circle
            key={i}
            cx={x(kk.t)}
            cy={H - pad.b - strip / 2 + (kk.ally ? -4 : 4)}
            r={4}
            fill={kk.ally ? AHEAD : BEHIND}
            stroke="#140d28"
            strokeWidth={2}
          />
        ))}
        {hp && (
          <g>
            <line x1={x(hp.t)} x2={x(hp.t)} y1={pad.t} y2={H - pad.b} stroke="rgb(255 255 255 / 0.4)" strokeDasharray="3 3" />
            <circle cx={x(hp.t)} cy={y(hp.gold)} r={5} fill={hp.gold >= 0 ? AHEAD : BEHIND} stroke="#140d28" strokeWidth={2} />
          </g>
        )}
      </svg>
      {hp && (
        <div
          className="pointer-events-none absolute top-2 rounded-lg border border-white/15 bg-[#120b24] px-2.5 py-1.5 text-xs shadow-xl"
          style={{ left: Math.min(w - 150, Math.max(0, x(hp.t) + 10)) }}
        >
          <div className="font-bold text-text">{clock(hp.t)}</div>
          <div className="text-text">
            Gold: <b>{kfmt(hp.gold)}</b>
          </div>
          <div className="text-muted">
            Kills: {hp.kills > 0 ? '+' : ''}
            {hp.kills}
          </div>
        </div>
      )}
      <div className="mt-1 flex items-center gap-4 text-[11px] text-muted">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: AHEAD }} /> your team ahead · your kills
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: BEHIND }} /> behind · enemy kills
        </span>
      </div>
    </div>
  )
}
