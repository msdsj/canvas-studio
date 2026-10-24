import { useCallback, useEffect, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Upload } from 'lucide-react'
import { AppShell } from '@/components/layout/AppShell'
import { ProtectedRoute } from '@/components/layout/ProtectedRoute'
import { PageShell, PageTabs } from '@/components/layout/PageShell'
import { Button } from '@/components/ui/button'
import { Pagination } from '@/components/ui/pagination'
import { AssetGrid } from '@/components/assets/AssetGrid'
import { AssetPreviewModal } from '@/components/assets/AssetPreviewModal'
import { assetsApi } from '@/lib/api/assets'
import { useAuth } from '@/hooks/use-auth'
import { useTeamScopeKey } from '@/hooks/use-team-scope'
import { useToast } from '@/hooks/use-toast'
import { errorMessage } from '@/lib/errors'
import { events } from '@/lib/events'
import type { Asset } from '@/types/models'

export const Route = createFileRoute('/assets')({
  component: AssetsPage,
})

type Filter = 'all' | 'generated' | 'uploaded'
/** 归属范围：团队里才有意义，个人空间下不显示 */
type Scope = 'all' | 'mine' | 'team'

function AssetsPage() {
  const { t } = useTranslation('assets')
  const { t: te } = useTranslation()
  const { inTeamSpace } = useAuth()
  const toast = useToast()
  const [assets, setAssets] = useState<Asset[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(20)
  const [filter, setFilter] = useState<Filter>('all')
  const [scope, setScope] = useState<Scope>('all')
  const [loading, setLoading] = useState(true)
  const [preview, setPreview] = useState<Asset | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await assetsApi.list({
        page,
        size,
        kind: filter === 'all' ? undefined : filter,
        scope,
      })
      setAssets(result.items)
      setTotal(result.total)
    } catch (error) {
      toast.error(errorMessage(error, te))
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, size, filter, scope])

  // 切工作空间后重拉：两套素材的可见范围不同
  const scopeKey = useTeamScopeKey()
  useEffect(() => {
    void load()
  }, [load, scopeKey])

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
          <PageShell
            title={t('title')}
            description={t('subtitle')}
            tabs={
              <div className="flex flex-wrap items-center justify-between gap-3">
                <PageTabs
                  items={[
                    { key: 'all', label: t('filter.all') },
                    { key: 'generated', label: t('filter.generated') },
                    { key: 'uploaded', label: t('filter.uploaded') },
                  ]}
                  value={filter}
                  onChange={(key) => {
                    setFilter(key as Filter)
                    setPage(1)
                  }}
                />
                {/* 团队空间才需要区分「我的 / 团队共享」：个人空间里两者是同一批 */}
                {inTeamSpace && (
                  <div className="flex rounded-full bg-bg-subtle p-1">
                    {(['all', 'mine', 'team'] as Scope[]).map((value) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => {
                          setScope(value)
                          setPage(1)
                        }}
                        className={
                          scope === value
                            ? 'rounded-full bg-surface px-3 py-1 text-caption font-medium text-text shadow-xs'
                            : 'rounded-full px-3 py-1 text-caption text-text-tertiary transition-colors hover:text-text-secondary'
                        }
                      >
                        {t(`scope.${value}`)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            }
            actions={
              <Button onClick={() => inputRef.current?.click()}>
                <Upload size={16} /> {t('upload')}
              </Button>
            }
          >

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
          </PageShell>
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
