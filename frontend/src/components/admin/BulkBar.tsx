import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'

export interface BulkAction {
  label: string
  onClick: () => void
  /** 危险操作（删除、封禁）用红色文字，避免误点 */
  danger?: boolean
  disabled?: boolean
}

interface BulkBarProps {
  count: number
  actions: BulkAction[]
  onClear: () => void
}

/**
 * 多选操作条：勾选任意行后出现在表格上方。
 *
 * 没选中时整条不渲染（占位为零），不会把表格往下推一格。
 */
export function BulkBar({ count, actions, onClear }: BulkBarProps) {
  const { t } = useTranslation('admin')
  if (count === 0) return null

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-[12px] bg-brand-subtle px-3 py-2 ring-1 ring-inset ring-brand/15">
      <span className="mr-1 text-caption font-medium text-brand-text">
        {t('bulk.selected', { count })}
      </span>
      {actions.map((action) => (
        <Button
          key={action.label}
          size="sm"
          variant={action.danger ? 'ghost' : 'secondary'}
          disabled={action.disabled}
          onClick={action.onClick}
          className={action.danger ? 'text-danger hover:text-danger' : undefined}
        >
          {action.label}
        </Button>
      ))}
      <Button size="sm" variant="ghost" className="ml-auto" onClick={onClear}>
        <X size={14} />
        {t('bulk.clear')}
      </Button>
    </div>
  )
}
