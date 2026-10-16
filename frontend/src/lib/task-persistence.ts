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

const AUTO_PLACED_KEY = 'cs.autoPlacedTasks'

/** 已落画布的任务 id 集合（自动补投递/手动加入共用，防止重复添加）。 */
export function loadPlacedTasks(): string[] {
  try {
    const raw = localStorage.getItem(AUTO_PLACED_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

/** 判断任务结果是否已落过画布。 */
export function isTaskPlaced(id: string): boolean {
  return loadPlacedTasks().includes(id)
}

/** 记录任务结果已落画布（只保留最近 500 条，避免无限增长）。 */
export function markTaskPlaced(id: string): void {
  if (!id) return
  try {
    const ids = loadPlacedTasks()
    if (!ids.includes(id)) {
      ids.push(id)
      localStorage.setItem(AUTO_PLACED_KEY, JSON.stringify(ids.slice(-500)))
    }
  } catch {
    /* ignore */
  }
}
