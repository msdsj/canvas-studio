import { Toaster as SonnerToaster } from 'sonner'

/** 全局 Toast 容器（sonner 封装）。 */
export function Toaster() {
  return (
    <SonnerToaster
      position="top-right"
      richColors
      closeButton
      toastOptions={{
        style: {
          background: 'var(--color-surface-raised)',
          color: 'var(--color-text)',
          border: '1px solid var(--color-border)',
          width: '360px',
        },
      }}
    />
  )
}
