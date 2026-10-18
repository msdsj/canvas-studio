import { useTranslation } from 'react-i18next'
import { LayoutGrid, MoreVertical, Pencil, Trash2 } from 'lucide-react'
import { Card } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { formatRelative } from '@/lib/utils'
import type { CanvasProject } from '@/types/models'

interface ProjectCardProps {
  project: CanvasProject
  onOpen: (project: CanvasProject) => void
  onRename?: (project: CanvasProject) => void
  onDelete?: (project: CanvasProject) => void
}

/** 项目卡（缩略图 + 名称 + 更新时间 + 行操作）。 */
export function ProjectCard({ project, onOpen, onRename, onDelete }: ProjectCardProps) {
  const { t } = useTranslation('projects')
  return (
    <Card interactive className="flex flex-col gap-3 p-0">
      <button type="button" className="flex flex-col" onClick={() => onOpen(project)}>
        <div className="cs-zoom flex aspect-video items-center justify-center rounded-t-[16px] bg-bg-subtle">
          {project.thumbnail_url ? (
            <img
              src={project.thumbnail_url}
              alt={project.name}
              className="cs-zoom-target h-full w-full object-cover"
            />
          ) : (
            <LayoutGrid size={36} className="text-text-tertiary" />
          )}
        </div>
      </button>
      <div className="flex items-start justify-between gap-2 px-5 pb-4">
        <div className="min-w-0">
          <h3 className="truncate text-md font-semibold text-text">{project.name}</h3>
          <p className="mt-1 text-xs text-text-tertiary">
            {t('card.updated', { time: formatRelative(project.updated_at) })}
          </p>
        </div>
        {(onRename || onDelete) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label="more" className="rounded p-1 text-text-tertiary hover:bg-surface-hover">
                <MoreVertical size={16} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {onRename && (
                <DropdownMenuItem onClick={() => onRename(project)}>
                  <Pencil size={15} /> {t('rename_dialog.title')}
                </DropdownMenuItem>
              )}
              {onDelete && (
                <DropdownMenuItem danger onClick={() => onDelete(project)}>
                  <Trash2 size={15} /> {t('common:action.delete', { defaultValue: '删除' })}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </Card>
  )
}
