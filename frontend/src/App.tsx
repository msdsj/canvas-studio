import { useEffect } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/toast'
import { router } from '@/router'
import { useAuthStore } from '@/stores/auth'
import { installMotionProfile } from '@/lib/motion'
import { installMotionDelegation } from '@/lib/motion-delegation'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 15_000,
    },
  },
})

/** 应用壳：Provider 树 + 路由 + Toast。 */
export function App() {
  const init = useAuthStore((s) => s.init)

  useEffect(() => {
    void init()
  }, [init])

  // 动效能力探测只做一次：决定是否关闭氛围动画（低性能设备 / 减弱动效）
  useEffect(() => installMotionProfile(), [])

  // 声明式微交互（按压 / 微抬 / 行高光 / 分段滑块）：全站只装一次监听，
  // 组件用 data-motion="press" 之类的属性声明即可，不必各自写 useEffect。
  // 返回的清理函数走同一个 AbortController，StrictMode 双挂载不会叠两份。
  // 注意不能写成 `useEffect(() => stopDelegation, [...])`：
  // useMemo 只创建一次，StrictMode 的「setup → cleanup → setup」会拿到**同一个**
  // stop 函数，第一次 cleanup 已把它用掉（abort 掉 controller），第二次 setup
  // 拿到的是失效的清理器 —— 监听就再也没装回来。必须每次重新安装。
  useEffect(() => installMotionDelegation(), [])

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200}>
        <RouterProvider router={router} />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  )
}
