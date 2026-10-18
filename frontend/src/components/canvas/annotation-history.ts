/**
 * 统一撤销栈（R17）：标注 / 选区 / 笔迹**共用一条 op 栈**。
 *
 * 为什么必须重写（ARCH-v2 §8.2-风险 3）：
 * 原实现 `redoRef` 只存 `DoodleStroke`，塞不进 border/marker；而"标注走一套撤销、
 * 笔迹走另一套"会让撤销顺序与用户的操作顺序脱钩，撤销后重做还会产生重复对象。
 *
 * 三条硬约束：
 * 1. **不存全量快照**：`ImageEditLayer.tsx` 已有 2000+ 行状态，每次变更存一份
 *    全量快照会在连续拖拽/涂鸦时把内存打爆。这里只存「单个对象的前后态」。
 * 2. **深度上限 50**：够覆盖一次编辑里的来回操作，又不会无限增长。
 * 3. **所有变更走 `commit()`**：`commit` 是唯一入口，它负责「记录 + 立即应用 after」。
 *    绕过它直接 setState 的变更不会被撤销（= 撤销栈与画面失步）。
 *
 * 载荷形状 `{ index, value }`：
 * - `index` 是对象在其集合里的位置。重做/撤销时插回**原位**，
 *   否则「撤销 3 步再重做 3 步」会让图层顺序（笔迹叠放顺序）漂移。
 * - `add`：`before` 为空，`after` 有值；`remove`：`before` 有值，`after` 为空；
 *   `move`：两者都有（`before` = 变更前对象，`after` = 变更后对象）。
 */

/** 变更类型 */
export type HistoryOpType = 'add' | 'remove' | 'move'

/** 变更作用的对象类别：标注对象 / 选区 / 涂鸦笔迹 */
export type HistoryTarget = 'annotation' | 'region' | 'stroke'

/** 撤销栈深度上限（ARCH-v2 §6.5 / B6-2） */
export const HISTORY_DEPTH = 50

/** 单个对象的载荷：`index` = 在集合里的位置，`value` = 对象本身 */
export interface OpPayload<T = unknown> {
  index: number
  value: T
}

/** 一次可撤销的变更 */
export interface HistoryOp<T = unknown> {
  type: HistoryOpType
  target: HistoryTarget
  /** 对象 id（`stroke` 目标同样要求 id：涂鸦对象在入栈时补一个 uuid） */
  id: string
  /** 变更前的对象（`add` 时缺省） */
  before?: OpPayload<T>
  /** 变更后的对象（`remove` 时缺省） */
  after?: OpPayload<T>
}

/** 应用方向：`undo` 用 `before` 还原，`redo`（含新变更）用 `after` 落地 */
export type HistoryDirection = 'undo' | 'redo'

/** 真正改状态的回调：由持有 state 的组件提供 */
export type HistoryApply = (op: HistoryOp, direction: HistoryDirection) => void

export interface HistoryOptions {
  /** 应用回调（必填）：栈本身不碰 state，只负责顺序与去重 */
  onApply: HistoryApply
  /** 深度上限，缺省 50 */
  depth?: number
}

/**
 * op 栈。
 *
 * 用法：
 * ```ts
 * const history = new AnnotationHistory({ onApply: applyOp })
 * history.commit({ type: 'add', target: 'annotation', id, after: { index: 0, value: ann } })
 * history.undo()
 * ```
 */
export class AnnotationHistory {
  private readonly undoStack: HistoryOp[] = []
  private redoStack: HistoryOp[] = []
  private readonly depth: number
  private readonly onApply: HistoryApply

  constructor(options: HistoryOptions) {
    this.depth = Math.max(1, Math.floor(options.depth ?? HISTORY_DEPTH))
    this.onApply = options.onApply
  }

  /**
   * 记录一次变更并**立即应用**（`after` 态）。
   *
   * @param op 变更描述
   * @param options.merge 为 true 时，若栈顶是同 target + 同 id 的 `move`，
   *        则把本次的 `after` 合并进去（保留最初 `before`）。
   *        拖拽每帧都产生一次 move，不合并会把 50 层栈瞬间刷满，
   *        且撤销一次只退 1px——合并后「一次拖拽 = 一步撤销」。
   */
  commit(op: HistoryOp, options: { merge?: boolean } = {}): void {
    const last = this.undoStack[this.undoStack.length - 1]
    const canMerge =
      options.merge === true &&
      last !== undefined &&
      last.type === 'move' &&
      op.type === 'move' &&
      last.target === op.target &&
      last.id === op.id
    if (canMerge) {
      last.after = op.after
    } else {
      this.undoStack.push(op)
      while (this.undoStack.length > this.depth) this.undoStack.shift()
    }
    // 新变更让「重做」分支失效：与所有编辑器一致，不做分支树
    this.redoStack = []
    this.onApply(op, 'redo')
  }

  /** 撤销一步；返回是否真的撤销了 */
  undo(): boolean {
    const op = this.undoStack.pop()
    if (!op) return false
    this.redoStack.push(op)
    this.onApply(op, 'undo')
    return true
  }

  /** 重做一步；返回是否真的重做了 */
  redo(): boolean {
    const op = this.redoStack.pop()
    if (!op) return false
    this.undoStack.push(op)
    this.onApply(op, 'redo')
    return true
  }

  canUndo(): boolean {
    return this.undoStack.length > 0
  }

  canRedo(): boolean {
    return this.redoStack.length > 0
  }

  /** 当前可撤销步数 */
  undoSize(): number {
    return this.undoStack.length
  }

  /** 当前可重做步数 */
  redoSize(): number {
    return this.redoStack.length
  }

  /** 清空（切图 / 提交成功 / 草稿重建时调用：旧 op 对新图没有意义） */
  clear(): void {
    this.undoStack.length = 0
    this.redoStack.length = 0
  }
}

/**
 * 从「目标载荷」算出新的集合：删掉同 id 的旧对象，再把目标对象插回 `index`。
 *
 * 三个 op 类型共用这一个函数，避免「add/remove/move 各写一套 upsert」而漏掉某个分支：
 * - 目标载荷为空（`add` 的 undo / `remove` 的 redo）→ 只删；
 * - 目标载荷有值 → 删旧 + 插回原位。
 */
export function applyPayloadTo<T>(
  list: T[],
  id: string,
  payload: OpPayload<T> | undefined,
  getId: (value: T) => string
): T[] {
  const without = list.filter((value) => getId(value) !== id)
  if (!payload) return without
  const index = Math.max(0, Math.min(Math.floor(payload.index), without.length))
  return [...without.slice(0, index), payload.value, ...without.slice(index)]
}

/** 找出对象在集合里的位置与对象本身（构造 `before` 载荷用）；找不到返回 null */
export function findPayload<T>(
  list: T[],
  id: string,
  getId: (value: T) => string
): OpPayload<T> | null {
  const index = list.findIndex((value) => getId(value) === id)
  if (index < 0) return null
  return { index, value: list[index] }
}
