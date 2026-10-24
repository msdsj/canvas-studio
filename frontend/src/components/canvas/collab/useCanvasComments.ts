import { useCallback, useEffect, useState } from 'react'
import { canvasesApi, type CanvasComment } from '@/lib/api/canvases'

/**
 * 画布评论的数据源。
 *
 * 评论量级远小于画布元素（几十条），所以一次全量拉取 + 本地增删改，
 * 不做分页也不做 WebSocket：刷新/切回标签页时重新拉一次就足够新。
 */
export function useCanvasComments(canvasId?: string) {
  const [items, setItems] = useState<CanvasComment[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!canvasId) return
    setLoading(true)
    try {
      const data = await canvasesApi.listComments(canvasId)
      setItems(data.items)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载评论失败')
    } finally {
      setLoading(false)
    }
  }, [canvasId])

  useEffect(() => {
    void load()
  }, [load])

  const add = useCallback(
    async (payload: {
      content: string
      x: number
      y: number
      element_id?: string | null
      parent_id?: string | null
      mentions?: string[]
    }) => {
      if (!canvasId) return null
      const created = await canvasesApi.createComment(canvasId, payload)
      setItems((prev) => [...prev, created])
      return created
    },
    [canvasId]
  )

  const resolve = useCallback(async (id: string, resolved: boolean) => {
    const updated = await canvasesApi.updateComment(id, { resolved })
    setItems((prev) => prev.map((item) => (item.id === id ? updated : item)))
  }, [])

  const remove = useCallback(async (id: string) => {
    await canvasesApi.deleteComment(id)
    setItems((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const unresolved = items.filter((item) => !item.resolved).length

  return { items, loading, error, unresolved, load, add, resolve, remove }
}
