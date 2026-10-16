import { create } from 'zustand'

export type MobileSegment = 'canvas' | 'chat'

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
}

export const useUIStore = create<UIState>((set, get) => ({
  leftbarCollapsed: false,
  rightPanelOpen: true,
  mobileSegment: 'canvas',
  quotaModalOpen: false,
  activeTasksPanelOpen: false,
  toggleLeftbar: () => set({ leftbarCollapsed: !get().leftbarCollapsed }),
  setRightPanelOpen: (open) => set({ rightPanelOpen: open }),
  setMobileSegment: (segment) => set({ mobileSegment: segment }),
  setQuotaModalOpen: (open) => set({ quotaModalOpen: open }),
  setActiveTasksPanelOpen: (open) => set({ activeTasksPanelOpen: open }),
}))
