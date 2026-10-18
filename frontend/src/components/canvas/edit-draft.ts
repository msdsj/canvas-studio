import type { AnnotationObject } from './annotations'
import type { DoodleStroke, NormRegion } from './canvas-helpers'

/**
 * 图片编辑草稿（按图片维度隔离，内存态）。
 *
 * 为什么需要它：编辑层的选区与提示词原本只存在组件局部 state 里，
 * 一旦「点画布空白处退出编辑」或「切去编辑另一张图」，组件就会重新水合，
 * 用户辛苦框好的区域和写好的指令全部蒸发。草稿表把这两类内容按图片 id
 * 挂起来，退出/切换后再进来能原样恢复。
 *
 * 三条设计约束：
 * 1. **只存内存**：草稿是「未提交的临时意图」，刷新页面即失效——不落 localStorage，
 *    避免用户下次打开看到一张早已过期的选区图。
 * 2. **按图片隔离**：键 = 画布元素 id + 图片指纹。多图交替编辑互不影响，各自恢复各自的。
 * 3. **有界**：FIFO 上限 12 张（读不改变顺序），超出淘汰最早写入的，防止长时间使用后无限增长。
 */

/** 选区种类：三类选区在数据结构上完全同构，只是渲染与掩码绘制方式不同。 */
export type RegionKind = 'rect' | 'lasso' | 'brush'

export interface EditRegion {
  id: string
  /** 选区种类（矩形 / 套索 / 画笔） */
  kind: RegionKind
  region: NormRegion
  /** 自由选区（套索）的多边形顶点；有值时按多边形而不是包围盒渲染与提交 */
  path?: Array<{ x: number; y: number }>
  /** 画笔选区的笔迹（归一化坐标）；`kind === 'brush'` 时使用 */
  strokes?: DoodleStroke[]
  /** 该区域独立使用的编辑能力（来自后端能力注册表） */
  handler: string
  /** 该区域独立的修改提示词（用户按区域填写） */
  prompt: string
  /** 用户是否手动指定过能力；手动指定后不再被提示词意图自动改写 */
  handlerTouched?: boolean
}

export interface EditDraft {
  regions: EditRegion[]
  /** 标注涂鸦笔迹：和选区一起恢复，否则「框还在、标注没了」同样算丢内容 */
  strokes: DoodleStroke[]
  /**
   * 标注对象（边框 / 标记，R07/R08）。
   *
   * 与选区**同生命周期**：一起存取、一起清空。不放进 `regions` 是硬约束
   * （否则 `paintUnionMask` 会把标注当成挖洞区，见 ADR-5）。
   */
  annotations: AnnotationObject[]
  /**
   * 统一编号器（R08）：序号标注的下一可用号。
   * 必须跟着草稿一起存取——只存标注不存它，恢复后新序号会从 1 重来并与旧号撞车。
   */
  annotationSeq: number
  updatedAt: number
}

/** 草稿表上限：够覆盖一次会话里来回编辑的图，又不会长期占内存 */
const MAX_DRAFTS = 12

const drafts = new Map<string, EditDraft>()
/** 已提示过「已恢复」的图片：同一张图每次会话只提示一次 */
const restoreNotified = new Set<string>()

/**
 * 草稿键 = 画布元素 id + 图片指纹。
 *
 * 为什么要带指纹：图片被重新生成 / 替换后，元素 id 可能不变但内容已经换了，
 * 这时把上一版图的选区套到新图上就是错的。指纹一变，旧草稿自然不再命中。
 * 指纹用「长度 + 抽样字符」的轻量哈希：dataURL 可能有好几 MB，
 * 每次进编辑都整串哈希不值当，而抽样已经足够区分两张不同的图。
 */
export function editDraftKey(
  elementId: string | null | undefined,
  source: string | null | undefined
): string | null {
  if (!elementId) return null
  return `${elementId}:${fingerprint(source ?? '')}`
}

function fingerprint(text: string): string {
  if (!text) return '0'
  let hash = 5381
  const step = Math.max(1, Math.floor(text.length / 256))
  for (let i = 0; i < text.length; i += step) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  }
  return `${text.length.toString(36)}${(hash >>> 0).toString(36)}`
}

/** 读取草稿（FIFO：读不改变淘汰顺序，避免来回切图把别的草稿挤掉）。 */
export function readEditDraft(key: string | null | undefined): EditDraft | null {
  if (!key) return null
  return drafts.get(key) ?? null
}

/** 写入草稿（空草稿直接删键，避免「恢复了 0 个区域」这种假状态）。 */
export function writeEditDraft(
  key: string | null | undefined,
  draft: {
    regions: EditRegion[]
    strokes: DoodleStroke[]
    annotations?: AnnotationObject[]
    annotationSeq?: number
  }
): void {
  if (!key) return
  const annotations = draft.annotations ?? []
  // 空判断必须把 annotations 算进来：只画了边框/标记（无选区、无涂鸦）也是**有内容**的草稿，
  // 漏掉这一项会让「画完边框切走再回来」变成「边框全没了」。
  if (draft.regions.length === 0 && draft.strokes.length === 0 && annotations.length === 0) {
    drafts.delete(key)
    return
  }
  drafts.set(key, {
    regions: draft.regions,
    strokes: draft.strokes,
    annotations,
    annotationSeq: Math.max(1, Math.floor(draft.annotationSeq ?? 1)),
    updatedAt: Date.now(),
  })
  while (drafts.size > MAX_DRAFTS) {
    const oldest = drafts.keys().next().value
    if (oldest === undefined) break
    drafts.delete(oldest)
    // 被淘汰的图若之后又存了草稿，重新提示一次恢复是合理的
    restoreNotified.delete(oldest)
  }
}

/** 清掉某张图的草稿：提交成功 / 删图时调用。 */
export function clearEditDraft(key: string | null | undefined): void {
  if (!key) return
  drafts.delete(key)
  restoreNotified.delete(key)
}

/**
 * 按元素 id 清掉它名下的所有草稿（不管指纹是什么）。
 * 删图时用：调用方手上不一定有 dataUrl，但元素 id 一定有。
 */
export function clearEditDraftsForElement(elementId: string | null | undefined): void {
  if (!elementId) return
  const prefix = `${elementId}:`
  for (const key of Array.from(drafts.keys())) {
    if (key.startsWith(prefix)) drafts.delete(key)
  }
  for (const key of Array.from(restoreNotified)) {
    if (key.startsWith(prefix)) restoreNotified.delete(key)
  }
}

/**
 * 标记「已恢复」提示已展示过。
 * 返回 true 表示这是这张图本次会话第一次恢复——调用方据此弹一次提示，
 * 反复进出同一张图不再刷屏。
 */
export function markRestoreNotified(key: string | null | undefined): boolean {
  if (!key) return false
  if (restoreNotified.has(key)) return false
  restoreNotified.add(key)
  return true
}
