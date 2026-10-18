import { createFileRoute, redirect } from '@tanstack/react-router'
import { getToken } from '@/lib/api/client'
import { useUIStore } from '@/stores/ui'

/**
 * 旧登录页已下线 —— 登录改由全局弹窗承接（`components/auth/AuthDialog`）。
 *
 * 这个路由保留是为了不打断历史链接、邮件里的回跳地址、以及各处 `to="/login"`：
 * 命中时直接把用户送回首页并弹开登录框，用户看到的仍然是「一屏首页 + 一个弹窗」。
 */
export const Route = createFileRoute('/login')({
  beforeLoad: () => {
    if (!getToken()) {
      useUIStore.getState().openAuth('login', '登录后继续你的创作')
    }
    throw redirect({ to: '/' })
  },
  component: () => null,
})
