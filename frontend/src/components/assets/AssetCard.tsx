import { useTranslation } from 'react-i18next'
import { Download, ImagePlus, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { Asset } from '@/types/models'
import { assetsApi } from '@/lib/api/assets'

interface AssetCardProps {
  asset: Asset
  onUse?: (asset: Asset) => void
  onDelete?: (asset: Asset) => void
  onPreview?: (asset: Asset) => void
}

/** 资产卡（复用回画布 / 下载 / 删除）。 */
export function AssetCard({ asset, onUse, onDelete, onPreview }: AssetCardProps) {
  const { t } = useTranslation('assets')
  return (
    <div className="group overflow-hidden rounded-md bg-surface shadow-sheet">
      {/* 图片区 = 相纸：3px 近直角 + 白色衬边，与 UI 的 14px 软角形成「硬边图 / 软边界面」对比 */}
      <button
        type="button"
        onClick={() => onPreview?.(asset)}
        className="relative block aspect-square w-full overflow-hidden bg-mat p-[3px]"
      >
        <img
          src={asset.thumb_url || asset.url}
          alt={asset.source_prompt || asset.kind}
          loading="lazy"
          className="h-full w-full rounded-[3px] object-cover transition-transform duration-200 group-hover:scale-[1.03]"
        />
        {asset.is_demo && (
          <span className="absolute left-2 top-2">
            <Badge variant="warning">{t('card.demo_badge')}</Badge>
          </span>
        )}
      </button>
      <div className="flex items-center justify-between gap-1 px-2 py-2">
        <span className="truncate text-caption text-text-tertiary">
          {asset.width}×{asset.height}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label={t('card.use')}
            className="rounded p-1.5 text-text-secondary hover:bg-surface-hover"
            onClick={() => onUse?.(asset)}
          >
            <ImagePlus size={15} />
          </button>
          <a
            href={assetsApi.downloadUrl(asset.id)}
            download
            aria-label={t('card.download')}
            className="rounded p-1.5 text-text-secondary hover:bg-surface-hover"
          >
            <Download size={15} />
          </a>
          <button
            type="button"
            aria-label={t('card.delete')}
            className="rounded p-1.5 text-text-secondary hover:bg-surface-hover hover:text-danger"
            onClick={() => onDelete?.(asset)}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>
    </div>
  )
}
