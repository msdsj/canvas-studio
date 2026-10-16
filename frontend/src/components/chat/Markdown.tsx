import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'

/** AI 文本 Markdown 渲染。 */
export function Markdown({ content, className }: { content: string; className?: string }) {
  return (
    <div
      className={cn(
        'text-base leading-relaxed text-text',
        '[&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5',
        '[&_code]:rounded [&_code]:bg-bg-subtle [&_code]:px-1 [&_code]:font-mono [&_code]:text-sm',
        '[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-bg-subtle [&_pre]:p-3',
        '[&_a]:text-brand [&_a]:underline [&_h1]:my-2 [&_h1]:text-md [&_h1]:font-semibold [&_h2]:my-2 [&_h2]:font-semibold',
        className
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  )
}
