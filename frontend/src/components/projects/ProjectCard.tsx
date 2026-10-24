import { useTranslation } from 'react-i18next'
import { LayoutGrid, MoreVertical, Pencil, Trash2 } from 'lucide-react'
import { Card, CardMedia } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { formatRelative } from '@/lib/utils'
import { ArtSwatch, type ArtPalette } from '@/components/home/ArtSwatch'
import type { CanvasProject } from '@/types/models'

interface ProjectCardProps {
  project: CanvasProject
  onOpen: (project: CanvasProject) => void
  onRename?: (project: CanvasProject) => void
  onDelete?: (project: CanvasProject) => void
}

/** 没有封面时给一张稳定的"纸卡"：同一个项目永远是同一张，不会每次刷新都换。 */
const PALETTES: ArtPalette[] = ['sunset', 'nebula', 'ocean', 'forest', 'peach', 'candy', 'mint', 'mono']

function paletteOf(id: string): ArtPalette {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return PALETTES[hash % PALETTES.length]
}

/**
 * 项目卡（封面 + 名称 + 更新时间 + 行操作）。
 *
 * v3 改动：
 * - 封面优先用后端新算出来的 `cover_url`（项目里最新画布的最新图片元素），
 *   没有图时不再是"灰色网格图标"，而是一张按项目 id 稳定的抽象纸卡；
 * - 封面改成 `object-contain` 的卡纸托盘，竖图不再被裁成方块；
 * - 副行补「N 张」，用户不用点进去就知道项目里有多少内容。
 */
export function ProjectCard({ project, onOpen, onRename, onDelete }: ProjectCardProps) {
  const { t } = useTranslation('projects')
  const cover = project.cover_url ?? project.thumbnail_url ?? null

  return (
    <Card interactive className="flex flex-col gap-3 p-0">
      <button type="button" className="flex flex-col" onClick={() => onOpen(project)}>
        <CardMedia className="cs-zoom aspect-[4/3] rounded-t-[16px]">
          {cover ? (
            <img
              src={cover}
              alt={project.name}
              loading="lazy"
              className="cs-zoom-target h-full w-full object-contain"
            />
          ) : (
            <ArtSwatch palette={paletteOf(project.id)} motif="type" className="h-full w-full" />
          )}
        </CardMedia>
      </button>
      <div className="flex items-start justify-between gap-2 px-4 pb-4 pt-1">
        <div className="min-w-0">
          <h3 className="truncate text-ui font-semibold text-text">{project.name}</h3>
          <p className="mt-1 text-micro text-text-tertiary">
            {t('card.updated', { time: formatRelative(project.updated_at) })}
            {typeof project.item_count === 'number' && project.item_count > 0 && (
              <span className="ml-1.5">· {t('card.items', { count: project.item_count })}</span>
            )}
          </p>
        </div>
        {(onRename || onDelete) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t('card.more')}
                className="rounded p-1 text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text"
              >
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

/**
 * 幽灵新建卡：网格页的最后一块永远不是空白。
 *
 * 改造前 /projects 只有一个项目时，剩下 80% 的页面是空的——用户既不知道
 * 还能创建什么，也找不到创建入口。虚线卡把"新建"放进网格本身。
 */
export function ProjectGhostCard({ onCreate }: { onCreate: () => void }) {
  const { t } = useTranslation('projects')
  return (
    <button
      type="button"
      onClick={onCreate}
      className="flex aspect-[4/3] flex-col items-center justify-center gap-3 rounded-[16px] border border-dashed border-border-strong bg-transparent transition-colors duration-[160ms] hover:border-accent hover:bg-accent-soft/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-bg-subtle text-text-tertiary">
        <LayoutGrid size={20} strokeWidth={1.5} />
      </span>
      <span className="text-ui font-medium text-text-secondary">{t('empty.cta')}</span>
    </button>
  )
}
