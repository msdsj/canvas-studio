import { useEffect, useState } from 'react'

/** 值防抖。 */
export function useDebounce<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

/** 函数防抖（返回稳定引用）。 */
export function useDebouncedCallback<A extends unknown[]>(
  callback: (...args: A) => void,
  delay = 300
): (...args: A) => void {
  const [timer, setTimer] = useState<ReturnType<typeof setTimeout> | null>(null)
  return (...args: A) => {
    if (timer) clearTimeout(timer)
    setTimer(setTimeout(() => callback(...args), delay))
  }
}
