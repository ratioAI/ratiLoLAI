import { useEffect, useRef, type MutableRefObject } from 'react'

/**
 * true while an animation nobody can see should rest: the window is hidden, or a game is running
 * and ratioAI is not the focused window (it sits behind the game). Kept in a ref so render loops can
 * read it every frame without re-creating their WebGL context.
 */
export function useIdleRef(inGame: boolean): MutableRefObject<boolean> {
  const ref = useRef(false)
  useEffect(() => {
    const update = (): void => {
      ref.current = document.hidden || (inGame && !document.hasFocus())
    }
    update()
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [inGame])
  return ref
}
