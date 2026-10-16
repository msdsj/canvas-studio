import { createFileRoute } from '@tanstack/react-router'
import { AppShell } from '@/components/layout/AppShell'
import { ProtectedRoute } from '@/components/layout/ProtectedRoute'
import { WorkspaceView } from '@/components/canvas/WorkspaceView'

export const Route = createFileRoute('/canvas/$id')({
  validateSearch: (search: Record<string, unknown>) => ({
    session: typeof search.session === 'string' ? search.session : '',
    task: typeof search.task === 'string' ? search.task : '',
  }),
  component: CanvasPage,
})

function CanvasPage() {
  const { id } = Route.useParams()
  const { session, task } = Route.useSearch()
  return (
    <ProtectedRoute>
      <AppShell>
        <WorkspaceView initialCanvasId={id} sessionId={session} taskId={task} />
      </AppShell>
    </ProtectedRoute>
  )
}
