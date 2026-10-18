import { useCallback, useEffect, useMemo, useState } from 'react'
import { LibraryBig, Loader2, Search, Sparkles } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { aiApi, type DesignSkill, type DesignSkillCategory } from '@/lib/api/ai'
import { ApiError } from '@/lib/api/client'

interface SkillLibraryPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 选中技能：把它的骨架插入输入框 */
  onPick: (skill: DesignSkill) => void
}

/**
 * 设计技能库：不是「给用户看的图鉴」，而是**出图参数来源**。
 *
 * 选中的技能会做两件事：① 把骨架写进输入框；② 提交时随请求带给后端，
 * 由提示词工程师按骨架补版式/材质/负面词。所以卡片上必须写清
 * 「什么时候用」和「会得到什么」，而不是只有名字。
 */
export function SkillLibraryPanel({ open, onOpenChange, onPick }: SkillLibraryPanelProps) {
  const toast = useToast()
  const [items, setItems] = useState<DesignSkill[]>([])
  const [categories, setCategories] = useState<DesignSkillCategory[]>([])
  const [total, setTotal] = useState(0)
  const [category, setCategory] = useState<string>('')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (nextCategory: string, nextQuery: string) => {
    setLoading(true)
    try {
      const data = await aiApi.skills({
        category: nextCategory || undefined,
        q: nextQuery || undefined,
      })
      setItems(data.items)
      setCategories(data.categories)
      setTotal(data.total)
    } catch (error) {
      toast.error('技能库加载失败', error instanceof ApiError ? error.message : undefined)
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    if (!open) return
    void load(category, query)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, category])

  // 搜索防抖：打字时不至于每敲一下就请求一次
  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => void load(category, query), 260)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  const categoryName = useMemo(() => {
    const map: Record<string, string> = {}
    categories.forEach((item) => {
      map[item.id] = item.name
    })
    return map
  }, [categories])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="p-0">
        <div className="flex max-h-[min(720px,calc(100dvh-96px))] flex-col">
          <DialogHeader className="border-b border-border/60 px-6 py-4">
            <DialogTitle className="flex items-center gap-2 text-base">
              <LibraryBig size={16} className="text-brand" />
              设计技能库
              <span className="rounded-full bg-bg-subtle px-1.5 py-0.5 text-[10px] font-normal text-text-tertiary">
                {total} 项
              </span>
            </DialogTitle>
            <DialogDescription className="text-caption">选中后按这套参数出图</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2 border-b border-border/60 px-4 py-3">
            <div className="flex items-center gap-2 rounded-[10px] border border-border bg-surface px-2.5 py-1.5">
              <Search size={14} className="shrink-0 text-text-tertiary" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜场景：小红书 / 菜单 / PPT / 3D…"
                className="min-w-0 flex-1 bg-transparent text-caption text-text placeholder:text-text-tertiary focus:outline-none"
              />
              {loading && <Loader2 size={13} className="animate-spin text-text-tertiary" />}
            </div>
            <div className="flex flex-wrap gap-1">
              <CategoryChip active={category === ''} onClick={() => setCategory('')}>
                全部
              </CategoryChip>
              {categories.map((item) => (
                <CategoryChip
                  key={item.id}
                  active={category === item.id}
                  onClick={() => setCategory(item.id)}
                >
                  {item.name}
                  <span className="ml-1 text-[10px] text-text-faint">{item.count}</span>
                </CategoryChip>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {loading && items.length === 0 && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {[0, 1, 2, 3].map((index) => (
                  <div key={index} className="h-[104px] animate-pulse rounded-[12px] bg-bg-subtle" />
                ))}
              </div>
            )}

            {!loading && items.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-12 text-center">
                <Sparkles size={22} className="text-text-faint" />
                <p className="text-caption text-text-secondary">没找到匹配的技能</p>
                <p className="text-micro text-text-tertiary">换个说法试试，比如「主图」「国潮」「等距」</p>
              </div>
            )}

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {items.map((skill) => (
                <button
                  key={skill.id}
                  type="button"
                  onClick={() => {
                    onPick(skill)
                    onOpenChange(false)
                  }}
                  className="group flex flex-col gap-1 rounded-[12px] border border-border bg-surface px-3 py-2.5 text-left transition-colors hover:border-brand hover:bg-brand-subtle/40"
                >
                  <span className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-caption font-medium text-text">
                      {skill.name}
                    </span>
                    <span className="shrink-0 rounded-full bg-bg-subtle px-1.5 py-0.5 text-[10px] text-text-tertiary">
                      {categoryName[skill.category] ?? skill.category}
                    </span>
                  </span>
                  <span className="line-clamp-2 text-micro leading-relaxed text-text-secondary">
                    {skill.description}
                  </span>
                  <span className="mt-auto flex flex-wrap gap-1 pt-0.5">
                    {skill.style_tags.slice(0, 3).map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-text-tertiary"
                      >
                        {tag}
                      </span>
                    ))}
                    {skill.aspect && (
                      <span className="rounded-full bg-bg-subtle px-1.5 py-0.5 text-[10px] text-text-tertiary">
                        {skill.aspect}
                      </span>
                    )}
                    {Object.keys(skill.slots ?? {}).length > 0 && (
                      <span className="rounded-full bg-bg-subtle px-1.5 py-0.5 text-[10px] text-text-tertiary">
                        {Object.keys(skill.slots ?? {}).length} 项参数
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function CategoryChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-1 text-[11px] transition-colors',
        active
          ? 'bg-brand text-white'
          : 'bg-bg-subtle text-text-secondary hover:bg-surface-hover'
      )}
    >
      {children}
    </button>
  )
}
