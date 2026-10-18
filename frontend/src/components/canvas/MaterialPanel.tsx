import { useCallback, useEffect, useMemo, useState } from 'react'
import { ImagePlus, Images, Loader2, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { assetsApi } from '@/lib/api/assets'
import { useToast } from '@/hooks/use-toast'
import type { Asset } from '@/types/models'

type MaterialKind = 'all' | 'uploaded' | 'generated'

const TABS: Array<{ id: MaterialKind; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'uploaded', label: '上传' },
  { id: 'generated', label: '生成' },
]

interface MaterialPanelProps {
  /** 点击素材 → 放进画布 */
  onUse: (asset: Asset) => void
  onUpload: () => void
  /** 外部触发刷新（新资产入库时递增） */
  refreshKey?: number
}

/**
 * 「我的素材」面板（对照 lovart 设计稿的中栏）。
 *
 * 数据直接来自资产库，不另造一套「品牌套件/角色/产品」的空壳分类——
 * 等真有那类数据时再加标签即可。
 *
 * 面板与相邻栏靠背景明度差分层（bg-subtle vs surface），不用 1px 竖线分割；
 * 缩略图统一「相纸」处理：3px 近直角 + 白色衬边 + 浮起阴影。
 */
export function MaterialPanel({ onUse, onUpload, refreshKey = 0 }: MaterialPanelProps) {
  const [kind, setKind] = useState<MaterialKind>('all')
  const [assets, setAssets] = useState<Asset[]>([])
  const [loading, setLoading] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const toast = useToast()

  /** 删除素材：先从列表移除（即时反馈），失败再提示并重新拉取。 */
  const handleDelete = async (asset: Asset) => {
    if (!window.confirm('删除这张素材？删除后不可恢复。')) return
    setDeletingId(asset.id)
    try {
      await assetsApi.remove(asset.id)
      setAssets((prev) => prev.filter((item) => item.id !== asset.id))
      toast.success('已删除素材')
    } catch {
      toast.error('删除失败，稍后再试')
      void load()
    } finally {
      setDeletingId(null)
    }
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const page = await assetsApi.list({
        page: 1,
        size: 40,
        kind: kind === 'all' ? undefined : kind,
      })
      setAssets(page.items ?? [])
    } catch {
      /* 拉取失败保留上次结果，不打断创作 */
    } finally {
      setLoading(false)
    }
  }, [kind])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  /**
   * 演示占位资产（Pillow 生成的「白块 + 红块 + 一行提示词」）一律不展示：
   * 它们混在真实素材里会让整个面板看起来像加载失败。
   */
  const visibleAssets = useMemo(() => assets.filter((asset) => !asset.is_demo), [assets])

  return (
    <aside className="hidden w-[208px] shrink-0 flex-col overflow-hidden rounded-[14px] bg-surface shadow-sheet lg:flex">
      <div className="flex shrink-0 items-center gap-2 px-3 pb-1.5 pt-3">
        <Images size={14} className="text-text-tertiary" />
        <span className="text-ui font-semibold text-text-secondary">我的素材</span>
        {loading && <Loader2 size={13} className="ml-auto animate-spin text-text-tertiary" />}
      </div>

      <div className="flex shrink-0 gap-1 px-2 pb-2">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setKind(tab.id)}
            className={cn(
              'rounded-[10px] px-2.5 py-1 text-ui transition-colors',
              kind === tab.id
                ? 'bg-brand-subtle text-brand-text'
                : 'text-text-tertiary hover:bg-surface-hover hover:text-text'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {visibleAssets.length === 0 && !loading ? (
          <button
            type="button"
            onClick={onUpload}
            className="mt-2 flex w-full flex-col items-center gap-2 rounded-md bg-surface px-3 py-8 text-text-tertiary shadow-sheet transition-colors hover:text-brand-text"
          >
            <ImagePlus size={22} />
            <span className="text-ui">
              {assets.length > 0 ? '暂无可用素材' : '还没有素材'}
            </span>
            <span className="text-caption text-text-tertiary">上传第一张参考图</span>
          </button>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {visibleAssets.map((asset) => (
              <div
                key={asset.id}
                className="group relative overflow-hidden rounded-[3px] bg-mat p-[3px] shadow-sheet transition-shadow duration-150 hover:shadow-lift"
              >
                <button
                  type="button"
                  onClick={() => onUse(asset)}
                  title={asset.prompt || asset.filename || '加入画布'}
                  className="block w-full"
                >
                  <img
                    src={asset.url}
                    alt={asset.filename || ''}
                    className="block aspect-square w-full rounded-[3px] object-cover"
                    loading="lazy"
                  />
                </button>
                {/* 右下角删除角标：悬停出现，避免误触 */}
                <button
                  type="button"
                  aria-label="删除素材"
                  title="删除素材"
                  disabled={deletingId === asset.id}
                  onClick={(event) => {
                    event.stopPropagation()
                    void handleDelete(asset)
                  }}
                  className="absolute bottom-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-[rgba(12,14,24,0.62)] text-white opacity-0 backdrop-blur transition-opacity duration-150 hover:bg-danger focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-50"
                >
                  {deletingId === asset.id ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Trash2 size={12} />
                  )}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0 px-2 pb-3">
        <button
          type="button"
          onClick={onUpload}
          className="flex w-full items-center justify-center gap-1.5 rounded-[10px] bg-surface py-2 text-ui text-text-secondary shadow-sheet transition-colors hover:text-brand-text"
        >
          <ImagePlus size={14} /> 上传素材
        </button>
      </div>
    </aside>
  )
}
