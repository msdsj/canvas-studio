import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pencil, Archive, Send, Trash2 } from 'lucide-react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Modal } from '@/components/ui/modal'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatDateTime } from '@/lib/utils'
import type { Announcement } from '@/types/models'

interface AnnouncementEditorProps {
  announcements: Announcement[]
  onCreate: (payload: { title: string; content: string; level: 'info' | 'warning' }) => Promise<void> | void
  onUpdate: (id: string, payload: { status?: string; title?: string; content?: string }) => Promise<void> | void
  onDelete: (id: string) => Promise<void> | void
}

/** 公告编辑（新建 / 发布 / 下线）。 */
export function AnnouncementEditor({ announcements, onCreate, onUpdate, onDelete }: AnnouncementEditorProps) {
  const { t } = useTranslation('admin')
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Announcement | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [level, setLevel] = useState<'info' | 'warning'>('info')
  const [saving, setSaving] = useState(false)

  const startCreate = () => {
    setEditing(null)
    setTitle('')
    setContent('')
    setLevel('info')
    setOpen(true)
  }
  const startEdit = (a: Announcement) => {
    setEditing(a)
    setTitle(a.title)
    setContent(a.content)
    setLevel(a.level)
    setOpen(true)
  }

  const save = async () => {
    setSaving(true)
    try {
      if (editing) await onUpdate(editing.id, { title, content })
      else await onCreate({ title, content, level })
      setOpen(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button onClick={startCreate}>{t('announcements.create')}</Button>
      </div>

      {announcements.length === 0 ? (
        <EmptyState title={t('announcements.empty')} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('announcements.title_field')}</TableHead>
              <TableHead>{t('announcements.level')}</TableHead>
              <TableHead>{t('announcements.status')}</TableHead>
              <TableHead>{t('logs.time')}</TableHead>
              <TableHead className="text-right">{t('users.actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {announcements.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="max-w-[280px] truncate">{a.title}</TableCell>
                <TableCell>
                  <Badge variant={a.level === 'warning' ? 'warning' : 'soft'}>
                    {a.level === 'warning' ? t('announcements.level_warning') : t('announcements.level_info')}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge variant={a.status === 'published' ? 'success' : 'soft'} dot>
                    {a.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-text-secondary">{formatDateTime(a.published_at)}</TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    <Button size="icon-sm" variant="ghost" aria-label={t('announcements.edit')} onClick={() => startEdit(a)}>
                      <Pencil size={15} />
                    </Button>
                    {a.status === 'published' ? (
                      <Button size="icon-sm" variant="ghost" aria-label={t('announcements.archive')} onClick={() => onUpdate(a.id, { status: 'archived' })}>
                        <Archive size={15} />
                      </Button>
                    ) : (
                      <Button size="icon-sm" variant="ghost" aria-label={t('announcements.publish')} onClick={() => onUpdate(a.id, { status: 'published' })}>
                        <Send size={15} />
                      </Button>
                    )}
                    <Button size="icon-sm" variant="ghost" aria-label="delete" onClick={() => onDelete(a.id)}>
                      <Trash2 size={15} />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Modal
        open={open}
        onOpenChange={setOpen}
        title={editing ? t('announcements.edit') : t('announcements.create')}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('common:cancel', { defaultValue: '取消' })}
            </Button>
            <Button loading={saving} disabled={!title.trim()} onClick={save}>
              {t('common:action.save', { defaultValue: '保存' })}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <FormField label={t('announcements.title_field')} required>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </FormField>
          <FormField label={t('announcements.level')}>
            <Select value={level} onValueChange={(v) => setLevel(v as 'info' | 'warning')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="info">{t('announcements.level_info')}</SelectItem>
                <SelectItem value="warning">{t('announcements.level_warning')}</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
          <FormField label={t('announcements.content')}>
            <Textarea rows={5} value={content} onChange={(e) => setContent(e.target.value)} />
          </FormField>
        </div>
      </Modal>
    </div>
  )
}
