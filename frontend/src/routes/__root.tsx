import { createRootRoute, Link, Outlet } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'

function RootError({ error }: { error: Error }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <EmptyState
        title="页面出错了"
        description={error.message}
        action={{ label: '返回首页', onClick: () => (window.location.href = '/') }}
      />
    </div>
  )
}

export const Route = createRootRoute({
  component: () => <Outlet />,
  errorComponent: RootError,
  notFoundComponent: () => (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
      <EmptyState title="页面不存在" description="你访问的页面可能已被移动或删除。" />
      <Link to="/">
        <Button variant="secondary" size="sm">
          返回首页
        </Button>
      </Link>
    </div>
  ),
})
