import { useCallback, useEffect, useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { ListChecks, RotateCcw, Square } from 'lucide-react'
import { AppShell } from '@/components/layout/AppShell'
import { ProtectedRoute } from '@/components/layout/ProtectedRoute'
import { PageShell, PageTabs } from '@/components/layout/PageShell'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Pagination } from '@/components/ui/pagination'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { generateApi } from '@/lib/api/generate'
import { useToast } from '@/hooks/use-toast'
import { errorMessage } from '@/lib/errors'
import { useFormatters } from '@/i18n/format'
import type { GenerationTask, TaskStatus } from '@/types/models'

export const Route = createFileRoute('/tasks')({
  component: TasksPage,
})

type Scope = 'all' | 'active' | 'succeeded' | 'failed'

const SCOPES: Scope[] = ['all', 'active', 'succeeded', 'failed']

/**
 * 任务中心。
 *
 * 改造前这个页面叫「Generation history」，实际只渲染 `ActiveTasksPanel`
 * ——只列进行中的任务。用户有几十条历史生成记录，打开这页却是
 * 「No active tasks」，功能与标题完全不符。
 *
 * 现在它真的展示历史：`GET /api/generate/tasks`（分页 + 状态筛选），
 * 进行中的任务额外提供「停止」，失败的任务提供「重试」。
 */
function TasksPage() {
  const { t } = useTranslation('chat')
  const { t: te } = useTranslation()
  const toast = useToast()
  const { relative } = useFormatters()

  const [scope, setScope] = useState<Scope>('all')
  const [items, setItems] = useState<GenerationTask[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(20)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await generateApi.listTasks({
        page,
        size,
        status: scope === 'all' ? undefined : scope,
      })
      setItems(result.items)
      setTotal(result.total)
    } catch (error) {
      toast.error(errorMessage(error, te))
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, size, scope])

  useEffect(() => {
    void load()
  }, [load])

  const act = useCallback(
    async (task: GenerationTask, kind: 'cancel' | 'retry') => {
      setBusy(task.id)
      try {
        if (kind === 'cancel') await generateApi.cancel(task.id)
        else await generateApi.retry(task.id)
        toast.success(kind === 'cancel' ? t('task.cancelled') : t('task.retried'))
        void load()
      } catch (error) {
        toast.error(errorMessage(error, te))
      } finally {
        setBusy(null)
      }
    },
    [load, toast, t, te],
  )

  const tabs = useMemo(
    () =>
      SCOPES.map((key) => ({
        key,
        label: t(`tasks.scope.${key}`),
      })),
    [t],
  )

  return (
    <ProtectedRoute>
      <AppShell>
        <PageShell
          title={t('tasks.title')}
          description={t('tasks.subtitle')}
          tabs={
            <PageTabs
              items={tabs}
              value={scope}
              onChange={(key) => {
                setScope(key as Scope)
                setPage(1)
              }}
            />
          }
        >
          {loading ? (
            <div className="flex flex-col gap-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-[84px] w-full rounded-[16px]" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <Card>
              <EmptyState
                icon={ListChecks}
                title={t('tasks.empty')}
                description={t('tasks.empty_desc')}
                hints={[t('tasks.hint_1'), t('tasks.hint_2')]}
                className="min-h-[300px]"
              />
            </Card>
          ) : (
            <div className="flex flex-col gap-3">
              {items.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  busy={busy === task.id}
                  relative={relative}
                  onCancel={() => void act(task, 'cancel')}
                  onRetry={() => void act(task, 'retry')}
                />
              ))}
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
            </div>
          )}
        </PageShell>
      </AppShell>
    </ProtectedRoute>
  )
}

function TaskRow({
  task,
  busy,
  relative,
  onCancel,
  onRetry,
}: {
  task: GenerationTask
  busy: boolean
  relative: (value: Date) => string
  onCancel: () => void
  onRetry: () => void
}) {
  const { t } = useTranslation('chat')
  const status = task.status as TaskStatus
  const canCancel = status === 'queued' || status === 'running'
  const canRetry = status === 'failed' || status === 'timeout' || status === 'cancelled'
  const cover = task.result_urls?.[0]

  return (
    <Card className="flex items-center gap-4 p-3">
      <div className="h-14 w-14 shrink-0 overflow-hidden rounded-[10px] bg-bg-subtle ring-1 ring-border-faint">
        {cover ? (
          <img src={cover} alt="" className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-text-faint">
            <ListChecks size={18} strokeWidth={1.5} />
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="line-clamp-2 text-ui leading-snug text-text">
          {task.prompt || task.type}
        </p>
        <p className="flex flex-wrap items-center gap-2 text-micro text-text-tertiary">
          <Badge variant={statusVariant(status)}>{t(`task.${status}`)}</Badge>
          {task.created_at && <span>{relative(new Date(task.created_at))}</span>}
          {task.cost > 0 && (
            <span className="font-mono tabular-nums">-{task.cost}</span>
          )}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {canCancel && (
          <Button variant="secondary" size="icon-sm" disabled={busy} onClick={onCancel} aria-label={t('task.cancel')}>
            <Square size={14} />
          </Button>
        )}
        {canRetry && (
          <Button variant="secondary" size="icon-sm" disabled={busy} onClick={onRetry} aria-label={t('task.retry')}>
            <RotateCcw size={14} />
          </Button>
        )}
      </div>
    </Card>
  )
}

function statusVariant(status: string): 'brand' | 'soft' | 'success' | 'warning' {
  if (status === 'succeeded') return 'success'
  if (status === 'failed' || status === 'timeout') return 'warning'
  if (status === 'running' || status === 'queued') return 'brand'
  return 'soft'
}
