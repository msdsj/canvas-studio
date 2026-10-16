import { useTranslation } from 'react-i18next'
import { Download } from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { formatDateTime } from '@/lib/utils'
import { assetsApi } from '@/lib/api/assets'
import type { Asset } from '@/types/models'

interface AssetPreviewModalProps {
  asset: Asset | null
  onOpenChange: (open: boolean) => void
  onUse?: (asset: Asset) => void
}

/** 大图预览 + 元信息。 */
export function AssetPreviewModal({ asset, onOpenChange, onUse }: AssetPreviewModalProps) {
  const { t } = useTranslation('assets')
  return (
    <Modal
      open={Boolean(asset)}
      onOpenChange={onOpenChange}
      size="lg"
      title={t('preview.info')}
      footer={
        asset && (
          <>
            <a href={assetsApi.downloadUrl(asset.id)} download>
              <Button variant="secondary">
                <Download size={15} /> {t('card.download')}
              </Button>
            </a>
            {onUse && <Button onClick={() => onUse(asset)}>{t('card.use')}</Button>}
          </>
        )
      }
    >
      {asset && (
        <div className="grid gap-4 md:grid-cols-[1.5fr_1fr]">
          <img
            src={asset.url}
            alt={asset.source_prompt}
            className="max-h-[60vh] w-full rounded-md border border-border object-contain"
          />
          <dl className="flex flex-col gap-3 text-sm">
            <div>
              <dt className="text-text-tertiary">{t('preview.size')}</dt>
              <dd className="text-text">
                {asset.width}×{asset.height}
              </dd>
            </div>
            <div>
              <dt className="text-text-tertiary">{t('preview.created_at')}</dt>
              <dd className="text-text">{formatDateTime(asset.created_at)}</dd>
            </div>
            {asset.source_prompt && (
              <div>
                <dt className="text-text-tertiary">{t('preview.prompt')}</dt>
                <dd className="whitespace-pre-wrap text-text">{asset.source_prompt}</dd>
              </div>
            )}
          </dl>
        </div>
      )}
    </Modal>
  )
}
