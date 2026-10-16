import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Progress } from '@/components/ui/progress'
import type { PoolProgress } from '@/lib/api/admin'

interface PoolRefreshProgressProps {
  jobId: string | null
  fetcher: (jobId: string) => Promise<PoolProgress>
  onDone?: () => void
}

/** 刷新 / re-login 进度（轮询）。 */
export function PoolRefreshProgress({ jobId, fetcher, onDone }: PoolRefreshProgressProps) {
  const { t } = useTranslation('admin')
  const [progress, setProgress] = useState<PoolProgress | null>(null)
  const doneRef = useRef(false)

  useEffect(() => {
    if (!jobId) {
      setProgress(null)
      doneRef.current = false
      return
    }
    doneRef.current = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const poll = async () => {
      try {
        const data = await fetcher(jobId)
        setProgress(data)
        const total = data.total ?? 0
        const done = data.done ?? 0
        if (data.status === 'done' || data.status === 'finished' || (total > 0 && done >= total)) {
          if (!doneRef.current) {
            doneRef.current = true
            onDone?.()
          }
          return
        }
      } catch {
        /* ignore，继续轮询 */
      }
      timer = setTimeout(poll, 1200)
    }
    void poll()
    return () => {
      if (timer) clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId])

  if (!jobId || !progress) return null
  const total = progress.total ?? 0
  const done = progress.done ?? 0
  const pct = total > 0 ? Math.round((done / total) * 100) : 0

  return (
    <div className="rounded-md border border-border bg-surface p-3">
      <div className="mb-2 text-sm text-text-secondary">{t('pool.refreshing', { done, total })}</div>
      <Progress value={pct} />
    </div>
  )
}
