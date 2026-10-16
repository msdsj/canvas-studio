import { useTranslation } from 'react-i18next'
import { LayoutGrid } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { ProjectCard } from './ProjectCard'
import type { CanvasProject } from '@/types/models'

interface ProjectListProps {
  projects: CanvasProject[]
  loading?: boolean
  onOpen: (project: CanvasProject) => void
  onCreate?: () => void
  onRename?: (project: CanvasProject) => void
  onDelete?: (project: CanvasProject) => void
}

/** 项目列表。 */
export function ProjectList({ projects, loading, onOpen, onCreate, onRename, onDelete }: ProjectListProps) {
  const { t } = useTranslation('projects')

  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="aspect-[4/3] w-full" />
        ))}
      </div>
    )
  }

  if (projects.length === 0) {
    return (
      <EmptyState
        icon={LayoutGrid}
        title={t('empty.title')}
        description={t('empty.desc')}
        action={onCreate ? { label: t('empty.cta'), onClick: onCreate } : undefined}
      />
    )
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {projects.map((project) => (
        <ProjectCard key={project.id} project={project} onOpen={onOpen} onRename={onRename} onDelete={onDelete} />
      ))}
    </div>
  )
}
