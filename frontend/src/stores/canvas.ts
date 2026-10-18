import { create } from 'zustand'
import type { Canvas } from '@/types/models'

type SaveStatus = 'saved' | 'saving' | 'dirty' | 'error'

interface CanvasState {
  canvas: Canvas | null
  /** 画布所属项目名（顶栏展示「项目 · 画布」用） */
  projectName: string
  selectedElementIds: string[]
  saveStatus: SaveStatus
  lastSavedAt: number | null
  setCanvas: (canvas: Canvas | null) => void
  setProjectName: (name: string) => void
  setSelectedElementIds: (ids: string[]) => void
  setSaveStatus: (status: SaveStatus) => void
  markSaved: () => void
}

export const useCanvasStore = create<CanvasState>((set) => ({
  canvas: null,
  projectName: '',
  selectedElementIds: [],
  saveStatus: 'saved',
  lastSavedAt: null,
  setCanvas: (canvas) => set({ canvas }),
  setProjectName: (name) => set({ projectName: name }),
  setSelectedElementIds: (ids) => set({ selectedElementIds: ids }),
  setSaveStatus: (status) => set({ saveStatus: status }),
  markSaved: () => set({ saveStatus: 'saved', lastSavedAt: Date.now() }),
}))
