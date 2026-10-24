import { Image as ImageIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { AssetCard } from './AssetCard'
import type { Asset } from '@/types/models'

interface AssetGridProps {
  assets: Asset[]
  loading?: boolean
  onUse?: (asset: Asset) => void
  onDelete?: (asset: Asset) => void
  onPreview?: (asset: Asset) => void
}

/**
 * 资产网格（时间倒序）。
 *
 * 用 CSS `columns` 做瀑布流：每张卡按自己的真实宽高比占位，
 * 竖图不会被裁、横图不会被拉扁，列高自动错落。
 * （改造前是 5 列固定网格 + 全部切方，竖图只剩中间一条。）
 */
export function AssetGrid({ assets, loading, onUse, onDelete, onPreview }: AssetGridProps) {
  const { t } = useTranslation('assets')

  if (loading) {
    return (
      <div className="columns-2 gap-4 sm:columns-3 lg:columns-4 2xl:columns-5">
        {Array.from({ length: 10 }).map((_, i) => (
          <Skeleton key={i} className="mb-4 aspect-square w-full break-inside-avoid rounded-[16px]" />
        ))}
      </div>
    )
  }

  if (assets.length === 0) {
    return (
      <EmptyState
        icon={ImageIcon}
        title={t('empty.title')}
        description={t('empty.desc')}
        hints={[t('empty.hint_1'), t('empty.hint_2')]}
      />
    )
  }

  return (
    <div className="columns-2 gap-4 sm:columns-3 lg:columns-4 2xl:columns-5">
      {assets.map((asset) => (
        <AssetCard key={asset.id} asset={asset} onUse={onUse} onDelete={onDelete} onPreview={onPreview} />
      ))}
    </div>
  )
}
