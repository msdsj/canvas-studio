import { create } from 'zustand'
import type { Canvas } from '@/types/models'

type SaveStatus = 'saved' | 'saving' | 'dirty' | 'error'

interface CanvasState {
  canvas: Canvas | null
  selectedElementIds: string[]
  saveStatus: SaveStatus
  lastSavedAt: number | null
  setCanvas: (canvas: Canvas | null) => void
  setSelectedElementIds: (ids: string[]) => void
  setSaveStatus: (status: SaveStatus) => void
  markSaved: () => void
}

export const useCanvasStore = create<CanvasState>((set) => ({
  canvas: null,
  selectedElementIds: [],
  saveStatus: 'saved',
  lastSavedAt: null,
  setCanvas: (canvas) => set({ canvas }),
  setSelectedElementIds: (ids) => set({ selectedElementIds: ids }),
  setSaveStatus: (status) => set({ saveStatus: status }),
  markSaved: () => set({ saveStatus: 'saved', lastSavedAt: Date.now() }),
}))
