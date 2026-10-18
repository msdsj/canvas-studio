/**
 * 选区上下文的共享工具。
 *
 * 两个必须两边一致的东西：
 * 1. **指纹算法**：后端用同一套 FNV-1a 计算，用来判断「这份计划还是不是针对当前选区算的」。
 *    不一致就说明选区变了，旧计划必须作废，不能拿旧结论去执行新选区。
 * 2. **产出预估**：张数规则与后端 `estimate_outputs` 保持一致——
 *    整图类能力合并为 1 张；素材类按 `per_region` 决定每区域各 1 张还是合并 1 张。
 */

export interface SelectionRegionPayload {
  index: number
  region: { x: number; y: number; w: number; h: number }
  path?: Array<{ x: number; y: number }> | null
  prompt?: string
  handler?: string
}

export interface SelectionPayload {
  asset_id?: string | null
  target_id?: string | null
  revision: number
  has_doodle: boolean
  width: number
  height: number
  regions: SelectionRegionPayload[]
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** 选区指纹：几何 + 能力（**不含 prompt**，改提示词不算选区变化）。 */
export function selectionFingerprint(regions: SelectionRegionPayload[]): string {
  const parts = regions.map((item, position) => {
    const index = item.index ?? position + 1
    const r = item.region
    const shape = item.path && item.path.length >= 3 ? `p${item.path.length}` : 'r'
    return `${index}:${round3(r.x)},${round3(r.y)},${round3(r.w)},${round3(r.h)}:${shape}:${item.handler || ''}`
  })
  let hash = 0x811c9dc5
  for (const byte of new TextEncoder().encode(parts.join('|'))) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** 产出明细：与后端 estimate_outputs 同规则。 */
export interface OutputBreakdown {
  handler: string
  label: string
  kind: 'composite' | 'sprite'
  count: number
  region_indexes: number[]
}

export function estimateOutputs(
  regions: Array<{ handler: string }>,
  catalog: Array<{ id: string; label: string; output: 'composite' | 'sprite'; per_region: boolean }>
): OutputBreakdown[] {
  const byHandler = new Map<string, { label: string; kind: 'composite' | 'sprite'; perRegion: boolean; indexes: number[] }>()
  regions.forEach((item, index) => {
    const meta = catalog.find((entry) => entry.id === item.handler)
    if (!meta) return
    const existing = byHandler.get(meta.id)
    if (existing) existing.indexes.push(index + 1)
    else
      byHandler.set(meta.id, {
        label: meta.label,
        kind: meta.output,
        perRegion: meta.per_region,
        indexes: [index + 1],
      })
  })
  const out: OutputBreakdown[] = []
  byHandler.forEach((value, handler) => {
    out.push({
      handler,
      label: value.label,
      kind: value.kind,
      count: value.perRegion ? value.indexes.length : 1,
      region_indexes: value.indexes,
    })
  })
  return out.sort((a, b) => (a.kind === 'composite' ? 0 : 1) - (b.kind === 'composite' ? 0 : 1))
}
