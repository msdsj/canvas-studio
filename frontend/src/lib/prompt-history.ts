export interface PromptGenerationParams {
  model: string
  aspect: string
  quality: 'standard' | 'hd'
  negative_prompt: string
  sampler?: string
  steps?: number
  cfg_scale?: number
  seed?: number
}

export interface PromptHistoryEntry {
  id: string
  created_at: string
  user_prompt: string
  final_prompt?: string
  negative_prompt: string
  system_negative?: string
  params: PromptGenerationParams
}

const KEY_PREFIX = 'cs.promptHistory.v1.'
const LIMIT = 40
export const PROMPT_HISTORY_EVENT = 'cs:prompt-history-change'

function storageKey(userId: string) {
  return `${KEY_PREFIX}${userId || 'anonymous'}`
}

export function readPromptHistory(userId: string): PromptHistoryEntry[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey(userId)) || '[]')
    return Array.isArray(value) ? (value as PromptHistoryEntry[]).slice(0, LIMIT) : []
  } catch {
    return []
  }
}

function writePromptHistory(userId: string, entries: PromptHistoryEntry[]) {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(entries.slice(0, LIMIT)))
    window.dispatchEvent(new CustomEvent(PROMPT_HISTORY_EVENT, { detail: { userId } }))
  } catch {
    // Storage may be unavailable or full; the active prompt remains in the composer.
  }
}

export function addPromptHistory(
  userId: string,
  userPrompt: string,
  params: PromptGenerationParams
): string {
  const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const entries = readPromptHistory(userId)
  entries.unshift({
    id,
    created_at: new Date().toISOString(),
    user_prompt: userPrompt,
    negative_prompt: params.negative_prompt,
    params: { ...params },
  })
  writePromptHistory(userId, entries)
  return id
}

export function updatePromptHistory(
  userId: string,
  id: string,
  patch: Partial<Pick<PromptHistoryEntry, 'final_prompt' | 'negative_prompt' | 'system_negative'>> & {
    params?: Partial<PromptGenerationParams>
  }
) {
  const entries = readPromptHistory(userId).map((entry) =>
    entry.id === id
      ? {
          ...entry,
          ...patch,
          params: { ...entry.params, ...patch.params },
        }
      : entry
  )
  writePromptHistory(userId, entries)
}

export function clearPromptHistory(userId: string) {
  writePromptHistory(userId, [])
}
