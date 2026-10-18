import { create } from 'zustand'

export type MobileSegment = 'canvas' | 'chat'
/** 登录弹窗的两种形态：登录 / 注册。 */
export type AuthMode = 'login' | 'register'
/** 工作室左栏的三个分区：历史对话 / 参考图 / 作品。 */
export type StudioTab = 'chats' | 'refs' | 'works'

interface UIState {
  leftbarCollapsed: boolean
  rightPanelOpen: boolean
  mobileSegment: MobileSegment
  quotaModalOpen: boolean
  activeTasksPanelOpen: boolean
  toggleLeftbar: () => void
  setRightPanelOpen: (open: boolean) => void
  setMobileSegment: (segment: MobileSegment) => void
  setQuotaModalOpen: (open: boolean) => void
  setActiveTasksPanelOpen: (open: boolean) => void

  /** 登录弹窗：全站唯一的登录入口（不再有独立登录页） */
  authOpen: boolean
  authMode: AuthMode
  /** 弹窗顶部的一句上下文，如「登录后即可开始生成」 */
  authReason: string
  openAuth: (mode?: AuthMode, reason?: string) => void
  closeAuth: () => void

  studioTab: StudioTab
  setStudioTab: (tab: StudioTab) => void
}

export const useUIStore = create<UIState>((set, get) => ({
  // 默认折叠：菜单只留图标条，把宽度优先让给画布；需要时点「展开」看图层
  leftbarCollapsed: true,
  rightPanelOpen: true,
  mobileSegment: 'canvas',
  quotaModalOpen: false,
  activeTasksPanelOpen: false,
  toggleLeftbar: () => set({ leftbarCollapsed: !get().leftbarCollapsed }),
  setRightPanelOpen: (open) => set({ rightPanelOpen: open }),
  setMobileSegment: (segment) => set({ mobileSegment: segment }),
  setQuotaModalOpen: (open) => set({ quotaModalOpen: open }),
  setActiveTasksPanelOpen: (open) => set({ activeTasksPanelOpen: open }),

  authOpen: false,
  authMode: 'login',
  authReason: '',
  openAuth: (mode = 'login', reason = '') => set({ authOpen: true, authMode: mode, authReason: reason }),
  closeAuth: () => set({ authOpen: false, authReason: '' }),

  studioTab: 'chats',
  setStudioTab: (tab) => set({ studioTab: tab }),
}))
