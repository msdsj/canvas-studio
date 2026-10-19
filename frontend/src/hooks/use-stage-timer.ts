import { useEffect, useRef, useState } from 'react'

/** 等待阶段：正常 → 偏慢（软超时）→ 超时（硬超时，需要用户决定） */
export type WaitPhase = 'normal' | 'slow' | 'stalled'

export interface StageTimerOptions {
  /** 是否在计时（false 时归零并停表） */
  active: boolean
  /** 起点（毫秒时间戳）；不传则以 active 变 true 的时刻为起点 */
  startedAt?: number | null
  /** 预期耗时（秒）：进度条在这个时间点走到约 63%，之后无限逼近但不到 100% */
  expectedSeconds: number
  /** 软超时（秒）：提示「比平时慢，仍在处理」 */
  softSeconds: number
  /** 硬超时（秒）：给出「继续等待 / 停止 / 重试」 */
  hardSeconds: number
}

export interface StageTimer {
  elapsed: number
  /** 0–0.96 的渐近进度：用于进度条，永远不会假装「已完成」 */
  progress: number
  phase: WaitPhase
  /** 用户点了「继续等待」：把硬超时往后顺延一个周期，回到 slow 态 */
  extend: () => void
}

/**
 * 模型调用的等待模型：计时 + 渐近进度 + 软/硬超时。
 *
 * 为什么是渐近曲线而不是线性：模型耗时不可预知，线性进度条要么提前到头卡住，
 * 要么一直很短让人焦虑。`1 - e^(-t/τ)` 前段走得快（给「在动」的确定感），
 * 越往后越慢，到超时也只到 90% 出头——真正的 100% 只属于结果落地那一刻。
 */
export function useStageTimer({
  active,
  startedAt,
  expectedSeconds,
  softSeconds,
  hardSeconds,
}: StageTimerOptions): StageTimer {
  const [elapsed, setElapsed] = useState(0)
  const [extraHard, setExtraHard] = useState(0)
  const localStart = useRef<number | null>(null)

  useEffect(() => {
    if (!active) {
      localStart.current = null
      setElapsed(0)
      setExtraHard(0)
      return
    }
    if (localStart.current === null) localStart.current = Date.now()
    const origin = startedAt ?? localStart.current
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - origin) / 1000)))
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [active, startedAt])

  const hard = hardSeconds + extraHard
  const phase: WaitPhase = elapsed >= hard ? 'stalled' : elapsed >= softSeconds ? 'slow' : 'normal'
  const progress = active ? Math.min(0.96, 1 - Math.exp(-elapsed / Math.max(1, expectedSeconds))) : 0

  return {
    elapsed,
    progress,
    phase,
    extend: () => setExtraHard((value) => value + hardSeconds),
  }
}

/** 把秒数格式化成 `42s` / `1:05`：等待态里只需要这个精度。 */
export function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
