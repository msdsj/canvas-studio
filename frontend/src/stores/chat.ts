import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { addActiveTask, removeActiveTask } from '@/lib/task-persistence'

interface ChatState {
  /** 进行中任务 id（持久化到 localStorage，刷新后恢复） */
  activeTaskIds: string[]
  /** 正在流式输出的助手文本（内存态） */
  streaming: Record<string, string>
  registerTask: (id: string) => void
  unregisterTask: (id: string) => void
  setActiveTasks: (ids: string[]) => void
  setStreaming: (sessionId: string, text: string) => void
  appendStreaming: (sessionId: string, text: string) => void
  clearStreaming: (sessionId: string) => void
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      activeTaskIds: [],
      streaming: {},
      registerTask: (id) => {
        addActiveTask(id)
        const ids = get().activeTaskIds
        if (!ids.includes(id)) set({ activeTaskIds: [...ids, id] })
      },
      unregisterTask: (id) => {
        removeActiveTask(id)
        set({ activeTaskIds: get().activeTaskIds.filter((item) => item !== id) })
      },
      setActiveTasks: (ids) => {
        set({ activeTaskIds: Array.from(new Set(ids)) })
      },
      setStreaming: (sessionId, text) =>
        set({ streaming: { ...get().streaming, [sessionId]: text } }),
      appendStreaming: (sessionId, text) =>
        set({ streaming: { ...get().streaming, [sessionId]: (get().streaming[sessionId] || '') + text } }),
      clearStreaming: (sessionId) => {
        const next = { ...get().streaming }
        delete next[sessionId]
        set({ streaming: next })
      },
    }),
    {
      name: 'cs.chat',
      partialize: (state) => ({ activeTaskIds: state.activeTaskIds }),
    }
  )
)
