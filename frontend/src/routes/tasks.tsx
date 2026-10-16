import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { AppShell } from '@/components/layout/AppShell'
import { ProtectedRoute } from '@/components/layout/ProtectedRoute'
import { AppSidebar } from '@/components/layout/WorkspaceLeftbar'
import { ActiveTasksPanel } from '@/components/chat/ActiveTasksPanel'

export const Route = createFileRoute('/tasks')({
  component: TasksPage,
})

function TasksPage() {
  const { t } = useTranslation('chat')
  return (
    <ProtectedRoute>
      <AppShell>
        <div className="flex h-full">
          <AppSidebar />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="border-b border-border bg-surface px-6 py-4">
              <h1 className="text-xl font-semibold text-text">{t('active_panel.title')}</h1>
            </div>
            <ActiveTasksPanel />
          </div>
        </div>
      </AppShell>
    </ProtectedRoute>
  )
}
