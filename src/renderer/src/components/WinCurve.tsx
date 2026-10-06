import { useEffect, useRef, useState } from 'react'
import type { CurvePoint } from '@shared/summary'

// diverging blue/red pair, checked on the dark background (colour-blind ΔE 23)
const AHEAD = '#2f95dc'
const BEHIND = '#e2553f'

const clock = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`
const formatGold = (gold: number): string => `${gold > 0 ? '+' : gold < 0 ? '−' : ''}${(Math.abs(gold) / 1000).toFixed(1)}k`

/**
 * Gold lead over time from your team's side (blue above zero, red below), with each champion kill
 * as a dot on a strip underneath. Hovering shows exact values.
 */
export function WinCurve({
  curve,
  kills,
  duration,
  height = 220
}: {
  curve: CurvePoint[]
  kills: { t: number; ally: boolean }[]
  duration: number
  height?: number
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(800)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const observer = new ResizeObserver(() => setW(box.clientWidth))
    observer.observe(box)
    setW(box.clientWidth)
    return () => observer.disconnect()
  }, [])

  if (curve.length < 2) return <p className="text-sm text-muted">No timeline for this game.</p>
  const H = height
  const pad = { l: 48, r: 14, t: 12, b: 26 }
  const strip = 22 // height of the kill strip under the chart
  const maxTime = Math.max(duration, curve[curve.length - 1].t)
  // symmetric y range with 12% headroom; ticks below divide that back out to land on the real max
  const maxGold = Math.max(1000, ...curve.map((point) => Math.abs(point.gold))) * 1.12
  const x = (t: number) => pad.l + (t / maxTime) * (w - pad.l - pad.r)
  const y = (gold: number) => pad.t + ((maxGold - gold) / (2 * maxGold)) * (H - pad.t - pad.b - strip)
  const zero = y(0)
  const line = curve.map((point, i) => `${i ? 'L' : 'M'}${x(point.t).toFixed(1)},${y(point.gold).toFixed(1)}`).join('')
  const area = `${line}L${x(curve[curve.length - 1].t)},${zero}L${x(curve[0].t)},${zero}Z`
  const ticksY = [-maxGold / 1.12, -maxGold / 2.24, 0, maxGold / 2.24, maxGold / 1.12].map((gold) => Math.round(gold / 500) * 500)
  const ticksX = Array.from({ length: Math.floor(maxTime / 300) + 1 }, (_, i) => i * 300) // every 5 min
  const hovered = hoverIndex !== null ? curve[hoverIndex] : null

  // snap the hover to the curve point closest in time to the cursor
  const onMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const t = ((event.clientX - rect.left - pad.l) / (w - pad.l - pad.r)) * maxTime
    let best = 0
    curve.forEach((point, i) => {
      if (Math.abs(point.t - t) < Math.abs(curve[best].t - t)) best = i
    })
    setHoverIndex(best)
  }

  return (
    <div ref={boxRef} className="relative w-full">
      <svg width={w} height={H} onMouseMove={onMove} onMouseLeave={() => setHoverIndex(null)} role="img" aria-label="Gold lead over time">
        <defs>
          <clipPath id="wc-above">
            <rect x={0} y={0} width={w} height={zero} />
          </clipPath>
          <clipPath id="wc-below">
            <rect x={0} y={zero} width={w} height={H} />
          </clipPath>
        </defs>
        {ticksY.map((gold) => (
          <g key={gold}>
            <line x1={pad.l} x2={w - pad.r} y1={y(gold)} y2={y(gold)} stroke="rgb(255 255 255 / 0.07)" />
            <text x={pad.l - 8} y={y(gold) + 4} textAnchor="end" fontSize="10" fill="#a39cc0">
              {gold === 0 ? '0' : formatGold(gold)}
            </text>
          </g>
        ))}
        {ticksX.map((t) => (
          <text key={t} x={x(t)} y={H - 6} textAnchor="middle" fontSize="10" fill="#a39cc0">
            {t / 60}m
          </text>
        ))}
        <path
          d={area}
          fill={AHEAD}
          fillOpacity={0.22}
          clipPath="url(#wc-above)"
          className="page-enter"
          style={{ animationDelay: '0.5s' }}
        />
        <path
          d={area}
          fill={BEHIND}
          fillOpacity={0.22}
          clipPath="url(#wc-below)"
          className="page-enter"
          style={{ animationDelay: '0.5s' }}
        />
        <path
          d={line}
          fill="none"
          stroke={AHEAD}
          strokeWidth={2}
          clipPath="url(#wc-above)"
          strokeLinejoin="round"
          pathLength={1}
          strokeDasharray={1}
          className="draw-line"
        />
        <path
          d={line}
          fill="none"
          stroke={BEHIND}
          strokeWidth={2}
          clipPath="url(#wc-below)"
          strokeLinejoin="round"
          pathLength={1}
          strokeDasharray={1}
          className="draw-line"
        />
        <line x1={pad.l} x2={w - pad.r} y1={zero} y2={zero} stroke="rgb(255 255 255 / 0.35)" />
        <text x={w - pad.r} y={pad.t + 10} textAnchor="end" fontSize="11" fontWeight="700" fill="#f1edfb">
          ▲ ahead
        </text>
        <text x={w - pad.r} y={H - pad.b - strip - 4} textAnchor="end" fontSize="11" fontWeight="700" fill="#f1edfb">
          ▼ behind
        </text>
        {/* kill strip: ally kills slightly above the middle, enemy kills below */}
        {kills.map((kill, i) => (
          <circle
            key={i}
            cx={x(kill.t)}
            cy={H - pad.b - strip / 2 + (kill.ally ? -4 : 4)}
            r={4}
            className="pop-in"
            style={{ animationDelay: `${0.3 + (kill.t / maxTime) * 1.2}s`, transformBox: 'fill-box', transformOrigin: 'center' }}
            fill={kill.ally ? AHEAD : BEHIND}
            stroke="#140d28"
            strokeWidth={2}
          />
        ))}
        {hovered && (
          <g>
            <line x1={x(hovered.t)} x2={x(hovered.t)} y1={pad.t} y2={H - pad.b} stroke="rgb(255 255 255 / 0.4)" strokeDasharray="3 3" />
            <circle
              cx={x(hovered.t)}
              cy={y(hovered.gold)}
              r={5}
              fill={hovered.gold >= 0 ? AHEAD : BEHIND}
              stroke="#140d28"
              strokeWidth={2}
            />
          </g>
        )}
      </svg>
      {hovered && (
        <div
          className="pointer-events-none absolute top-2 rounded-lg border border-white/15 bg-[#120b24] px-2.5 py-1.5 text-xs shadow-xl"
          style={{ left: Math.min(w - 150, Math.max(0, x(hovered.t) + 10)) }}
        >
          <div className="font-bold text-text">{clock(hovered.t)}</div>
          <div className="text-text">
            Gold: <b>{formatGold(hovered.gold)}</b>
          </div>
          <div className="text-muted">
            Kills: {hovered.kills > 0 ? '+' : ''}
            {hovered.kills}
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
