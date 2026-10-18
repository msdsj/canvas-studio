import { create } from 'zustand'

/**
 * 输入框里的「@ 引用图」。
 *
 * 与「参考图（上传 / 粘贴）」的区别：
 * - 参考图是**用户从外部带进来的**新材料；
 * - @引用是**画布上已有的图**（或刚生成的结果图）被点名参与这次对话。
 *
 * 二者最终都汇入 `image_refs` 交给后端，但在这个 store 里分开管理，因为
 * @引用的生命周期挂在画布选择上：点一张图就带进来，点 × 就走。
 */
export interface ComposerRef {
  /** 去重键：优先用资产 id，没有资产 id 时退回图片 URL */
  key: string
  /** 后端资产 id（有就能直接被图生图链路使用） */
  assetId?: string
  /** 缩略图地址（candidates: 资产 url / dataURL / 结果图 url） */
  url: string
  /** 展示名：默认「图 1 / 图 2」，用于 chip 上的 @ 标签 */
  label: string
}

/** 与「参考图」保持同一个上限：4 张，避免一次请求带上过多底图。 */
export const MAX_COMPOSER_REFS = 4

interface ComposerRefsState {
  refs: ComposerRef[]
  /** 递增信号：外部插入引用后用它把焦点交还输入框 */
  focusSignal: number
  /** 插入一条引用（按 key 去重；超出上限时忽略并返回 false）。 */
  addRef: (ref: Omit<ComposerRef, 'label'> & { label?: string }) => boolean
  removeRef: (key: string) => void
  clearRefs: () => void
}

/** 生成「图 n」标签：取当前未被占用的最小序号，让 chip 名字稳定可读。 */
function nextLabel(refs: ComposerRef[]): string {
  const used = new Set(refs.map((item) => item.label))
  for (let i = 1; i <= MAX_COMPOSER_REFS; i += 1) {
    const candidate = `图 ${i}`
    if (!used.has(candidate)) return candidate
  }
  return `图 ${refs.length + 1}`
}

export const useComposerRefs = create<ComposerRefsState>((set, get) => ({
  refs: [],
  focusSignal: 0,

  addRef: (input) => {
    const key = input.key
    if (!key) return false
    const current = get().refs
    if (current.some((item) => item.key === key)) {
      // 已在框里：只把焦点还回去，不重复插入（用户连点同一张图不该堆两条）
      set((state) => ({ focusSignal: state.focusSignal + 1 }))
      return true
    }
    if (current.length >= MAX_COMPOSER_REFS) return false
    const ref: ComposerRef = {
      key,
      assetId: input.assetId,
      url: input.url,
      label: input.label ?? nextLabel(current),
    }
    set((state) => ({ refs: [...state.refs, ref], focusSignal: state.focusSignal + 1 }))
    return true
  },

  removeRef: (key) =>
    set((state) => ({ refs: state.refs.filter((item) => item.key !== key) })),

  clearRefs: () => set({ refs: [] }),
}))
