import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import gsap from 'gsap'
import {
  CheckSquare,
  ImagePlus,
  Loader2,
  MessageSquarePlus,
  MessagesSquare,
  Pencil,
  Plus,
  Share2,
  Sparkles,
  Square,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { SmartImage } from '@/components/ui/smart-image'
import { useUIStore, type StudioTab } from '@/stores/ui'
import { useToast } from '@/hooks/use-toast'
import { useListReveal, prefersReducedMotion } from '@/lib/motion'
import { chatApi } from '@/lib/api/chat'
import { canvasesApi } from '@/lib/api/canvases'
import { assetsApi } from '@/lib/api/assets'
import { generateApi } from '@/lib/api/generate'
import { events } from '@/lib/events'
import { parseServerTime } from '@/lib/utils'
import { errorMessage } from '@/lib/errors'
import { cn } from '@/lib/utils'
import type { Asset, ChatSession, GenerationTask } from '@/types/models'

interface StudioSidebarProps {
  currentSessionId: string | null
  onSelectSession: (id: string) => void
  onCreateSession: () => void
  onDeleteSession: (id: string) => Promise<void> | void
  /** 把素材 / 作品放进画布 */
  onUseAsset: (asset: Asset) => void
  onUseWork: (url: string, taskId: string) => void
  /** 上传本地参考图（复用工作台上传流程） */
  onUpload: () => void
}

const TABS: Array<{ id: StudioTab; label: string; icon: typeof MessagesSquare }> = [
  { id: 'chats', label: '对话', icon: MessagesSquare },
  { id: 'refs', label: '参考图', icon: ImagePlus },
  { id: 'works', label: '作品', icon: Sparkles },
]

/** 相对时间：今天只显示时分，更早显示日期——列表里不需要秒级精度。 */
function relativeTime(value?: string | null): string {
  const date = parseServerTime(value)
  if (!date) return ''
  const diff = Date.now() - date.getTime()
  const minute = 60_000
  if (diff < minute) return '刚刚'
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`
  const sameDay = new Date().toDateString() === date.toDateString()
  if (sameDay) return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

/**
 * 创作页左栏（固定）：历史对话 / 参考图 / 作品。
 *
 * 三件事都是「我已有的东西」，所以放在同一个固定列里，用标签页切换而不是三条并排的栏——
 * 并排会把画布挤到只剩一半宽度，而画布才是这个页面的主体。
 */
export function StudioSidebar({
  currentSessionId,
  onSelectSession,
  onCreateSession,
  onDeleteSession,
  onUseAsset,
  onUseWork,
  onUpload,
}: StudioSidebarProps) {
  const toast = useToast()
  const { t: te } = useTranslation()
  const tab = useUIStore((s) => s.studioTab)
  const setTab = useUIStore((s) => s.setStudioTab)

  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [assets, setAssets] = useState<Asset[]>([])
  const [works, setWorks] = useState<GenerationTask[]>([])
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<{ url: string; prompt: string; taskId: string } | null>(null)
  /** 多选模式：只在「对话 / 参考图」两个标签下可用 */
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [bulkBusy, setBulkBusy] = useState(false)
  /** 正在分享的会话 id（按钮转圈，防重复点击） */
  const [sharingId, setSharingId] = useState<string | null>(null)
  /** 正在重命名的对话 id 与草稿 */
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  const listRef = useRef<HTMLDivElement>(null)
  const tabsRef = useRef<HTMLDivElement>(null)
  const pillRef = useRef<HTMLSpanElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [sessionList, assetPage, taskPage] = await Promise.all([
        chatApi.listSessions().catch(() => [] as ChatSession[]),
        assetsApi.list({ kind: 'uploaded', size: 48 }).catch(() => ({ items: [] as Asset[] })),
        generateApi
          .listTasks({ status: 'succeeded', size: 40 })
          .catch(() => ({ items: [] as GenerationTask[] })),
      ])
      setSessions(Array.isArray(sessionList) ? sessionList : [])
      setAssets(assetPage.items ?? [])
      setWorks((taskPage.items ?? []).filter((task) => (task.result_urls?.length ?? 0) > 0))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 换标签就退出多选：否则会把「参考图的选择」带到「对话」里删错东西
  useEffect(() => {
    setSelectMode(false)
    setSelected([])
  }, [tab])

  // 生成完成 / 额度变化后刷新：作品与参考图都可能新增
  useEffect(() => {
    const handler = () => void load()
    events.on('tasks:changed', handler)
    return () => events.off('tasks:changed', handler)
  }, [load])

  // 会话列表随当前会话变化补一次（新建对话后标题可能被后端改写）
  useEffect(() => {
    if (!currentSessionId) return
    const timer = window.setTimeout(() => void load(), 800)
    return () => window.clearTimeout(timer)
  }, [currentSessionId, load])

  const workTiles = useMemo(
    () =>
      works.flatMap((task) =>
        task.result_urls.map((url, index) => ({
          key: `${task.id}-${index}`,
          url,
          prompt: task.prompt,
          taskId: task.id,
        }))
      ),
    [works]
  )

  // 每次切换标签 / 数据变化，列表错峰浮现（GSAP）
  // 间距压到 0.022：侧栏条目多（作品可达 40+），太慢会让人等动画
  useListReveal(listRef, `${tab}-${sessions.length}-${assets.length}-${workTiles.length}`, {
    selector: '[data-tile]',
    stagger: 0.022,
    y: 8,
    duration: 0.38,
  })

  /**
   * 切换标签时先「旧内容淡出 90ms → 换 → 新内容浮现」。
   *
   * 直接切换会让整列内容瞬间替换，眼眶很不舒服；加一层极短的淡出，
   * 大脑会把它读成"换了一页"而不是"闪了一下"。
   */
  const [displayTab, setDisplayTab] = useState<StudioTab>(tab)
  const [switching, setSwitching] = useState(false)
  useEffect(() => {
    if (tab === displayTab) return
    if (prefersReducedMotion()) {
      setDisplayTab(tab)
      return
    }
    setSwitching(true)
    const timer = window.setTimeout(() => {
      setDisplayTab(tab)
      setSwitching(false)
    }, 90)
    return () => window.clearTimeout(timer)
  }, [tab, displayTab])

  const counts: Record<StudioTab, number> = {
    chats: sessions.length,
    refs: assets.length,
    works: workTiles.length,
  }

  /**
   * 选中胶囊跟随当前标签滑动。
   * 宽度会随「文案 + 计数」变化（47 → 100 时数字变宽），所以每次数据变化都重新量一次。
   */
  useLayoutEffect(() => {
    const container = tabsRef.current
    const pill = pillRef.current
    if (!container || !pill) return
    const btn = container.querySelector<HTMLButtonElement>(`[data-tab="${tab}"]`)
    if (!btn) return
    const target = { x: btn.offsetLeft, width: btn.offsetWidth }
    if (prefersReducedMotion()) {
      gsap.set(pill, target)
      return
    }
    gsap.to(pill, { ...target, duration: 0.42, ease: 'power3.out' })
  }, [tab, sessions.length, assets.length, workTiles.length])

  /** 当前标签下可被多选的条目 id 列表 */
  const selectableIds = useMemo(() => {
    if (tab === 'chats') return sessions.map((item) => item.id)
    if (tab === 'refs') return assets.map((item) => item.id)
    return []
  }, [tab, sessions, assets])

  const allSelected = selectableIds.length > 0 && selected.length === selectableIds.length

  const toggleSelect = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))
  }

  const toggleSelectAll = () => {
    setSelected(allSelected ? [] : selectableIds)
  }

  /** 批量删除：一次请求（后端软删），失败保留选择方便重试 */
  const handleBulkDelete = async () => {
    if (selected.length === 0 || bulkBusy) return
    setBulkBusy(true)
    try {
      if (tab === 'refs') {
        await assetsApi.removeMany(selected)
      } else {
        await chatApi.deleteMessages(selected)
      }
      toast.success(`已删除 ${selected.length} 项`)
      setSelected([])
      setSelectMode(false)
      events.emit('tasks:changed')
      await load()
    } catch (error) {
      toast.error(errorMessage(error, te))
    } finally {
      setBulkBusy(false)
    }
  }

  /**
   * 分享这段对话：生成只读链接并复制。
   *
   * 分享的是**整段对话**（提示词 + 结果 + 画布快照），不是某张图，
   * 所以入口挂在会话上——这是它唯一归属的对象。
   */
  const handleShare = async (id: string) => {
    setSharingId(id)
    try {
      const result = await canvasesApi.shareSession(id)
      await navigator.clipboard.writeText(result.url).catch(() => undefined)
      toast.success('分享链接已复制', '对方能看到提示词与结果，也能接着创作')
    } catch (error) {
      toast.error('分享没成功', errorMessage(error, te))
    } finally {
      setSharingId(null)
    }
  }

  const commitRename = async (id: string) => {
    const title = renameDraft.trim()
    setRenamingId(null)
    if (!title) return
    try {
      await chatApi.updateSession(id, title)
      setSessions((prev) => prev.map((item) => (item.id === id ? { ...item, title } : item)))
    } catch (error) {
      toast.error(errorMessage(error, te))
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await onDeleteSession(id)
      setSessions((prev) => prev.filter((item) => item.id !== id))
    } catch (error) {
      toast.error(errorMessage(error, te))
    }
  }

  return (
    <aside className="hidden min-h-0 w-[268px] shrink-0 flex-1 flex-col overflow-hidden rounded-[16px] bg-surface shadow-sheet md:flex">
      {/* 品牌行：工作区不渲染全局顶栏（那 48px 让给画布）。
          账号 / 通知 / 额度统一放在页面左下角的 WorkspaceIdentityBar，此处不重复。 */}
      <div className="flex h-12 shrink-0 items-center gap-2 px-3">
        <span aria-hidden className="cs-logo-mark h-5 w-5 shrink-0 text-text" />
        <span className="min-w-0 flex-1 truncate text-ui font-semibold tracking-[-0.02em] text-text">
          Canvas Studio
        </span>
      </div>

      {/* 分区标题行 */}
      <div className="flex shrink-0 items-center gap-2 px-3 pb-1.5">
        <span className="flex h-5 w-5 items-center justify-center rounded-[6px] bg-accent-soft text-accent-ink">
          <Sparkles size={11} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium tracking-[0.06em] text-text-tertiary">
          我的工作室
        </span>
        {loading && <Loader2 size={12} className="shrink-0 animate-spin text-text-faint" />}
        {(tab === 'chats' || tab === 'refs') && selectableIds.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setSelectMode((prev) => !prev)
              setSelected([])
            }}
            title={selectMode ? '退出多选' : '多选'}
            aria-label={selectMode ? '退出多选' : '多选'}
            className={cn(
              'flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] transition-colors',
              selectMode
                ? 'bg-accent-soft text-accent-ink'
                : 'text-text-tertiary hover:bg-surface-hover hover:text-text'
            )}
          >
            <CheckSquare size={14} />
          </button>
        )}
        <button
          type="button"
          onClick={onCreateSession}
          title="新建对话"
          aria-label="新建对话"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text"
        >
          <MessageSquarePlus size={14} />
        </button>
      </div>

      {/* 三段式标签：窄栏里不放图标，只留文字 + 计数，保证永不折行。
          选中态是一枚会滑动的胶囊（GSAP 跟随），比"瞬间换底色"更有实体感。 */}
      <div
        ref={tabsRef}
        className="relative mx-2.5 mb-2 grid shrink-0 grid-cols-3 gap-0.5 rounded-full bg-bg-subtle p-1"
      >
        <span
          ref={pillRef}
          aria-hidden
          className="pointer-events-none absolute left-0 top-1 h-7 rounded-full bg-surface shadow-xs"
          style={{ width: 0 }}
        />
        {TABS.map((item) => {
          const active = tab === item.id
          return (
            <button
              key={item.id}
              data-tab={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              aria-pressed={active}
              className={cn(
                'relative z-10 flex h-7 min-w-0 items-center justify-center gap-1 rounded-full px-1 text-[11px] font-medium transition-colors duration-200',
                active ? 'text-text' : 'text-text-tertiary hover:text-text-secondary'
              )}
            >
              <span className="truncate">{item.label}</span>
              {counts[item.id] > 0 && (
                <span
                  className={cn(
                    'shrink-0 tabular-nums',
                    active ? 'text-text-tertiary' : 'text-text-faint'
                  )}
                >
                  {counts[item.id] > 99 ? '99+' : counts[item.id]}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* 多选操作条：全选 + 删除已选 */}
      {selectMode && (
        <div className="mx-2.5 mb-2 flex shrink-0 items-center gap-1 rounded-[10px] bg-bg-subtle px-1.5 py-1">
          <button
            type="button"
            onClick={toggleSelectAll}
            className="inline-flex items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-[11px] text-text-secondary hover:text-text"
          >
            {allSelected ? <CheckSquare size={12} /> : <Square size={12} />}
            {allSelected ? '取消全选' : '全选'}
          </button>
          <span className="text-[10px] tabular-nums text-text-faint">
            {selected.length}/{selectableIds.length}
          </span>
          <button
            type="button"
            disabled={selected.length === 0 || bulkBusy}
            onClick={() => void handleBulkDelete()}
            className="ml-auto inline-flex items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-[11px] text-danger transition-colors hover:bg-danger-subtle disabled:opacity-40"
          >
            {bulkBusy ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
            删除
          </button>
        </div>
      )}

      {/* 内容区：切换标签时整列先淡出 90ms 再换内容，避免"闪一下" */}
      <div
        ref={listRef}
        className={cn(
          'cs-thin-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2 transition-opacity duration-100 ease-out',
          switching ? 'opacity-0' : 'opacity-100'
        )}
      >
        {displayTab === 'chats' && (
          <div className="flex flex-col gap-0.5">
            {sessions.length === 0 && !loading && (
              <EmptyHint
                title="还没有对话"
                desc="在右侧描述需求，第一段对话会自动建在这里"
              />
            )}
            {sessions.map((session) => {
              const active = session.id === currentSessionId
              return (
                <div
                  key={session.id}
                  data-tile
                  className={cn(
                    'group/item relative rounded-[10px] transition-colors',
                    selectMode && selected.includes(session.id) && 'bg-accent-soft',
                    active && !selectMode ? 'bg-bg-subtle' : 'hover:bg-surface-hover'
                  )}
                >
                  <button
                    type="button"
                    onClick={() =>
                      selectMode ? toggleSelect(session.id) : onSelectSession(session.id)
                    }
                    className={cn(
                      'flex w-full flex-col gap-0.5 rounded-t-[10px] px-2.5 pb-0.5 pt-2 text-left transition-colors',
                      active && !selectMode ? 'text-text' : 'text-text-secondary hover:text-text'
                    )}
                  >
                    <span className="flex items-center gap-1.5">
                      {selectMode ? (
                        selected.includes(session.id) ? (
                          <CheckSquare size={13} className="shrink-0 text-accent-ink" />
                        ) : (
                          <Square size={13} className="shrink-0 text-text-faint" />
                        )
                      ) : (
                        active && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-strong" />
                      )}
                      {renamingId === session.id ? (
                        <input
                          autoFocus
                          value={renameDraft}
                          onChange={(event) => setRenameDraft(event.target.value)}
                          onClick={(event) => event.stopPropagation()}
                          onBlur={() => void commitRename(session.id)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              void commitRename(session.id)
                            }
                            if (event.key === 'Escape') setRenamingId(null)
                          }}
                          className="min-w-0 flex-1 rounded-[6px] border border-brand bg-surface px-1.5 py-0.5 text-caption text-text focus:outline-none"
                        />
                      ) : (
                        <span className="min-w-0 flex-1 truncate text-caption font-medium">
                          {session.title || '未命名对话'}
                        </span>
                      )}
                    </span>
                  </button>

                  {/* 左下角：分享这条对话；右下角：时间 */}
                  <div className="flex items-center gap-1 px-2.5 pb-1.5">
                    {!selectMode && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          void handleShare(session.id)
                        }}
                        disabled={sharingId === session.id}
                        title="分享这段对话"
                        className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] text-text-tertiary transition-colors hover:bg-surface hover:text-text disabled:opacity-50"
                      >
                        {sharingId === session.id ? (
                          <Loader2 size={9} className="animate-spin" />
                        ) : (
                          <Share2 size={9} />
                        )}
                        分享
                      </button>
                    )}
                    <span className="ml-auto text-[10px] text-text-faint">
                      {relativeTime(session.updated_at || session.created_at)}
                    </span>
                  </div>

                  {!selectMode && (
                    <div className="absolute right-1 top-1.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/item:opacity-100">
                      <button
                        type="button"
                        aria-label="重命名对话"
                        onClick={() => {
                          setRenamingId(session.id)
                          setRenameDraft(session.title || '')
                        }}
                        className="flex h-6 w-6 items-center justify-center rounded-[6px] text-text-faint hover:bg-surface hover:text-text"
                      >
                        <Pencil size={11} />
                      </button>
                      <button
                        type="button"
                        aria-label="删除对话"
                        onClick={() => void handleDelete(session.id)}
                        className="flex h-6 w-6 items-center justify-center rounded-[6px] text-text-faint hover:bg-danger-subtle hover:text-danger"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {displayTab === 'refs' && (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={onUpload}
              className="flex h-9 items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-border-strong text-caption text-text-secondary transition-colors hover:border-accent-strong hover:bg-accent-soft/50 hover:text-text"
            >
              <Upload size={13} /> 上传参考图
            </button>
            {assets.length === 0 && !loading && (
              <EmptyHint title="还没有参考图" desc="上传后可在对话里直接引用，也可拖进画布" />
            )}
            <div className="grid grid-cols-2 gap-1.5">
              {assets.map((asset) => (
                <button
                  key={asset.id}
                  data-tile
                  type="button"
                  onClick={() => (selectMode ? toggleSelect(asset.id) : onUseAsset(asset))}
                  title={selectMode ? '点击选中' : `${asset.source_prompt || '参考图'}\n点击放入画布`}
                  className={cn(
                    'group/ref relative aspect-square overflow-hidden rounded-[8px] border bg-bg-subtle',
                    selectMode && selected.includes(asset.id)
                      ? 'border-accent-strong ring-2 ring-accent-strong/40'
                      : 'border-border/70'
                  )}
                >
                  <SmartImage
                    src={asset.thumb_url || asset.url}
                    alt={asset.source_prompt?.slice(0, 20) || '参考图'}
                    wrapperClassName="h-full w-full"
                    className="h-full w-full object-cover transition-transform duration-300 group-hover/ref:scale-[1.04]"
                  />
                  {selectMode ? (
                    <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-surface/90 text-accent-ink">
                      {selected.includes(asset.id) ? (
                        <CheckSquare size={11} />
                      ) : (
                        <Square size={11} className="text-text-faint" />
                      )}
                    </span>
                  ) : (
                    <span className="absolute inset-0 hidden items-center justify-center bg-[rgba(12,11,7,0.45)] text-micro font-medium text-white group-hover/ref:flex">
                      <Plus size={14} /> 放入画布
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {displayTab === 'works' && (
          <div className="flex flex-col gap-2">
            {workTiles.length === 0 && !loading && (
              <EmptyHint title="还没有作品" desc="生成成功后，结果会自动归档到这里" />
            )}
            <div className="grid grid-cols-2 gap-1.5">
              {workTiles.map((tile) => (
                <button
                  key={tile.key}
                  data-tile
                  type="button"
                  onClick={() => setPreview(tile)}
                  title={`${tile.prompt.slice(0, 60)}\n点击查看大图`}
                  className="group/work relative aspect-square overflow-hidden rounded-[8px] border border-border/70 bg-bg-subtle"
                >
                  <SmartImage
                    src={tile.url}
                    alt={tile.prompt.slice(0, 20)}
                    wrapperClassName="h-full w-full"
                    className="h-full w-full object-cover transition-transform duration-300 group-hover/work:scale-[1.04]"
                  />
                  <span className="absolute inset-0 hidden items-center justify-center bg-[rgba(12,11,7,0.45)] text-micro font-medium text-white group-hover/work:flex">
                    查看
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 底部身份信息由 WorkspaceIdentityBar 承担（贴页面左下角），这里不再重复一份 */}

      {/* 作品大图预览：直接在这里完成「看一眼 → 放进画布」 */}
      {preview && (
        <div
          className="fixed inset-0 z-[1150] flex items-center justify-center bg-[rgba(10,9,6,0.8)] p-6 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          onClick={() => setPreview(null)}
        >
          <button
            type="button"
            aria-label="关闭"
            onClick={() => setPreview(null)}
            className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25"
          >
            <X size={17} />
          </button>
          <figure
            className="flex max-h-full max-w-full flex-col items-center gap-3"
            onClick={(event) => event.stopPropagation()}
          >
            <img
              src={preview.url}
              alt={preview.prompt.slice(0, 40)}
              className="max-h-[74vh] max-w-[82vw] rounded-[6px] bg-mat object-contain shadow-drag"
            />
            <figcaption className="flex max-w-[82vw] flex-col items-center gap-2">
              <p className="line-clamp-2 text-center text-caption leading-relaxed text-white/70">
                {preview.prompt}
              </p>
              <button
                type="button"
                onClick={() => {
                  onUseWork(preview.url, preview.taskId)
                  setPreview(null)
                }}
                className="cs-gradient-accent inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-caption font-semibold shadow-glow transition-[filter] hover:brightness-105"
              >
                <Plus size={14} /> 放入画布
              </button>
            </figcaption>
          </figure>
        </div>
      )}
    </aside>
  )
}

function EmptyHint({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="mt-8 px-3 text-center">
      <p className="text-caption font-medium text-text-secondary">{title}</p>
      <p className="mt-1 text-micro leading-relaxed text-text-tertiary">{desc}</p>
    </div>
  )
}
