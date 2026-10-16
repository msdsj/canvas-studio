import type { ReactNode } from 'react'
import { TopBar } from './TopBar'
import { AnnouncementBanner } from './AnnouncementBanner'
import { ResumeGuard } from './ResumeGuard'
import { UnreadResultsBanner } from './UnreadResultsBanner'
import { QuotaInsufficientModal } from './QuotaInsufficientModal'

/** 登录后全局壳：顶栏 + 内容区 + 全局续接/提醒。 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg">
      <TopBar />
      <AnnouncementBanner />
      <UnreadResultsBanner />
      <main className="min-h-0 flex-1">{children}</main>
      <ResumeGuard />
      <QuotaInsufficientModal />
    </div>
  )
}
