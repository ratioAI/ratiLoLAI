import { useEffect, useRef, type MutableRefObject } from 'react'

/**
 * True when nobody can see our animations: the window is hidden, or a game is running and ratioAI
 * sits unfocused behind it. It's a ref so render loops can check it every frame without restarting.
 */
export function useIdleRef(inGame: boolean): MutableRefObject<boolean> {
  const idleRef = useRef(false)
  useEffect(() => {
    const update = (): void => {
      idleRef.current = document.hidden || (inGame && !document.hasFocus())
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
  return idleRef
}
