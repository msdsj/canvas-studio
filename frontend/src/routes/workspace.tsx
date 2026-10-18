import { createFileRoute } from '@tanstack/react-router'
import { AppShell } from '@/components/layout/AppShell'
import { ProtectedRoute } from '@/components/layout/ProtectedRoute'
import { WorkspaceView } from '@/components/canvas/WorkspaceView'
import { FreeStudioView } from '@/components/studio/FreeStudioView'
import { useAuth } from '@/hooks/use-auth'

export const Route = createFileRoute('/workspace')({
  validateSearch: (search: Record<string, unknown>): { session?: string; task?: string } => {
    // 可选参数：缺省时不要往 URL 里塞空串，否则所有 Link 都被要求显式传 search
    const out: { session?: string; task?: string } = {}
    if (typeof search.session === 'string' && search.session) out.session = search.session
    if (typeof search.task === 'string' && search.task) out.task = search.task
    return out
  },
  component: WorkspacePage,
})

/**
 * 工作台入口：按权限分级分流。
 *
 * 权限模型（与后端 `require_pro` 门禁一致）：
 * - Pro / 管理员 → 完整工作台（画布 + AI 对话 + 图片编辑 + 润色 + 图生图）；
 * - 普通用户 → 只有「文字生成图片」的极简创作台。
 *
 * 这里分流而不是在 WorkspaceView 内部早退：两个视图的 hook 数量完全不同，
 * 在同一个组件里条件早退会直接踩到 React 的 hook 顺序规则。
 */
function WorkspacePage() {
  const { session, task } = Route.useSearch()
  const { isPro } = useAuth()

  return (
    <ProtectedRoute>
      <AppShell>
        {isPro ? (
          <WorkspaceView sessionId={session ?? ''} taskId={task} />
        ) : (
          <FreeStudioView />
        )}
      </AppShell>
    </ProtectedRoute>
  )
}
