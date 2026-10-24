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

/**
 * 资产的宽高比。
 *
 * 极端比例（超长图、细长条）如果原样呈现，卡片会变成一条 2px 的缝，
 * 网格看起来全是空白。所以把比例夹在 1:2 ~ 2:1 之间。
 */
function ratioOf(asset: Asset): string {
  const w = asset.width || 1
  const h = asset.height || 1
  const ratio = w / h
  const clamped = Math.min(2, Math.max(0.5, ratio))
  return `${clamped} / 1`
}

/**
 * 资产卡（预览 / 复用回画布 / 下载 / 删除）。
 *
 * v3 改动：
 * - 图片区按**素材真实宽高比**排版，不再一律切方。改造前 351×1238 的竖图
 *   被 `object-cover` 裁成正方形，只剩中间一条，用户根本认不出那是哪张图；
 * - 底部元信息重排：尺寸在左、三个操作在右，图标统一 16px、间距 8px、垂直居中
 *   （原来 15px 图标挤在 2px 间隙里，基线还各偏各的）。
 */
export function AssetCard({ asset, onUse, onDelete, onPreview }: AssetCardProps) {
  const { t } = useTranslation('assets')
  return (
    <div className="group mb-4 break-inside-avoid overflow-hidden rounded-[16px] border border-border/70 bg-surface shadow-sheet transition-[transform,box-shadow] duration-[240ms] ease-[var(--ease-out)] hover:-translate-y-0.5 hover:shadow-lift">
      {/* 图片区 = 相纸：3px 近直角 + 白色衬边，与 UI 的 16px 软角形成「硬边图 / 软边界面」对比 */}
      <button
        type="button"
        onClick={() => onPreview?.(asset)}
        className="relative block w-full overflow-hidden bg-mat p-[3px]"
        style={{ aspectRatio: ratioOf(asset) }}
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
      <div className="flex items-center justify-between gap-2 px-3 py-2.5">
        <span className="truncate font-mono text-micro tabular-nums text-text-tertiary">
          {asset.width}×{asset.height}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label={t('card.use')}
            className="flex h-7 w-7 items-center justify-center rounded-[8px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
            onClick={() => onUse?.(asset)}
          >
            <ImagePlus size={16} />
          </button>
          <a
            href={assetsApi.downloadUrl(asset.id)}
            download
            aria-label={t('card.download')}
            className="flex h-7 w-7 items-center justify-center rounded-[8px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
          >
            <Download size={16} />
          </a>
          <button
            type="button"
            aria-label={t('card.delete')}
            className="flex h-7 w-7 items-center justify-center rounded-[8px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-danger"
            onClick={() => onDelete?.(asset)}
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}
