import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { createRootRoute, Link, Outlet, useRouterState } from '@tanstack/react-router'
import type { ErrorComponentProps } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { AuthDialog } from '@/components/auth/AuthDialog'
import { RouteProgress } from '@/components/layout/RouteProgress'
import { NetworkStatus } from '@/components/layout/NetworkStatus'
import { useRouteTransition, type RouteTransitionVariant } from '@/lib/motion'

function RootError({ error }: ErrorComponentProps) {
  // 界面不渲染 error.message：里面可能是后端原文、上游报文或异常堆栈。
  // 但开发期必须把原始错误打到控制台，否则排查时只剩一句"出了点小状况"。
  const { t } = useTranslation('common')
  if (import.meta.env.DEV) console.error('[route-error]', error)
  return (
    <div className="flex h-full items-center justify-center p-6">
      <EmptyState
        title={t('error_boundary.title')}
        description={t('error_boundary.description')}
        action={{ label: t('error_boundary.back_home'), onClick: () => (window.location.href = '/') }}
      />
    </div>
  )
}

/**
 * 每类页面的转场方式。
 *
 * - 工作台 / 画布：只淡入（理由见 useRouteTransition），面板自己的错峰入场负责「组装感」；
 *   从首页进入时还有 enterStudio 的圆形扩散帘，两层位移叠在一起会晕。
 * - 其余列表/设置页：轻上浮 + 极小的缩放回弹，像一张纸落到桌面上。
 *
 * 旧版这里还有第二条 opacity 补间做「交叉淡化」，和 useRouteTransition 抢同一个属性，
 * overwrite 时互相掐断，偶发停在半透明——现已合并为一条。
 */
function transitionVariant(pathname: string): RouteTransitionVariant {
  if (pathname.startsWith('/workspace') || pathname.startsWith('/canvas')) return 'fade'
  return 'lift'
}

function RootComponent() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const viewRef = useRef<HTMLDivElement>(null)

  /*
   * 路由转场只做「新页轻上浮」，不做旧页滑出。
   *
   * key 用 pathname：只有真正换页面才重播。查询参数变化（?session=xxx 切对话）
   * 属于页面内部状态，不该让整页再入场一遍——那会让切对话时界面无谓地抖一下。
   */
  useRouteTransition(viewRef, pathname, { variant: transitionVariant(pathname) })

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
      <NetworkStatus />
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
  notFoundComponent: RootNotFound,
})

function RootNotFound() {
  const { t } = useTranslation('common')
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
      <EmptyState
        title={t('error_boundary.not_found_title')}
        description={t('error_boundary.not_found_desc')}
      />
      <Link to="/">
        <Button variant="secondary" size="sm">
          {t('error_boundary.back_home')}
        </Button>
      </Link>
    </div>
  )
}
