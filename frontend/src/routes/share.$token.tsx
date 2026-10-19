import { useEffect, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Sparkles } from 'lucide-react'
import type { ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types'
import { CanvasExcali } from '@/components/canvas/CanvasExcali'
import { normalizeScene } from '@/components/canvas/canvas-helpers'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { EmptyState } from '@/components/ui/empty-state'
import { canvasesApi } from '@/lib/api/canvases'
import { useTheme } from '@/hooks/use-theme'

export const Route = createFileRoute('/share/$token')({
  component: SharePage,
})

function SharePage() {
  const { t } = useTranslation('canvas')
  const { token } = Route.useParams()
  const { resolved } = useTheme()
  const [name, setName] = useState('')
  const [initialData, setInitialData] = useState<ExcalidrawInitialDataState | undefined>(undefined)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    canvasesApi
      .getShared(token)
      .then((canvas) => {
        setName(canvas.name)
        setInitialData(normalizeScene(canvas.state) as unknown as ExcalidrawInitialDataState)
        setState('ready')
      })
      .catch(() => setState('error'))
  }, [token])

  return (
    <div className="flex h-screen flex-col bg-bg">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border-faint bg-surface px-4">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand text-text-inverse">
            <Sparkles size={16} />
          </span>
          <span className="text-md font-semibold text-text">{name || 'zleap Canvas'}</span>
        </div>
        <span className="text-micro text-text-tertiary">{t('share.readonly')}</span>
      </header>

      <main className="min-h-0 flex-1">
        {state === 'loading' && (
          <div className="flex h-full items-center justify-center">
            <Spinner size={28} />
          </div>
        )}
        {state === 'error' && (
          <div className="flex h-full items-center justify-center">
            <EmptyState
              title="分享链接无效"
              description="该分享可能已关闭或已被删除。"
              action={{ label: '返回首页', onClick: () => (window.location.href = '/') }}
            />
          </div>
        )}
        {state === 'ready' && initialData && (
          <CanvasExcali initialData={initialData} theme={resolved} viewMode />
        )}
      </main>

      {state === 'error' && (
        <div className="flex justify-center pb-6">
          <Link to="/login">
            <Button variant="secondary" size="sm">
              去登录
            </Button>
          </Link>
        </div>
      )}
    </div>
  )
}
