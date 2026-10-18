import { createFileRoute } from '@tanstack/react-router'
import { AppShell } from '@/components/layout/AppShell'
import { ProtectedRoute } from '@/components/layout/ProtectedRoute'
import { WorkspaceView } from '@/components/canvas/WorkspaceView'
import { FreeStudioView } from '@/components/studio/FreeStudioView'
import { useAuth } from '@/hooks/use-auth'

export const Route = createFileRoute('/canvas/$id')({
  validateSearch: (search: Record<string, unknown>): { session?: string; task?: string } => {
    // 可选参数：缺省时不要往 URL 里塞空串，否则所有 Link 都被要求显式传 search
    const out: { session?: string; task?: string } = {}
    if (typeof search.session === 'string' && search.session) out.session = search.session
    if (typeof search.task === 'string' && search.task) out.task = search.task
    return out
  },
  component: CanvasPage,
})

function CanvasPage() {
  const { id } = Route.useParams()
  const { session, task } = Route.useSearch()
  const { isPro } = useAuth()
  return (
    <ProtectedRoute>
      <AppShell>
        {/* 画布属 Pro 能力：普通用户拿到旧链接时落到创作台，而不是一片空白画布 */}
        {isPro ? (
          <WorkspaceView initialCanvasId={id} sessionId={session ?? ''} taskId={task} />
        ) : (
          <FreeStudioView />
        )}
      </AppShell>
    </ProtectedRoute>
  )
}
