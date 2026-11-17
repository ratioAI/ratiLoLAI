import { useEffect, useRef } from 'react'
import { constellationOf, rankColor, type AchievementRank } from '@shared/achievements'

const css = (rgb: number[], alpha = 1): string =>
  `rgba(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)}, ${alpha})`

/** Seconds until every star is lit and every line drawn. */
export const REVEAL_S = 2.5

/**
 * An achievement's constellation drawing itself: the stars light up one after another, then the
 * lines are drawn star to star (about 2.5 s in all), then it glows on quietly. Canvas 2D, main
 * window only. `animate` false draws the finished picture straight away.
 */
export function ConstellationReveal({
  id,
  rank,
  size = 120,
  animate = true,
  className = ''
}: {
  id: string
  rank: AchievementRank
  size?: number
  animate?: boolean
  className?: string
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    const scale = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(size * scale)
    canvas.height = Math.round(size * scale)
    context.setTransform(scale, 0, 0, scale, 0, 0)
    const { flat, mags, lines } = constellationOf(id)
    const pad = size * 0.14
    const at = (i: number): [number, number] => [size / 2 + flat[i][0] * (size / 2 - pad), size / 2 + flat[i][1] * (size / 2 - pad)]
    const colour = (i: number) => rankColor(rank, flat.length > 1 ? i / (flat.length - 1) : 0)
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    const starsEnd = REVEAL_S * 0.4
    const started = performance.now()
    let raf = 0

    const draw = (seconds: number): void => {
      context.clearRect(0, 0, size, size)
      context.lineCap = 'round'
      // lines, one after the other along the spanning tree
      const lineTime = (REVEAL_S - starsEnd) / Math.max(1, lines.length)
      lines.forEach(([a, b], n) => {
        const progress = Math.min(1, Math.max(0, (seconds - starsEnd - n * lineTime) / lineTime))
        if (progress <= 0) return
        const [ax, ay] = at(a)
        const [bx, by] = at(b)
        const gradient = context.createLinearGradient(ax, ay, bx, by)
        gradient.addColorStop(0, css(colour(a), 0.75))
        gradient.addColorStop(1, css(colour(b), 0.75))
        context.strokeStyle = gradient
        context.lineWidth = Math.max(1, size / 110)
        context.shadowColor = css(colour(a), 0.9)
        context.shadowBlur = size / 22
        context.beginPath()
        context.moveTo(ax, ay)
        context.lineTo(ax + (bx - ax) * progress, ay + (by - ay) * progress)
        context.stroke()
      })
      context.shadowBlur = 0
      // stars pop in one by one, then twinkle a little
      flat.forEach((_, i) => {
        const appear = Math.min(1, Math.max(0, (seconds - (i * starsEnd) / flat.length) / 0.25))
        if (appear <= 0) return
        const [x, y] = at(i)
        const twinkle = seconds > REVEAL_S ? 0.85 + 0.15 * Math.sin(seconds * 2.4 + i * 1.7) : 1
        const radius = (size / 46) * (0.6 + 0.6 * mags[i]) * (appear < 1 ? 0.5 + appear * 0.8 : 1) * twinkle
        const glow = context.createRadialGradient(x, y, 0, x, y, radius * 4)
        glow.addColorStop(0, css(colour(i), 0.85 * appear))
        glow.addColorStop(1, css(colour(i), 0))
        context.fillStyle = glow
        context.beginPath()
        context.arc(x, y, radius * 4, 0, Math.PI * 2)
        context.fill()
        context.fillStyle = `rgba(255, 255, 255, ${appear})`
        context.beginPath()
        context.arc(x, y, radius * 0.7, 0, Math.PI * 2)
        context.fill()
      })
    }

    if (!animate || reduced) {
      draw(REVEAL_S)
      return
    }
    const frame = (now: number) => {
      const seconds = (now - started) / 1000
      draw(seconds)
      // after the reveal it glows on for a while at a low frame rate, then stops
      if (seconds < REVEAL_S + 8) raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [id, rank, size, animate])
  return <canvas ref={ref} className={className} style={{ width: size, height: size }} aria-hidden />
}
