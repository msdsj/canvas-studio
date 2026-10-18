import { create } from 'zustand'

/**
 * 首页 → 工作室的「一次提交」交接单。
 *
 * 首页的输入框不属于任何会话（用户可能还没登录），所以这句话不能直接发出去：
 * 先暂存在这里，跳转后由工作室的对话面板取走并自动提交。
 * File 对象只能活在内存里——这正好，我们不希望把用户的参考图写进 localStorage。
 */
interface ComposerHandoff {
  text: string
  files: File[]
  /** 是否还有一份没被工作室消费的提交 */
  pending: boolean
  stage: (text: string, files?: File[]) => void
  /** 取走并清空（幂等：重复调用拿到空单） */
  consume: () => { text: string; files: File[] }
  clear: () => void
}

export const useComposerHandoff = create<ComposerHandoff>((set, get) => ({
  text: '',
  files: [],
  pending: false,
  stage: (text, files = []) => set({ text, files, pending: Boolean(text.trim()) }),
  consume: () => {
    const { text, files, pending } = get()
    if (!pending) return { text: '', files: [] }
    set({ text: '', files: [], pending: false })
    return { text, files }
  },
  clear: () => set({ text: '', files: [], pending: false }),
}))
