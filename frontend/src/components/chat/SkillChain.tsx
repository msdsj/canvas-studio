import { useMemo, useRef } from 'react'
import { ArrowRight, Check, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ComposeStep, SkillStepState } from '@/lib/api/chat'
import { useGrowOnMount } from './streaming'

/**
 * 技能链：把这次编排里**真实出现过**的设计技能画成「初筛 → 命中 → 提示词」的链路。
 *
 * 为什么需要解析而不是直接读结构化字段：后端 `compose_service` 目前只把技能写进
 * 步骤的 `items` 文本（如「技能：品牌 VI 手册」「套用技能：国潮海报」），并没有
 * 单独发技能清单。所以这里只做**严格前缀解析**：
 *   - 认 `技能：` / `套用技能：` / `命中：` / `候选：` 四种前缀；
 *   - 认不出的一律当作「没有结构化技能信息」，**整个区块不渲染**。
 * 宁可不显示，也不能凭空编一个技能名骗用户。
 *
 * 注意 `技能：通用设计原则` 是后端「没有命中特定技能」时的兜底文案，不算命中。
 */

const GENERIC = '通用'
const KNOWN_PREFIXES = ['套用技能：', '技能：', '命中：', '候选：'] as const
const LIST_SEPARATORS = /[、,，/]/

/** 技能名前缀对应的分类（与后端 design_skills 的分类体系一一对应）。 */
const CATEGORY_HINTS: Array<{ keys: string[]; label: string; dot: string }> = [
  { keys: ['品牌', 'logo', '标志', 'vi', '包装', '商标', '手册'], label: '品牌', dot: 'bg-info' },
  { keys: ['海报', '主视觉', '电影感', '国潮', '复古', '宣传', '展览'], label: '海报', dot: 'bg-accent-strong' },
  { keys: ['小红书', '社媒', '朋友圈', '公众号', '封面', '头图', '笔记', '直播'], label: '社媒', dot: 'bg-danger' },
  { keys: ['电商', '主图', '详情页', '产品', '商品', '模特', 'banner'], label: '电商', dot: 'bg-warning' },
  { keys: ['界面', 'app', 'ui', '网页', '落地页', '看板', '图标', '表单', '引导页'], label: '界面', dot: 'bg-info' },
  { keys: ['插画', '角色', '绘本', '二次元', '卡通', 'ip', '像素', '单线'], label: '插画', dot: 'bg-success' },
  { keys: ['摄影', '人像', '实拍', '写真', '美食', '建筑', '街拍', '胶片'], label: '摄影', dot: 'bg-text-secondary' },
  { keys: ['字体', '标题字', '排版', '竖排'], label: '字体', dot: 'bg-brand-text' },
  { keys: ['配色', '色彩', '调色', '色板', '渐变', '光影'], label: '色彩', dot: 'bg-accent' },
  { keys: ['版式', '构图', '画册', '杂志', '信息图', '折页', '网格'], label: '版式', dot: 'bg-select' },
  { keys: ['菜单', '价签', '名片', '简历', '邀请函', '证书', '印刷', '传单'], label: '印刷', dot: 'bg-warning' },
  { keys: ['ppt', '演示', '汇报', '路演', '流程图', '架构图', '图表', '幻灯片'], label: '演示', dot: 'bg-info' },
  { keys: ['播客', '专辑', '书封', '书籍', '有声书'], label: '音频', dot: 'bg-success' },
  { keys: ['t恤', '贴纸', '表情包', '周边', '三视图', '印花', '徽章'], label: '周边', dot: 'bg-danger' },
  { keys: ['头像', '壁纸', '直播间背景', '个人主页'], label: '头像', dot: 'bg-accent-strong' },
  { keys: ['3d', '渲染', '立体', '材质', '粘土', '玻璃', '等距'], label: '3D', dot: 'bg-text-tertiary' },
]

function categoryOf(name: string) {
  const lower = name.toLowerCase()
  for (const item of CATEGORY_HINTS) {
    if (item.keys.some((key) => lower.includes(key))) return item
  }
  return { label: '技能', dot: 'bg-border-strong' }
}

export interface SkillChipData {
  name: string
  kind: 'pick' | 'hit'
  category: { label: string; dot: string }
}

interface ParsedSkills {
  candidates: SkillChipData[]
  hits: SkillChipData[]
}

function parseLine(line: string): Array<{ kind: 'pick' | 'hit'; names: string[] }> {
  const trimmed = line.trim()
  const prefix = KNOWN_PREFIXES.find((item) => trimmed.startsWith(item))
  if (!prefix) return []
  const body = trimmed.slice(prefix.length).trim()
  if (!body) return []
  const kind: 'pick' | 'hit' = prefix === '候选：' ? 'pick' : 'hit'
  return [
    {
      kind,
      names: body
        .split(LIST_SEPARATORS)
        .map((name) => name.trim())
        .filter((name) => name.length > 0 && !name.startsWith(GENERIC)),
    },
  ]
}

/** 从步骤文本里解析技能；解析不到返回空数组（调用方据此不渲染区块）。 */
export function extractSkills(steps: Array<ComposeStep | SkillStepState>): ParsedSkills {
  const candidates = new Map<string, SkillChipData>()
  const hits = new Map<string, SkillChipData>()

  for (const step of steps) {
    const lines: string[] = []
    if (step.detail) lines.push(...step.detail.split('\n'))
    if ('items' in step && Array.isArray(step.items)) lines.push(...step.items)
    for (const line of lines) {
      for (const entry of parseLine(line)) {
        const bucket = entry.kind === 'pick' ? candidates : hits
        for (const name of entry.names) {
          if (bucket.has(name)) continue
          bucket.set(name, { name, kind: entry.kind, category: categoryOf(name) })
        }
      }
    }
  }

  // 初筛里已经命中的，不再重复出现在「初筛」列
  for (const name of hits.keys()) candidates.delete(name)
  return { candidates: [...candidates.values()], hits: [...hits.values()] }
}

function Chip({ chip, muted }: { chip: SkillChipData; muted?: boolean }) {
  const ref = useRef<HTMLSpanElement | null>(null)
  useGrowOnMount(ref, 'x', 0.06)
  return (
    <span
      ref={ref}
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-full border px-1.5 py-[2px] text-micro leading-none',
        muted
          ? 'border-border bg-transparent text-text-tertiary'
          : 'border-accent/60 bg-accent-soft text-accent-ink'
      )}
      title={`${chip.category.label} · ${chip.name}`}
    >
      <span className={cn('h-1 w-1 shrink-0 rounded-full', chip.category.dot)} aria-hidden />
      <span className="min-w-0 truncate font-medium">{chip.name}</span>
      {!muted && <Check size={9} strokeWidth={3} className="shrink-0 opacity-80" aria-hidden />}
    </span>
  )
}

function Connector({ label }: { label: string }) {
  const ref = useRef<HTMLSpanElement | null>(null)
  useGrowOnMount(ref, 'x', 0.1)
  return (
    <span
      ref={ref}
      className="mx-0.5 flex shrink-0 items-center gap-0.5 text-text-tertiary"
      aria-label={label}
    >
      <span className="block h-px w-3 bg-border-strong" aria-hidden />
      <ArrowRight size={10} className="shrink-0" aria-hidden />
    </span>
  )
}

/** 还在初筛、命中的技能尚未确定。 */
function PendingChip() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-1.5 py-[2px] text-micro text-text-faint">
      筛选中
      <span className="h-1 w-1 animate-pulse rounded-full bg-accent-strong" aria-hidden />
    </span>
  )
}

interface SkillChainProps {
  steps: Array<ComposeStep | SkillStepState>
  /** 编排仍在进行：链尾保留一个「还在筛」的呼吸位 */
  active?: boolean
  className?: string
}

/**
 * 技能链区块。**解析不到任何技能时返回 null**——这条规则不能破。
 */
export function SkillChain({ steps, active = false, className }: SkillChainProps) {
  const { candidates, hits } = useMemo(() => extractSkills(steps), [steps])
  if (candidates.length === 0 && hits.length === 0) return null

  // 一行放得下就一行；放不下把「初筛 → 命中」断成两段折行，箭头仍然跟着各自那段
  const pickList = candidates.slice(0, 4)
  const total = pickList.length + hits.length
  const flowRow = total <= 2

  const renderPicks = () =>
    pickList.map((chip) => <Chip key={`pick-${chip.name}`} chip={chip} muted />)

  const renderHits = () =>
    hits.map((chip) => <Chip key={`hit-${chip.name}`} chip={chip} />)

  return (
    <div className={cn('flex flex-col gap-1', className)} aria-label="技能编排链路">
      {flowRow ? (
        <div className="flex flex-wrap items-center gap-y-1">
          <span className="mr-1 inline-flex shrink-0 items-center gap-1 text-micro text-text-tertiary">
            <Search size={10} className="shrink-0" aria-hidden />
            初筛
          </span>
          {pickList.length > 0 ? renderPicks() : <span className="text-micro text-text-faint">直接命中</span>}
          {(hits.length > 0 || active) && <Connector label="流向命中" />}
          {renderHits()}
          {active && hits.length === 0 && <PendingChip />}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-y-1">
            <span className="mr-1 inline-flex shrink-0 items-center gap-1 text-micro text-text-tertiary">
              <Search size={10} className="shrink-0" aria-hidden />
              初筛
            </span>
            {pickList.length > 0 ? renderPicks() : <span className="text-micro text-text-faint">直接命中</span>}
            {(hits.length > 0 || active) && <Connector label="流向命中" />}
            {active && hits.length === 0 && <PendingChip />}
          </div>
          {hits.length > 0 && (
            <div className="flex flex-wrap items-center gap-y-1">
              <span className="mr-1 shrink-0 rounded-full bg-accent-soft px-1.5 py-[2px] text-micro font-medium text-accent-ink">
                命中
              </span>
              {renderHits()}
            </div>
          )}
        </>
      )}
    </div>
  )
}
