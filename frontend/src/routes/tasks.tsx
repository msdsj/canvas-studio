import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { AppShell } from '@/components/layout/AppShell'
import { ProtectedRoute } from '@/components/layout/ProtectedRoute'
import { PageShell } from '@/components/layout/PageShell'
import { ActiveTasksPanel } from '@/components/chat/ActiveTasksPanel'

export const Route = createFileRoute('/tasks')({
  component: TasksPage,
})

function TasksPage() {
  const { t } = useTranslation('chat')
  return (
    <ProtectedRoute>
      <AppShell>
          <PageShell title={t('active_panel.title')}>
            <ActiveTasksPanel />
          </PageShell>
      </AppShell>
    </ProtectedRoute>
  )
}
