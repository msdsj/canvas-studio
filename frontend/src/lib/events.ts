import mitt, { type Emitter } from 'mitt'
import type { RegionSelection } from '@/types/models'

// 轻量事件总线：用于跨组件通知（未授权、未读结果刷新等）
export type AppEvents = {
  'auth:unauthorized': void
  'quota:changed': void
  'tasks:changed': void
  'announcements:changed': void
  /** 画布端框选完成的编辑目标（底图 + 高亮标记图 + 归一化选区） */
  'edit:target': RegionSelection
  /** 编辑任务已从对话框发出（画布端可退出框选模式） */
  'edit:target.clear': void
  /** 从生成结果卡直接打开编辑画布（免下载上传） */
  'edit:open': { url: string }
}

export const events: Emitter<AppEvents> = mitt<AppEvents>()
