import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'

/**
 * AI 文本 Markdown 渲染。
 *
 * `size="ui"`：气泡内的紧凑排版（14px / 1.7），对话里用；
 * 默认 body（15px）给分享页、长文这类阅读场景。
 */
export function Markdown({
  content,
  className,
  size = 'body',
}: {
  content: string
  className?: string
  size?: 'body' | 'ui'
}) {
  return (
    <div
      className={cn(
        'min-w-0 text-text [overflow-wrap:anywhere]',
        size === 'ui' ? 'text-ui leading-[1.7]' : 'text-body leading-[1.72]',
        '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        '[&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5',
        '[&_li]:my-1 [&_li]:pl-0.5 [&_li::marker]:text-text-tertiary [&_strong]:font-semibold [&_strong]:text-text',
        '[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border-faint [&_blockquote]:pl-3 [&_blockquote]:text-text-secondary',
        '[&_code]:rounded-[5px] [&_code]:bg-bg-subtle [&_code]:px-1.5 [&_code]:py-px [&_code]:font-mono [&_code]:text-[0.9em] [&_code]:text-text [&_code]:ring-1 [&_code]:ring-inset [&_code]:ring-border-faint',
        '[&_pre]:my-2.5 [&_pre]:overflow-x-auto [&_pre]:rounded-sm [&_pre]:bg-bg-subtle [&_pre]:p-3 [&_pre]:text-caption',
        '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:ring-0',
        '[&_a]:text-brand [&_a]:underline [&_a]:underline-offset-2',
        '[&_h1]:my-2 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:my-2 [&_h2]:text-md [&_h2]:font-semibold [&_h3]:my-1.5 [&_h3]:font-semibold',
        '[&_hr]:my-3 [&_hr]:border-border-faint',
        '[&_img]:max-w-full [&_img]:rounded-sm',
        className
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  )
}
