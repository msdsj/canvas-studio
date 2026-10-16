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

/** 资产网格（时间倒序）。 */
export function AssetGrid({ assets, loading, onUse, onDelete, onPreview }: AssetGridProps) {
  const { t } = useTranslation('assets')

  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="aspect-square w-full" />
        ))}
      </div>
    )
  }

  if (assets.length === 0) {
    return <EmptyState icon={ImageIcon} title={t('empty.title')} description={t('empty.desc')} />
  }

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {assets.map((asset) => (
        <AssetCard key={asset.id} asset={asset} onUse={onUse} onDelete={onDelete} onPreview={onPreview} />
      ))}
    </div>
  )
}
