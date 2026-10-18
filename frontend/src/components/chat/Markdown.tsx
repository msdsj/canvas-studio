import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'

/** AI 文本 Markdown 渲染。 */
export function Markdown({ content, className }: { content: string; className?: string }) {
  return (
    <div
      className={cn(
        'min-w-0 text-body leading-[1.72] text-text [overflow-wrap:anywhere]',
        '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        '[&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5',
        '[&_li]:my-0.5 [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-text-secondary',
        '[&_code]:rounded-[4px] [&_code]:bg-bg-subtle [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[13px]',
        '[&_pre]:my-2.5 [&_pre]:overflow-x-auto [&_pre]:rounded-[10px] [&_pre]:bg-bg-subtle [&_pre]:p-3 [&_pre]:text-[13px]',
        '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
        '[&_a]:text-brand [&_a]:underline [&_a]:underline-offset-2',
        '[&_h1]:my-2 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:my-2 [&_h2]:text-md [&_h2]:font-semibold [&_h3]:my-1.5 [&_h3]:font-semibold',
        '[&_hr]:my-3 [&_hr]:border-border-faint',
        '[&_img]:max-w-full [&_img]:rounded-[10px]',
        className
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  )
}
