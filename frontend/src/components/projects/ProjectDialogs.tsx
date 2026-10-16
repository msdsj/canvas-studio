import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal, ConfirmModal } from '@/components/ui/modal'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import type { CanvasProject } from '@/types/models'

interface CreateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (name: string, description: string) => Promise<void> | void
}

/** 新建项目弹窗。 */
export function CreateProjectDialog({ open, onOpenChange, onSubmit }: CreateDialogProps) {
  const { t } = useTranslation('projects')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async () => {
    if (!name.trim()) return
    setLoading(true)
    try {
      await onSubmit(name.trim(), description.trim())
      setName('')
      setDescription('')
      onOpenChange(false)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('create_dialog.title')}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('common:cancel', { defaultValue: '取消' })}
          </Button>
          <Button loading={loading} disabled={!name.trim()} onClick={submit}>
            {t('create')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormField label={t('create_dialog.name')} required htmlFor="project-name">
          <Input
            id="project-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('create_dialog.placeholder')}
          />
        </FormField>
        <FormField label={t('create_dialog.description')} htmlFor="project-desc">
          <Textarea id="project-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </FormField>
      </div>
    </Modal>
  )
}

interface RenameDialogProps {
  project: CanvasProject | null
  onOpenChange: (open: boolean) => void
  onSubmit: (name: string) => Promise<void> | void
}

/** 重命名项目弹窗。 */
export function RenameProjectDialog({ project, onOpenChange, onSubmit }: RenameDialogProps) {
  const { t } = useTranslation('projects')
  const [name, setName] = useState(project?.name ?? '')
  const [loading, setLoading] = useState(false)

  if (project && name === '' && project.name) setName(project.name)

  return (
    <Modal
      open={Boolean(project)}
      onOpenChange={onOpenChange}
      title={t('rename_dialog.title')}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('common:cancel', { defaultValue: '取消' })}
          </Button>
          <Button
            loading={loading}
            disabled={!name.trim()}
            onClick={async () => {
              setLoading(true)
              try {
                await onSubmit(name.trim())
                onOpenChange(false)
              } finally {
                setLoading(false)
              }
            }}
          >
            {t('common:action.save', { defaultValue: '保存' })}
          </Button>
        </>
      }
    >
      <FormField label={t('rename_dialog.name')} htmlFor="rename-name">
        <Input id="rename-name" value={name} onChange={(e) => setName(e.target.value)} />
      </FormField>
    </Modal>
  )
}

interface DeleteDialogProps {
  project: CanvasProject | null
  onOpenChange: (open: boolean) => void
  onConfirm: () => Promise<void> | void
}

/** 删除项目确认。 */
export function DeleteProjectDialog({ project, onOpenChange, onConfirm }: DeleteDialogProps) {
  const { t } = useTranslation('projects')
  const [loading, setLoading] = useState(false)
  return (
    <ConfirmModal
      open={Boolean(project)}
      onOpenChange={onOpenChange}
      title={t('delete_confirm')}
      description={project?.name}
      danger
      loading={loading}
      confirmLabel={t('common:action.delete', { defaultValue: '删除' })}
      onConfirm={async () => {
        setLoading(true)
        try {
          await onConfirm()
          onOpenChange(false)
        } finally {
          setLoading(false)
        }
      }}
    />
  )
}
