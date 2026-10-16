import mitt, { type Emitter } from 'mitt'

// 轻量事件总线：用于跨组件通知（未授权、未读结果刷新等）
export type AppEvents = {
  'auth:unauthorized': void
  'quota:changed': void
  'tasks:changed': void
  'announcements:changed': void
}

export const events: Emitter<AppEvents> = mitt<AppEvents>()
