import { createFileRoute } from '@tanstack/react-router'
import { AppShell } from '@/components/layout/AppShell'
import { ProtectedRoute } from '@/components/layout/ProtectedRoute'
import { WorkspaceView } from '@/components/canvas/WorkspaceView'

export const Route = createFileRoute('/workspace')({
  validateSearch: (search: Record<string, unknown>): { session?: string; task?: string } => {
    // 可选参数：缺省时不要往 URL 里塞空串，否则所有 Link 都被要求显式传 search
    const out: { session?: string; task?: string } = {}
    if (typeof search.session === 'string' && search.session) out.session = search.session
    if (typeof search.task === 'string' && search.task) out.task = search.task
    return out
  },
  component: WorkspacePage,
})

function WorkspacePage() {
  const { session, task } = Route.useSearch()
  return (
    <ProtectedRoute>
      <AppShell>
        <WorkspaceView sessionId={session ?? ''} taskId={task} />
      </AppShell>
    </ProtectedRoute>
  )
}
