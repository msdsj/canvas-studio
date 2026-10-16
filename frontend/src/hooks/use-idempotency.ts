import {
  getIdempotencyKey,
  newIdempotencyKey,
  resetIdempotencyKey,
} from '@/lib/task-persistence'

/** 幂等键生成/复用（localStorage 持久化，刷新后复用）。 */
export function useIdempotency() {
  return {
    /** 取该意图的幂等键（无则生成并持久化） */
    getKey: getIdempotencyKey,
    /** 失败/取消后重置为新键 */
    resetKey: resetIdempotencyKey,
    /** 生成一次性新键 */
    newKey: newIdempotencyKey,
  }
}
