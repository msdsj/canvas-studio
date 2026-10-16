import { useEffect, useState } from 'react'

const MOBILE_BREAKPOINT = 768

/** 断点判定（md 以下视为移动端）。 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window === 'undefined' ? false : window.innerWidth < MOBILE_BREAKPOINT
  )

  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const handler = () => setIsMobile(query.matches)
    handler()
    query.addEventListener('change', handler)
    return () => query.removeEventListener('change', handler)
  }, [])

  return isMobile
}
