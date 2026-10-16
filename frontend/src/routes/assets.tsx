import { useCallback, useEffect, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Upload } from 'lucide-react'
import { AppShell } from '@/components/layout/AppShell'
import { ProtectedRoute } from '@/components/layout/ProtectedRoute'
import { AppSidebar } from '@/components/layout/WorkspaceLeftbar'
import { Button } from '@/components/ui/button'
import { Pagination } from '@/components/ui/pagination'
import { AssetGrid } from '@/components/assets/AssetGrid'
import { AssetPreviewModal } from '@/components/assets/AssetPreviewModal'
import { assetsApi } from '@/lib/api/assets'
import { useToast } from '@/hooks/use-toast'
import { errorMessage } from '@/lib/errors'
import { events } from '@/lib/events'
import type { Asset } from '@/types/models'

export const Route = createFileRoute('/assets')({
  component: AssetsPage,
})

type Filter = 'all' | 'generated' | 'uploaded'

function AssetsPage() {
  const { t } = useTranslation('assets')
  const { t: te } = useTranslation()
  const toast = useToast()
  const [assets, setAssets] = useState<Asset[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(20)
  const [filter, setFilter] = useState<Filter>('all')
  const [loading, setLoading] = useState(true)
  const [preview, setPreview] = useState<Asset | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await assetsApi.list({ page, size, kind: filter === 'all' ? undefined : filter })
      setAssets(result.items)
      setTotal(result.total)
    } catch (error) {
      toast.error(errorMessage(error, te))
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, size, filter])

  useEffect(() => {
    void load()
  }, [load])

  const handleUpload = async (file: File) => {
    try {
      await assetsApi.upload(file)
      toast.success(t('common:status.success', { defaultValue: '上传成功' }))
      events.emit('quota:changed')
      void load()
    } catch (error) {
      toast.error(errorMessage(error, te))
    }
  }

  const handleDelete = async (asset: Asset) => {
    try {
      await assetsApi.remove(asset.id)
      void load()
    } catch (error) {
      toast.error(errorMessage(error, te))
    }
  }

  return (
    <ProtectedRoute>
      <AppShell>
        <div className="flex h-full">
          <AppSidebar />
          <div className="min-h-0 flex-1 overflow-y-auto p-6">
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <h1 className="text-xl font-semibold text-text">{t('title')}</h1>
              <div className="flex items-center gap-3">
                <div className="flex rounded-md bg-bg-subtle p-1">
                  {(['all', 'generated', 'uploaded'] as Filter[]).map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => {
                        setFilter(f)
                        setPage(1)
                      }}
                      className={
                        'rounded-sm px-3 py-1 text-sm transition-colors ' +
                        (filter === f ? 'bg-surface text-text shadow-xs' : 'text-text-secondary')
                      }
                    >
                      {t(`filter.${f}`)}
                    </button>
                  ))}
                </div>
                <Button onClick={() => inputRef.current?.click()}>
                  <Upload size={16} /> {t('upload')}
                </Button>
              </div>
            </div>

            <AssetGrid
              assets={assets}
              loading={loading}
              onPreview={setPreview}
              onDelete={handleDelete}
            />

            <Pagination
              page={page}
              size={size}
              total={total}
              onPageChange={setPage}
              onSizeChange={(s) => {
                setSize(s)
                setPage(1)
              }}
            />
          </div>
        </div>
      </AppShell>

      <AssetPreviewModal asset={preview} onOpenChange={(open) => !open && setPreview(null)} />

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void handleUpload(file)
          e.target.value = ''
        }}
      />
    </ProtectedRoute>
  )
}
