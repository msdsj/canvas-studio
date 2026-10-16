import { useTranslation } from 'react-i18next'
import { ChevronDown, Plus, MessageSquare, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { ChatSession } from '@/types/models'

interface SessionSelectorProps {
  sessions: ChatSession[]
  currentId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
}

/** 会话切换 / 新建 / 删除。 */
export function SessionSelector({ sessions, currentId, onSelect, onCreate, onDelete }: SessionSelectorProps) {
  const { t } = useTranslation('chat')
  const current = sessions.find((s) => s.id === currentId)

  return (
    <div className="flex items-center gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="max-w-[200px] justify-start">
            <MessageSquare size={15} />
            <span className="truncate">{current?.title || t('session.untitled')}</span>
            <ChevronDown size={14} className="text-text-tertiary" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          {sessions.map((session) => (
            <DropdownMenuItem key={session.id} onClick={() => onSelect(session.id)}>
              <span className="truncate">{session.title || t('session.untitled')}</span>
              <button
                type="button"
                aria-label={t('session.delete')}
                className="ml-auto rounded p-0.5 text-text-tertiary hover:text-danger"
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete(session.id)
                }}
              >
                <Trash2 size={13} />
              </button>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="ghost" size="icon-sm" aria-label={t('new_session')} onClick={onCreate}>
        <Plus size={16} />
      </Button>
    </div>
  )
}
