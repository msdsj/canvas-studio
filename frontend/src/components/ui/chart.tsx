import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * 手写 SVG 图表（不引第三方图表库）。
 *
 * 为什么不用 recharts：为了两张折线图引入 ~120KB 依赖不划算。
 * 这里只实现两类图：折线（带面积）与柱状，覆盖「消耗趋势」「新增用户」这类场景。
 *
 * 规格来自 `docs/13-design-system-v3.md` 第 6 章：
 * - 颜色只读 `--chart-*` token（亮/暗各一套），禁止硬编码；
 * - 网格只画**横向实线**（纸感语言里虚线像草稿）；
 * - 面积是单色平铺 10%，**不做垂直渐变**（那是 AI 模板的标配）；
 * - y 轴 3 档刻度、x 轴最多 5 个标签；
 * - 容器高度固定，避免数据到达时 CLS；
 * - 入场：折线 `.cs-draw` 自绘 720ms，柱状从 0 长起来，**只在首次拿到数据时播**。
 */

export interface ChartSeries {
  key: string
  label: string
  /** CSS 颜色，默认 --chart-1；传 var(--chart-2) 等 */
  color?: string
  values: number[]
}

interface ChartBaseProps {
  series: ChartSeries[]
  /** x 轴标签，与 series[0].values 等长 */
  labels: string[]
  height?: number
  /** 数值格式化（默认千分位） */
  formatValue?: (value: number) => string
  /** 空数据文案 */
  emptyText?: string
  className?: string
}

/** 绘图区内边距（留白），不是坐标。 */
const PAD = { top: 8, right: 8, bottom: 24, left: 44 }

/** 容器宽度自适应：SVG 用真实像素渲染，文字与线宽才不会被拉伸。 */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0
      if (w > 0) setWidth(w)
    })
    ro.observe(el)
    setWidth(el.getBoundingClientRect().width)
    return () => ro.disconnect()
  }, [])
  return { ref, width }
}

function niceMax(value: number): number {
  if (value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  return Math.ceil(value / magnitude) * magnitude
}

function defaultFormat(value: number): string {
  return value.toLocaleString('zh-CN')
}

/** 轴刻度专用：超过 1000 写成 1.2k，手机上才不会挤成一团。 */
function axisFormat(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 10000) return `${Math.round(value / 1000)}k`
  if (abs >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(Math.round(value))
}

/** 空数据态：同高、虚线基线、居中一句话。 */
function ChartEmpty({ height, text }: { height: number; text: string }) {
  return (
    <div
      className="flex items-center justify-center text-caption text-text-tertiary"
      style={{ height }}
    >
      <div className="flex w-full flex-col items-center gap-3">
        <span aria-hidden className="h-px w-24 border-t border-dashed border-border" />
        <span>{text}</span>
      </div>
    </div>
  )
}

function ChartTooltip({
  x,
  y,
  label,
  rows,
}: {
  x: number
  y: number
  label: string
  rows: { label: string; value: string; color: string }[]
}) {
  return (
    <div
      className="pointer-events-none absolute z-10 rounded-[10px] border border-border bg-surface px-3 py-2 shadow-lift"
      style={{
        left: `${x}px`,
        top: `${y}px`,
        transform: 'translate(-50%, calc(-100% - 12px))',
      }}
    >
      <p className="text-micro text-text-tertiary">{label}</p>
      {rows.map((row) => (
        <p key={row.label} className="mt-1 flex items-center gap-1.5">
          <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: row.color }} />
          <span className="text-caption text-text-secondary">{row.label}</span>
          <span className="font-mono text-caption font-semibold tabular-nums text-text">
            {row.value}
          </span>
        </p>
      ))}
    </div>
  )
}

/** y 轴刻度：0 / 中 / 最大三个。 */
function AxisTicks({
  max,
  baseline,
  plotHeight,
  left,
}: {
  max: number
  baseline: number
  plotHeight: number
  left: number
}) {
  const ticks = [0, max / 2, max]
  return (
    <>
      {ticks.map((tick) => {
        const y = baseline - (tick / max) * plotHeight
        return (
          <text
            key={tick}
            x={left - 8}
            y={y + 3.5}
            textAnchor="end"
            className="fill-[var(--chart-label)] font-mono text-[11px] tabular-nums"
          >
            {axisFormat(tick)}
          </text>
        )
      })}
    </>
  )
}

/** x 轴标签：最多 5 个，均匀取样。 */
function AxisLabels({
  labels,
  left,
  right,
  baseline,
  width,
}: {
  labels: string[]
  left: number
  right: number
  baseline: number
  width: number
}) {
  const step = Math.max(1, Math.ceil(labels.length / 5))
  const inner = width - left - right
  const last = labels.length - 1

  // 采样：每隔 step 取一个，最后一个一定显示。
  // 末尾那个采样点如果离末位太近就丢掉——否则「10-20」和「10-24」会叠在一起。
  const indices: number[] = []
  for (let i = 0; i < labels.length; i += step) indices.push(i)
  if (indices[indices.length - 1] !== last) {
    if (last - indices[indices.length - 1] < step * 0.6) indices.pop()
    indices.push(last)
  }

  return (
    <>
      {indices.map((index) => {
        const label = labels[index]
        if (label === undefined) return null
        const x = left + (labels.length <= 1 ? inner / 2 : (index / (labels.length - 1)) * inner)
        return (
          <text
            key={`${label}-${index}`}
            x={x}
            y={baseline + 16}
            textAnchor="middle"
            className="fill-[var(--chart-label)] text-[11px]"
          >
            {label}
          </text>
        )
      })}
    </>
  )
}

/** 折线图（含单色面积）。 */
export function LineChart({
  series,
  labels,
  height = 180,
  formatValue = defaultFormat,
  emptyText = '这段时间还没有数据',
  className,
}: ChartBaseProps) {
  const { ref, width } = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const [drawn, setDrawn] = useState(false)

  const values = series[0]?.values ?? []
  const max = useMemo(
    () => niceMax(Math.max(1, ...series.flatMap((s) => s.values))),
    [series],
  )

  // 只在首次拿到数据时播一次入场动画
  useEffect(() => {
    if (!values.length) {
      setDrawn(false)
      return
    }
    const timer = window.setTimeout(() => setDrawn(true), 0)
    return () => window.clearTimeout(timer)
  }, [values.length])

  if (!series.length || !values.length) {
    return (
      <div ref={ref} className={className}>
        <ChartEmpty height={height} text={emptyText} />
      </div>
    )
  }

  const padLeft = width < 480 ? 32 : PAD.left
  const inner = Math.max(0, width - padLeft - PAD.right)
  const baseline = height - PAD.bottom
  const plotHeight = Math.max(1, baseline - PAD.top)
  const pointX = (index: number) =>
    padLeft + (values.length <= 1 ? inner / 2 : (index / (values.length - 1)) * inner)
  const pointY = (value: number) => baseline - (value / max) * plotHeight

  return (
    <div ref={ref} className={cn('relative', className)} style={{ height }}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={series.map((s) => s.label).join(' / ')}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            const x = event.clientX - rect.left
            const ratio = (x - padLeft) / (inner || 1)
            const index = Math.round(ratio * (values.length - 1))
            setHover(index >= 0 && index < values.length ? index : null)
          }}
        >
          {/* 网格：只有横向实线 */}
          {[0, 0.5, 1].map((ratio) => {
            const y = baseline - ratio * plotHeight
            return (
              <line
                key={ratio}
                x1={padLeft}
                x2={width - PAD.right}
                y1={y}
                y2={y}
                stroke="var(--chart-grid)"
                strokeWidth={1}
              />
            )
          })}
          <AxisTicks max={max} baseline={baseline} plotHeight={plotHeight} left={padLeft} />
          <AxisLabels
            labels={labels}
            left={padLeft}
            right={PAD.right}
            baseline={baseline}
            width={width}
          />

          {series.map((s, si) => {
            const color = s.color ?? `var(--chart-${(si % 4) + 1})`
            const path = s.values.map((v, i) => `${i === 0 ? 'M' : 'L'}${pointX(i)},${pointY(v)}`).join(' ')
            const area = `${path} L${pointX(s.values.length - 1)},${baseline} L${pointX(0)},${baseline} Z`
            return (
              <g key={s.key}>
                <path d={area} fill={color} opacity={0.1} />
                <path
                  d={path}
                  fill="none"
                  stroke={color}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={drawn ? 'cs-draw' : undefined}
                  style={{ ['--draw-len' as string]: 2000 }}
                />
                {values.length <= 14 &&
                  s.values.map((v, i) => (
                    <circle
                      key={i}
                      cx={pointX(i)}
                      cy={pointY(v)}
                      r={3}
                      fill={color}
                      stroke="var(--chart-dot-ring)"
                      strokeWidth={2}
                    />
                  ))}
              </g>
            )
          })}

          {hover !== null && (
            <line
              x1={pointX(hover)}
              x2={pointX(hover)}
              y1={PAD.top}
              y2={baseline}
              stroke="var(--chart-axis)"
              strokeWidth={1}
            />
          )}
        </svg>
      )}
      {hover !== null && (
        <ChartTooltip
          x={pointX(hover)}
          y={pointY(series[0].values[hover] ?? 0)}
          label={labels[hover] ?? ''}
          rows={series.map((s, si) => ({
            label: s.label,
            value: formatValue(s.values[hover] ?? 0),
            color: s.color ?? `var(--chart-${(si % 4) + 1})`,
          }))}
        />
      )}
    </div>
  )
}

/** 柱状图。 */
export function BarChart({
  series,
  labels,
  height = 180,
  formatValue = defaultFormat,
  emptyText = '这段时间还没有数据',
  className,
}: ChartBaseProps) {
  const { ref, width } = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const [grown, setGrown] = useState(false)

  const values = series[0]?.values ?? []
  const max = useMemo(() => niceMax(Math.max(1, ...values)), [values])

  useEffect(() => {
    if (!values.length) {
      setGrown(false)
      return
    }
    const timer = window.setTimeout(() => setGrown(true), 0)
    return () => window.clearTimeout(timer)
  }, [values.length])

  if (!series.length || !values.length) {
    return (
      <div ref={ref} className={className}>
        <ChartEmpty height={height} text={emptyText} />
      </div>
    )
  }

  const padLeft = width < 480 ? 32 : PAD.left
  const inner = Math.max(0, width - padLeft - PAD.right)
  const baseline = height - PAD.bottom
  const plotHeight = Math.max(1, baseline - PAD.top)
  const slot = inner / values.length
  const barW = Math.max(6, Math.min(24, slot - 4))
  const pointX = (index: number) => padLeft + slot * index + slot / 2

  return (
    <div ref={ref} className={cn('relative', className)} style={{ height }}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={series.map((s) => s.label).join(' / ')}
          onMouseLeave={() => setHover(null)}
        >
          {[0, 0.5, 1].map((ratio) => {
            const y = baseline - ratio * plotHeight
            return (
              <line
                key={ratio}
                x1={padLeft}
                x2={width - PAD.right}
                y1={y}
                y2={y}
                stroke="var(--chart-grid)"
                strokeWidth={1}
              />
            )
          })}
          <AxisTicks max={max} baseline={baseline} plotHeight={plotHeight} left={padLeft} />
          <AxisLabels
            labels={labels}
            left={padLeft}
            right={PAD.right}
            baseline={baseline}
            width={width}
          />

          {series.map((s, si) => {
            const color = s.color ?? `var(--chart-${(si % 4) + 1})`
            return (
              <g key={s.key}>
                {s.values.map((v, i) => {
                  const h = (v / max) * plotHeight
                  return (
                    <rect
                      key={i}
                      x={pointX(i) - barW / 2}
                      y={baseline - h}
                      width={barW}
                      height={Math.max(0, h)}
                      rx={2}
                      fill={color}
                      opacity={hover === null || hover === i ? 1 : 0.55}
                      style={
                        grown
                          ? {
                              transformOrigin: `center ${baseline}px`,
                              animation: 'cs-bar-grow var(--motion-enter) var(--ease-out) both',
                              animationDelay: `calc(min(${i}, 7) * var(--motion-stagger))`,
                            }
                          : { transform: 'scaleY(0)', transformOrigin: `center ${baseline}px` }
                      }
                      onMouseEnter={() => setHover(i)}
                    />
                  )
                })}
              </g>
            )
          })}
        </svg>
      )}
      {hover !== null && (
        <ChartTooltip
          x={pointX(hover)}
          y={baseline - ((series[0].values[hover] ?? 0) / max) * plotHeight}
          label={labels[hover] ?? ''}
          rows={series.map((s, si) => ({
            label: s.label,
            value: formatValue(s.values[hover] ?? 0),
            color: s.color ?? `var(--chart-${(si % 4) + 1})`,
          }))}
        />
      )}
      <style>{`@keyframes cs-bar-grow { from { transform: scaleY(0); } to { transform: scaleY(1); } }`}</style>
    </div>
  )
}
