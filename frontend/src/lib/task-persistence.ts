import { nanoid } from 'nanoid'

const ACTIVE_KEY = 'cs.activeTasks'
const IDEM_KEY = 'cs.idemKeys'

/** 读取进行中任务 id 列表。 */
export function loadActiveTasks(): string[] {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

/** 保存进行中任务 id 列表。 */
export function saveActiveTasks(ids: string[]): void {
  try {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(Array.from(new Set(ids))))
  } catch {
    /* ignore */
  }
}

/** 追加一个进行中任务。 */
export function addActiveTask(id: string): void {
  const ids = loadActiveTasks()
  if (!ids.includes(id)) {
    ids.push(id)
    saveActiveTasks(ids)
  }
}

/** 移除一个进行中任务。 */
export function removeActiveTask(id: string): void {
  saveActiveTasks(loadActiveTasks().filter((item) => item !== id))
}

interface IdemRecord {
  key: string
  createdAt: number
}

/** 获取（或创建）某个意图（如 sessionId/prompt 哈希）对应的幂等键，刷新后复用。 */
export function getIdempotencyKey(scope: string): string {
  try {
    const raw = localStorage.getItem(IDEM_KEY)
    const map: Record<string, IdemRecord> = raw ? JSON.parse(raw) : {}
    const existing = map[scope]
    if (existing?.key) return existing.key
    const key = nanoid()
    map[scope] = { key, createdAt: Date.now() }
    localStorage.setItem(IDEM_KEY, JSON.stringify(map))
    return key
  } catch {
    return nanoid()
  }
}

/** 清除某个意图的幂等键（失败/取消后视为新任务）。 */
export function resetIdempotencyKey(scope: string): string {
  try {
    const raw = localStorage.getItem(IDEM_KEY)
    const map: Record<string, IdemRecord> = raw ? JSON.parse(raw) : {}
    const key = nanoid()
    map[scope] = { key, createdAt: Date.now() }
    localStorage.setItem(IDEM_KEY, JSON.stringify(map))
    return key
  } catch {
    return nanoid()
  }
}

/** 生成一个新的幂等键（不落盘，用于一次性请求）。 */
export function newIdempotencyKey(): string {
  return nanoid()
}

/**
 * 已落画布的任务/图片标记必须**按画布隔离**。
 *
 * 之前用全局 key，切到另一个对话（另一张画布）时，同一个任务/URL 会被判定为
 * 「已经放过了」，结果卡在那边永远放不进新画布。投放状态本来就是画布维度的。
 */
function scopedKey(base: string, canvasId?: string | null): string {
  return `${base}:${canvasId || 'default'}`
}

const AUTO_PLACED_KEY = 'cs.autoPlacedTasks'

/** 已落画布的任务 id 集合（按画布隔离）。 */
export function loadPlacedTasks(canvasId?: string | null): string[] {
  try {
    const raw = localStorage.getItem(scopedKey(AUTO_PLACED_KEY, canvasId))
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

/** 判断任务结果是否已落过当前画布。 */
export function isTaskPlaced(id: string, canvasId?: string | null): boolean {
  return loadPlacedTasks(canvasId).includes(id)
}

/** 记录任务结果已落画布（只保留最近 500 条，避免无限增长）。 */
export function markTaskPlaced(id: string, canvasId?: string | null): void {
  if (!id) return
  try {
    const ids = loadPlacedTasks(canvasId)
    if (!ids.includes(id)) {
      ids.push(id)
      localStorage.setItem(scopedKey(AUTO_PLACED_KEY, canvasId), JSON.stringify(ids.slice(-500)))
    }
  } catch {
    /* ignore */
  }
}

const PLACED_URL_KEY = 'cs.placedUrls'

/**
 * 已落画布的图片 URL 集合（按画布隔离）。
 *
 * 投放是「逐张」的，去重必须按 url 而不是任务：一个任务可能产出 1 张整图 + N 张素材，
 * 用任务级标记会导致「点第一张后，剩下几张再也放不进去」。
 */
export function loadPlacedUrls(canvasId?: string | null): string[] {
  try {
    const raw = localStorage.getItem(scopedKey(PLACED_URL_KEY, canvasId))
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

/** 这张图是否已经放进当前画布。 */
export function isUrlPlaced(url: string, canvasId?: string | null): boolean {
  return loadPlacedUrls(canvasId).includes(url)
}

/** 记录一张图已放进画布（保留最近 500 条）。 */
export function markUrlPlaced(url: string, canvasId?: string | null): void {
  if (!url) return
  try {
    const urls = loadPlacedUrls(canvasId)
    if (!urls.includes(url)) {
      urls.push(url)
      localStorage.setItem(scopedKey(PLACED_URL_KEY, canvasId), JSON.stringify(urls.slice(-500)))
    }
  } catch {
    /* ignore */
  }
}

/* -------------------------------------------------------------------------- */
/* 「已完成」提示的去重记录                                                    */
/* -------------------------------------------------------------------------- */

const NOTIFIED_RESULTS_KEY = 'cs.notifiedResults'

/** 任务 id → 已经提示过的结果张数。 */
export type NotifiedResults = Record<string, number>

/**
 * 读取「已完成」提示的去重记录。
 *
 * 为什么必须持久化：这个记录决定"这张图要不要再弹一次提示"，
 * 而组件会随路由进出、切会话而重新挂载——放在 useRef 里一挂载就清空，
 * 用户会看到同一批已完成任务反复弹窗。
 *
 * 为什么存张数而不是布尔：任务重试后可能从 1 张变 2 张，
 * 那是真的"有新结果"，应该再提示一次；张数没变就绝不重复。
 */
export function readNotifiedResults(): NotifiedResults {
  try {
    const raw = localStorage.getItem(NOTIFIED_RESULTS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: NotifiedResults = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

/** 写回去重记录（只保留最近 300 个任务，避免无限增长）。 */
export function writeNotifiedResults(map: NotifiedResults): void {
  try {
    const entries = Object.entries(map).slice(-300)
    localStorage.setItem(NOTIFIED_RESULTS_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    /* ignore */
  }
}
