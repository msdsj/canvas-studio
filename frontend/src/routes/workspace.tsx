import { createFileRoute } from '@tanstack/react-router'
import { AppShell } from '@/components/layout/AppShell'
import { ProtectedRoute } from '@/components/layout/ProtectedRoute'
import { WorkspaceView } from '@/components/canvas/WorkspaceView'

export const Route = createFileRoute('/workspace')({
  validateSearch: (search: Record<string, unknown>) => ({
    session: typeof search.session === 'string' ? search.session : '',
    task: typeof search.task === 'string' ? search.task : '',
  }),
  component: WorkspacePage,
})

function WorkspacePage() {
  const { session, task } = Route.useSearch()
  return (
    <ProtectedRoute>
      <AppShell>
        <WorkspaceView sessionId={session} taskId={task} />
      </AppShell>
    </ProtectedRoute>
  )
}
