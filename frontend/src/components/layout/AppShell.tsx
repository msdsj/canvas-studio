import type { ReactNode } from 'react'
import { TopBar } from './TopBar'
import { AnnouncementBanner } from './AnnouncementBanner'
import { ResumeGuard } from './ResumeGuard'
import { QuotaInsufficientModal } from './QuotaInsufficientModal'

/**
 * 登录后全局壳：顶栏 + 内容区 + 全局续接/提醒。
 *
 * `main` 必须同时有 `min-h-0` 与 `overflow-hidden`：只给 `min-h-0` 时，
 * 子级（画布 / 聊天列表）一旦内容变高仍会把 main 撑起来，
 * 而外层是 `h-screen overflow-hidden`，结果就是顶栏被顶出视口——用户看到的是
 * "页面莫名往上跳了一截，菜单不见了"。两道约束都得有。
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-transparent">
      <TopBar />
      <AnnouncementBanner />
      <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
      <ResumeGuard />
      <QuotaInsufficientModal />
    </div>
  )
}
