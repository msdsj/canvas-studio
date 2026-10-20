import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, MessageSquare, Plus, Search, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { ChatSession } from '@/types/models'
import { cn } from '@/lib/utils'

interface SessionSelectorProps {
  sessions: ChatSession[]
  currentId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
}

/** 分组键：今天 / 昨天 / 近七天 / 更早。 */
type Bucket = 'today' | 'yesterday' | 'week' | 'older'

const BUCKET_ORDER: Bucket[] = ['today', 'yesterday', 'week', 'older']

function bucketOf(iso: string | null | undefined): Bucket {
  if (!iso) return 'older'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'older'
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day = 86_400_000
  if (then >= startOfToday) return 'today'
  if (then >= startOfToday - day) return 'yesterday'
  if (then >= startOfToday - 7 * day) return 'week'
  return 'older'
}

/**
 * 会话切换 / 新建 / 删除。
 *
 * 列表随使用时长会涨到几十条，直接铺一个 dropdown 有三个实际问题：
 * 1. **找不到**——没有搜索，只能靠记忆往下翻；
 * 2. **分不清**——只显示标题，看不出「哪条是刚才那条」；
 * 3. **误删**——删除按钮紧挨着条目，点一下就没了。
 *
 * 所以这里补了搜索框、时间分组、「再点一次才删」。
 * 排序用 `updated_at` 而不是 `created_at`：用户找的几乎总是「我刚在弄的那个」。
 */
export function SessionSelector({
  sessions,
  currentId,
  onSelect,
  onCreate,
  onDelete,
}: SessionSelectorProps) {
  const { t } = useTranslation('chat')
  const [query, setQuery] = useState('')
  /** 待确认删除的会话 id：第一下点只是「举起来」，第二下才真删 */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  const current = sessions.find((s) => s.id === currentId)

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? sessions.filter((s) => (s.title || '').toLowerCase().includes(q))
      : sessions

    const sorted = [...filtered].sort((a, b) => {
      const av = new Date(a.updated_at ?? a.created_at ?? 0).getTime() || 0
      const bv = new Date(b.updated_at ?? b.created_at ?? 0).getTime() || 0
      return bv - av
    })

    const buckets: Record<Bucket, ChatSession[]> = {
      today: [],
      yesterday: [],
      week: [],
      older: [],
    }
    for (const session of sorted) {
      buckets[bucketOf(session.updated_at ?? session.created_at)].push(session)
    }
    return BUCKET_ORDER.filter((key) => buckets[key].length > 0).map((key) => ({
      key,
      items: buckets[key],
    }))
  }, [sessions, query])

  const total = grouped.reduce((sum, group) => sum + group.items.length, 0)

  return (
    <div className="flex items-center gap-1">
      <DropdownMenu
        onOpenChange={(open) => {
          if (!open) {
            setQuery('')
            setPendingDelete(null)
          }
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="max-w-[200px] justify-start"
            /*
             * 触发器的可见文字是「当前会话标题」，对读屏软件来说那只是
             * 一个名字，说明不了「点它可以切换会话」。补一个 aria-label，
             * 同时让自动化脚本有个稳定锚点（标题会变，label 不会）。
             */
            aria-label={t('session.switch')}
          >
            <MessageSquare size={15} />
            <span className="truncate">{current?.title || t('session.untitled')}</span>
            <ChevronDown size={14} className="text-text-tertiary" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[280px] p-0">
          <div className="flex items-center gap-1.5 border-b border-border/60 px-2 py-1.5">
            <Search size={13} className="shrink-0 text-text-tertiary" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('session.search_placeholder')}
              // 下拉里输入不能被 Radix 的键盘导航吃掉，否则打不出字
              onKeyDown={(event) => event.stopPropagation()}
              className="min-w-0 flex-1 bg-transparent text-caption text-text outline-none placeholder:text-text-faint"
            />
          </div>

          <div className="max-h-[320px] overflow-y-auto p-1">
            {total === 0 ? (
              <p className="px-2 py-6 text-center text-[11px] text-text-tertiary">
                {query ? t('session.no_results') : t('session.empty')}
              </p>
            ) : (
              grouped.map((group) => (
                <div key={group.key}>
                  <div className="px-2 py-1 text-[10px] uppercase tracking-[0.06em] text-text-faint">
                    {t(`session.bucket.${group.key}`)}
                  </div>
                  {group.items.map((session) => {
                    const active = session.id === currentId
                    const confirming = pendingDelete === session.id
                    return (
                      <DropdownMenuItem
                        key={session.id}
                        // 确认删除期间不切会话，避免误触连带跳走
                        onSelect={(event) => {
                          if (confirming) {
                            event.preventDefault()
                            return
                          }
                          onSelect(session.id)
                        }}
                        className={cn(
                          'group flex items-center gap-1.5 rounded-[8px]',
                          active && 'bg-brand-subtle/60',
                        )}
                      >
                        <span
                          className={cn(
                            'min-w-0 flex-1 truncate',
                            active ? 'text-brand-text' : 'text-text',
                          )}
                        >
                          {session.title || t('session.untitled')}
                        </span>
                        <button
                          type="button"
                          aria-label={
                            confirming ? t('session.delete_confirm') : t('session.delete')
                          }
                          title={confirming ? t('session.delete_confirm') : t('session.delete')}
                          className={cn(
                            'shrink-0 rounded p-0.5 transition-colors',
                            confirming
                              ? 'bg-danger-subtle text-danger'
                              : 'text-text-faint opacity-0 hover:text-danger group-hover:opacity-100',
                          )}
                          onClick={(event) => {
                            event.stopPropagation()
                            event.preventDefault()
                            if (!confirming) {
                              setPendingDelete(session.id)
                              return
                            }
                            setPendingDelete(null)
                            onDelete(session.id)
                          }}
                        >
                          <Trash2 size={12} />
                        </button>
                      </DropdownMenuItem>
                    )
                  })}
                </div>
              ))
            )}
          </div>

          <div className="border-t border-border/60 p-1">
            <DropdownMenuItem onSelect={onCreate} className="rounded-[8px] text-caption">
              <Plus size={13} /> {t('new_session')}
            </DropdownMenuItem>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="ghost" size="icon-sm" aria-label={t('new_session')} onClick={onCreate}>
        <Plus size={16} />
      </Button>
    </div>
  )
}
