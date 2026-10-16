import { createFileRoute, Link } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'

export const Route = createFileRoute('/$')({
  component: () => (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6">
      <EmptyState
        title="404 · 页面不存在"
        description="你访问的页面可能已被移动或删除。"
        action={{ label: '返回工作台', onClick: () => (window.location.href = '/workspace') }}
      />
      <Link to="/workspace">
        <Button variant="ghost" size="sm">
          去工作台
        </Button>
      </Link>
    </div>
  ),
})
