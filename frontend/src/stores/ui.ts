import { create } from 'zustand'

export type MobileSegment = 'canvas' | 'chat'
/** 登录弹窗的两种形态：登录 / 注册。 */
export type AuthMode = 'login' | 'register'
/** 工作室左栏的三个分区：历史对话 / 参考图 / 作品。 */
export type StudioTab = 'chats' | 'refs' | 'works'

const AGENT_PANEL_KEY = 'cs.agentPanel'

/** Agent 面板默认展开；只有用户主动收起过才记住「收起」。 */
function readAgentPanelOpen(): boolean {
  try {
    return localStorage.getItem(AGENT_PANEL_KEY) !== 'closed'
  } catch {
    return true
  }
}

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

  /** 工作台左侧 Agent 对话面板（Lovart 式：对话在左、画布在右，可收起） */
  agentPanelOpen: boolean
  setAgentPanelOpen: (open: boolean) => void
  /** 「历史 / 参考图 / 作品」抽屉：贴在 Agent 面板右侧，按需展开 */
  studioDrawerOpen: boolean
  /** 打开抽屉并切到指定分区；再次点同一分区则收起 */
  toggleStudioDrawer: (tab?: StudioTab) => void
  closeStudioDrawer: () => void

  /** 升级 / 激活 Pro 弹窗：全站唯一入口，任意 Pro 能力被拦下时都能唤起 */
  proDialogOpen: boolean
  /** 唤起原因（用于弹窗顶部说明"你刚刚想用的功能"），留空则用通用文案 */
  proDialogReason: string
  openProDialog: (reason?: string) => void
  closeProDialog: () => void
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

  agentPanelOpen: readAgentPanelOpen(),
  setAgentPanelOpen: (open) => {
    try {
      localStorage.setItem(AGENT_PANEL_KEY, open ? 'open' : 'closed')
    } catch {
      /* ignore */
    }
    set({ agentPanelOpen: open })
  },
  studioDrawerOpen: false,
  toggleStudioDrawer: (tab) => {
    const { studioDrawerOpen, studioTab } = get()
    if (!tab) return set({ studioDrawerOpen: !studioDrawerOpen })
    if (studioDrawerOpen && studioTab === tab) return set({ studioDrawerOpen: false })
    set({ studioDrawerOpen: true, studioTab: tab })
  },
  closeStudioDrawer: () => set({ studioDrawerOpen: false }),

  proDialogOpen: false,
  proDialogReason: '',
  openProDialog: (reason = '') => set({ proDialogOpen: true, proDialogReason: reason }),
  closeProDialog: () => set({ proDialogOpen: false, proDialogReason: '' }),
}))
