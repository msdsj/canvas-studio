import { toast } from 'sonner'
import { errorMessage, type Translate } from '@/lib/errors'

/**
 * Toast 触发工具（模块级单例）。
 *
 * 必须是同一个引用：代码里有 16 处把 `toast` 写进了 useEffect / useCallback 的
 * 依赖数组，而本模块原先每次调用 useToast() 都返回新对象字面量 →
 * 依赖每渲染必变 → effect 每渲染必重跑。
 *
 * 典型受害点是 `routes/onboarding.tsx:83`：那个 effect 一次并发拉
 * `/onboarding/personas` 与 `/skills/packs` 再 setState，一旦 setState 触发重渲染，
 * 新 toast 对象又让 effect 重跑，于是进入
 * 「渲染 → 两个请求 → setState → 渲染」的无限请求循环。
 * 每次渲染都换引用本身就是 bug，这里改成模块级常量即可根治。
 */
const toastApi = {
  success: (message: string, description?: string) => toast.success(message, { description }),
  error: (message: string, description?: string) => toast.error(message, { description }),
  info: (message: string, description?: string) => toast.info(message, { description }),
  warning: (message: string, description?: string) => toast.warning(message, { description }),
  /** 从任意错误弹出提示 */
  fromError: (error: unknown, t?: Translate) => toast.error(errorMessage(error, t)),
  custom: toast,
}

/** 统一的 Toast 触发工具。返回稳定引用，可安全放进 hook 依赖。 */
export function useToast() {
  return toastApi
}
