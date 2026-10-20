import { useEffect, useRef } from 'react'
import { useTeamStore } from '@/stores/team'

/**
 * 切换工作空间（个人 ⇄ 团队）后重新加载当前页面的数据。
 *
 * 为什么需要它：团队空间换的不只是「顶部那个名字」，项目、画布、素材、会话
 * 的可见范围整体换了一套。如果切完不重拉，用户看到的是上一个空间的内容——
 * 更糟的是他会在团队空间里点开一个其实属于个人空间的项目，然后在保存时撞 403。
 *
 * 为什么用事件而不是直接订阅 `activeId`：订阅 `activeId` 会在「首次加载」
 * 时也触发一次，导致每个页面开屏都请求两次。这里只关心「用户主动切换」。
 */
export function useTeamScopeRefresh(reload: () => void): void {
  /** 放进 ref：调用方每次渲染都会传新的闭包，但事件监听不该反复重绑 */
  const reloadRef = useRef(reload)
  reloadRef.current = reload

  useEffect(() => {
    const handler = () => reloadRef.current()
    window.addEventListener('cs:team-changed', handler)
    return () => window.removeEventListener('cs:team-changed', handler)
  }, [])
}

/**
 * 当前工作空间的标识，可直接放进 `useEffect` 依赖。
 *
 * 用法：`useEffect(() => { void load() }, [scopeKey, load])`
 * —— `scopeKey` 变了说明空间切了，必须重拉。
 */
export function useTeamScopeKey(): string {
  return useTeamStore((s) => s.activeId ?? 'personal')
}
