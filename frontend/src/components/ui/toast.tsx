import { useEffect } from 'react'
import { Toaster as SonnerToaster } from 'sonner'
import { popIcon } from '@/lib/motion-delegation'

/**
 * 全局 Toast 容器（sonner 封装）。
 *
 * 位置约束：不得压住身份条（左下）与画布工具条（底部居中），
 * 所以落在**左上**，让出 268px 左栏；移动端收到顶部通栏内。
 *
 * 视觉采用「纸卡片」语言：
 * - 卡面纯白 / 暗色为抬升面，圆角 14px，1px 细边 + 柔和投影（不用重阴影）
 * - 左侧一条 3px 语义色竖条（成功=青柠、错误=红、警告=琥珀、信息=墨）
 *   比整块彩色底更克制，也避免和品牌色打架
 * - 图标放进 26px 的圆形色底，和标题基线对齐
 * - 关闭按钮常驻但极轻（hover 才显形），不抢视线
 *
 * 动画由 sonner 自带（滑入 + 缩放 + 堆叠下沉），这里只统一时长与曲线，
 * 与全站三档节奏（160/240/420ms）保持一致。
 *
 * 图标单独再弹一次（GSAP `csSnap`）：整卡滑入时图标如果跟着平移，
 * 读起来是"一张卡片进来了"；图标自己带一点点过冲弹出，才是"结果落定"。
 * 用 MutationObserver 而不是改 sonner 的渲染：sonner 的 DOM 由它自己管，
 * 从外部只能"观察"，不能"接管"。
 */
export function Toaster() {
  useEffect(() => {
    let raf = 0
    const seen = new WeakSet<Element>()
    const scan = () => {
      raf = 0
      // sonner 给每张卡片挂 data-sonner-toast（旧选择器 [data-cs-toast] 没有任何元素带，图标弹出从未生效）
      document.querySelectorAll<HTMLElement>('[data-sonner-toast] .cs-toast-icon').forEach((icon) => {
        if (seen.has(icon)) return
        seen.add(icon)
        popIcon(icon)
      })
    }
    const schedule = () => {
      if (raf) return
      // sonner 会先建节点再插进 DOM，等一帧确保节点已经挂好、能算到最终尺寸
      raf = requestAnimationFrame(scan)
    }
    /*
     * 观察范围仍是 body（sonner 的容器只在有 toast 时才挂载，无法提前拿到），
     * 但只有「新增节点落在 toast 容器里」才排一次扫描：
     * 画布、流式对话每帧都在改 DOM，若每批变更都做一次全文档 querySelectorAll，
     * 空闲时主线程也停不下来。
     */
    const inToaster = (node: Node | null) =>
      node instanceof Element && Boolean(node.closest('[data-sonner-toaster]'))
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.addedNodes.length === 0) continue
        if (inToaster(record.target)) return schedule()
        for (const node of record.addedNodes) {
          if (
            node instanceof Element &&
            (inToaster(node) || node.querySelector('[data-sonner-toaster]') !== null)
          ) {
            return schedule()
          }
        }
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    schedule()
    return () => {
      observer.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  return (
    <SonnerToaster
      position="top-left"
      closeButton
      visibleToasts={3}
      gap={10}
      // 宽度由 CSS 的 `--width` 控制（sonner 的 width prop 在 2.x 会与 CSS 冲突），
      // 见 styles/toast.css 顶部的 [data-sonner-toaster] 规则。
      offset={{ top: 20, left: 20 }}
      mobileOffset={{ top: 12, left: 12, right: 12 }}
      swipeDirections={['left', 'right']}
      toastOptions={{
        duration: 3800,
        unstyled: false,
        classNames: {
          toast: 'cs-toast',
          title: 'cs-toast-title',
          description: 'cs-toast-desc',
          icon: 'cs-toast-icon',
          closeButton: 'cs-toast-close',
          success: 'cs-toast--success',
          error: 'cs-toast--error',
          warning: 'cs-toast--warning',
          info: 'cs-toast--info',
          loading: 'cs-toast--loading',
          actionButton: 'cs-toast-action',
          cancelButton: 'cs-toast-cancel',
        },
      }}
    />
  )
}
