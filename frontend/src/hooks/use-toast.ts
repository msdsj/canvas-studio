import { toast } from 'sonner'
import { errorMessage, type Translate } from '@/lib/errors'

/** 统一的 Toast 触发工具。 */
export function useToast() {
  return {
    success: (message: string, description?: string) => toast.success(message, { description }),
    error: (message: string, description?: string) => toast.error(message, { description }),
    info: (message: string, description?: string) => toast.info(message, { description }),
    warning: (message: string, description?: string) => toast.warning(message, { description }),
    /** 从任意错误弹出提示 */
    fromError: (error: unknown, t?: Translate) => toast.error(errorMessage(error, t)),
    custom: toast,
  }
}
