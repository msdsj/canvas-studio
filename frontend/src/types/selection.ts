/** 一个选区（矩形 / 套索多边形 / 画笔）。坐标均为相对原图 0-1。 */
export interface SelectionRegionContext {
  index: number
  region: { x: number; y: number; w: number; h: number }
  path?: Array<{ x: number; y: number }> | null
  prompt?: string
  handler?: string
}

/** 画布上抛给侧栏「需求分析中转站」的选区上下文。 */
export interface CanvasSelectionContext {
  asset_id?: string | null
  target_id?: string | null
  revision?: number
  width?: number
  height?: number
  has_doodle?: boolean
  /** 并集掩码资产 id：侧栏发消息前把 buildMask() 的产物上传后回填 */
  mask_asset_id?: string | null
  regions: SelectionRegionContext[]
  /** 生成并集掩码 PNG（透明=可编辑）；没有选区时返回 null */
  buildMask?: () => Promise<File | null>
}
