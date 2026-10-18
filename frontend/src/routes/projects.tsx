import { useCallback, useEffect, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import { AppShell } from '@/components/layout/AppShell'
import { ProtectedRoute } from '@/components/layout/ProtectedRoute'
import { PageShell } from '@/components/layout/PageShell'
import { Button } from '@/components/ui/button'
import { Pagination } from '@/components/ui/pagination'
import { ProjectList } from '@/components/projects/ProjectList'
import {
  CreateProjectDialog,
  DeleteProjectDialog,
  RenameProjectDialog,
} from '@/components/projects/ProjectDialogs'
import { projectsApi } from '@/lib/api/projects'
import { useToast } from '@/hooks/use-toast'
import { errorMessage } from '@/lib/errors'
import type { CanvasProject } from '@/types/models'

export const Route = createFileRoute('/projects')({
  component: ProjectsPage,
})

function ProjectsPage() {
  const { t } = useTranslation('projects')
  const { t: te } = useTranslation()
  const toast = useToast()
  const navigate = useNavigate()

  const [projects, setProjects] = useState<CanvasProject[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(20)
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<CanvasProject | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<CanvasProject | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await projectsApi.list({ page, size })
      setProjects(result.items)
      setTotal(result.total)
    } catch (error) {
      toast.error(errorMessage(error, te))
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, size])

  useEffect(() => {
    void load()
  }, [load])

  const openProject = async (project: CanvasProject) => {
    try {
      const canvases = await projectsApi.listCanvases(project.id)
      if (canvases.length > 0) {
        void navigate({ to: '/canvas/$id', params: { id: canvases[0].id } })
      }
    } catch (error) {
      toast.error(errorMessage(error, te))
    }
  }

  return (
    <ProtectedRoute>
      <AppShell>
          <PageShell
            title={t('title')}
            actions={
              <Button onClick={() => setCreateOpen(true)}>
                <Plus size={16} /> {t('create')}
              </Button>
            }
          >
            <ProjectList
              projects={projects}
              loading={loading}
              onOpen={openProject}
              onCreate={() => setCreateOpen(true)}
              onRename={setRenameTarget}
              onDelete={setDeleteTarget}
            />

            <Pagination
              page={page}
              size={size}
              total={total}
              onPageChange={setPage}
              onSizeChange={(s) => {
                setSize(s)
                setPage(1)
              }}
            />
          </PageShell>
      </AppShell>

      <CreateProjectDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSubmit={async (name, description) => {
          await projectsApi.create(name, description)
          toast.success(t('common:status.success', { defaultValue: '创建成功' }))
          void load()
        }}
      />
      <RenameProjectDialog
        project={renameTarget}
        onOpenChange={(open) => !open && setRenameTarget(null)}
        onSubmit={async (name) => {
          if (!renameTarget) return
          await projectsApi.update(renameTarget.id, name)
          void load()
        }}
      />
      <DeleteProjectDialog
        project={deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return
          await projectsApi.remove(deleteTarget.id)
          toast.success(t('common:status.success', { defaultValue: '已删除' }))
          void load()
        }}
      />
    </ProtectedRoute>
  )
}
