import { useTranslation } from 'react-i18next'
import { LayoutGrid } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { ProjectCard, ProjectGhostCard } from './ProjectCard'
import type { CanvasProject } from '@/types/models'

interface ProjectListProps {
  projects: CanvasProject[]
  loading?: boolean
  onOpen: (project: CanvasProject) => void
  onCreate?: () => void
  onRename?: (project: CanvasProject) => void
  onDelete?: (project: CanvasProject) => void
}

/**
 * 项目列表。
 *
 * v3 改动：
 * - 列数从固定 4 列改成自适应（xl 4 列 / lg 3 / sm 2），卡片在 1440 视口下不再
 *   只有 210px 宽、孤零零地贴在左上角；
 * - 网格第一位常驻「新建」幽灵卡：只有一个项目时页面不再是 80% 空白；
 * - 空状态补三条提示（这里能做什么）。
 */
export function ProjectList({ projects, loading, onOpen, onCreate, onRename, onDelete }: ProjectListProps) {
  const { t } = useTranslation('projects')

  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="aspect-[4/3] w-full rounded-[16px]" />
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
        hints={[t('empty.hint_1'), t('empty.hint_2'), t('empty.hint_3')]}
      />
    )
  }

  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {projects.map((project) => (
        <ProjectCard
          key={project.id}
          project={project}
          onOpen={onOpen}
          onRename={onRename}
          onDelete={onDelete}
        />
      ))}
      {onCreate && <ProjectGhostCard onCreate={onCreate} />}
    </div>
  )
}
