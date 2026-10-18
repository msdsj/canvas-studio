import { useEffect, useLayoutEffect, useRef } from 'react'
import { createRootRoute, Link, Outlet, useRouterState } from '@tanstack/react-router'
import type { ErrorComponentProps } from '@tanstack/react-router'
import { gsap } from '@/lib/gsap'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { AuthDialog } from '@/components/auth/AuthDialog'
import { RouteProgress } from '@/components/layout/RouteProgress'
import { DURATION, EASE, shouldReduceMotion, useRouteTransition } from '@/lib/motion'

function RootError({ error }: ErrorComponentProps) {
  // 界面不渲染 error.message：里面可能是后端原文、上游报文或异常堆栈。
  // 但开发期必须把原始错误打到控制台，否则排查时只剩一句"出了点小状况"。
  if (import.meta.env.DEV) console.error('[route-error]', error)
  return (
    <div className="flex h-full items-center justify-center p-6">
      <EmptyState
        title="页面出了点小状况"
        description="刷新一下试试；如果一直这样，请联系客服。"
        action={{ label: '返回首页', onClick: () => (window.location.href = '/') }}
      />
    </div>
  )
}

function RootComponent() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const viewRef = useRef<HTMLDivElement>(null)
  /** 上一次渲染时的路径：用来判断"是切页"还是"同一页内的重渲染" */
  const lastPath = useRef(pathname)

  /*
   * 路由转场只做「新页轻上浮」，不做旧页滑出。
   *
   * key 用 pathname：只有真正换页面才重播。查询参数变化（?session=xxx 切对话）
   * 属于页面内部状态，不该让整页再入场一遍——那会让切对话时界面无谓地抖一下。
   */
  useRouteTransition(viewRef, pathname)

  /**
   * 切页瞬间的交叉淡化。
   *
   * useRouteTransition 负责新页浮起，但旧页在 React 换树的同一帧就消失了，
   * 所以从"深色页面 → 浅色页面"这种对比大的跳转看起来像硬切。
   * 这里在 layout effect 里补一帧：先让容器迅速暗下去一档（opacity 1→0.55），
   * 再由 useRouteTransition 的补间接回 1——两段叠起来就是一次很短的"换气"。
   *
   * 只在路径变化时触发；StrictMode 双挂载时 lastPath 已经等于 pathname，不会重播。
   */
  useLayoutEffect(() => {
    if (lastPath.current === pathname) return
    lastPath.current = pathname
    const el = viewRef.current
    if (!el || shouldReduceMotion()) return
    const tween = gsap.fromTo(
      el,
      { opacity: 0.72 },
      { opacity: 1, duration: DURATION.slow, ease: EASE.out, overwrite: 'auto' }
    )
    return () => {
      tween.kill()
    }
  }, [pathname])

  // 页面不可见时暂停 ScrollTrigger 的滚动计算（后台标签页不该继续算布局）
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') return
      // 回来时补一次测量：路由懒加载的页面在后台可能没算过触发位置
      void import('@/lib/gsap').then(({ ScrollTrigger }) => ScrollTrigger.refresh())
    }
    document.addEventListener('visibilitychange', onHidden)
    return () => document.removeEventListener('visibilitychange', onHidden)
  }, [])

  return (
    <>
      <RouteProgress />
      <div ref={viewRef} className="h-full">
        <Outlet />
      </div>
      {/* 登录弹窗挂在根节点：任何页面都能唤起，不需要再跳转到独立登录页 */}
      <AuthDialog />
    </>
  )
}

export const Route = createRootRoute({
  component: RootComponent,
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
