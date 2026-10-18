"""图片编辑能力注册表：把「用户想做什么」抽象为可插拔的 handler。

设计动机
--------
不同用户的场景差异极大（换装、抠图、去水印、扩图、换背景、转绘、批量去瑕疵、
证件照换底、商品图白底、漫画上色……），把能力写死在代码里必然跟不上。因此平台
采用「能力注册表 + 意图分析」架构：

1. 平台内置一组通用能力（restyle / cutout / transparent / remove / enhance）；
2. 管理员可在系统配置 ``EDIT_HANDLERS`` 里**纯声明式追加自定义能力**
   （只需给一段能力描述 + 上游提示词模板，不需要写任何执行代码）；
3. 意图分析层（LLM）从注册表**动态生成能力清单**，按用户原话挑选合适能力；
4. 编排器按能力声明的 ``engine`` / ``output`` / ``per_region`` 自动执行并汇总产出。

新增一种能力 = 在注册表里加一条声明。**执行代码零改动。**
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.utils.logging import get_logger

logger = get_logger("app.edit_handlers")

# 能力引擎：upstream=消耗上游算力（需图生图）；local=本地确定性处理（不占算力）
ENGINE_UPSTREAM = "upstream"
ENGINE_LOCAL = "local"
_ENGINES = {ENGINE_UPSTREAM, ENGINE_LOCAL}

# 产出形态：composite=与原图同尺寸的整图；sprite=独立透明素材（尺寸=主体包围盒）
OUTPUT_COMPOSITE = "composite"
OUTPUT_SPRITE = "sprite"
_OUTPUTS = {OUTPUT_COMPOSITE, OUTPUT_SPRITE}

# 本地执行器标识 → generate_service 中的实现
EXECUTOR_CUTOUT = "cutout"
EXECUTOR_TRANSPARENT = "transparent"
_LOCAL_EXECUTORS = {EXECUTOR_CUTOUT, EXECUTOR_TRANSPARENT}


@dataclass(frozen=True)
class EditHandler:
    """一种编辑能力的声明。"""

    id: str
    """能力标识（LLM 与前端引用它）。"""

    label: str
    """面向用户的中文短名。"""

    description: str
    """面向 LLM 的能力说明：讲清「什么场景该选它」，越具体命中越准。"""

    engine: str = ENGINE_UPSTREAM
    """执行引擎。"""

    output: str = OUTPUT_COMPOSITE
    """产出形态。"""

    per_region: bool = False
    """True=每个区域各产出一张；False=该能力下所有区域合并产出一张。"""

    billable: bool = True
    """是否计费（本地确定性能力免费）。"""

    prompt_prefix: str = ""
    """上游能力的内置提示词前缀（自动拼在用户指令之前）。"""

    executor: str = ""
    """本地能力的执行器标识（engine=local 时必填）。"""

    def to_public(self) -> dict[str, Any]:
        """对外暴露的字段（供后台配置页与前端渲染）。"""
        return {
            "id": self.id,
            "label": self.label,
            "description": self.description,
            "engine": self.engine,
            "output": self.output,
            "per_region": self.per_region,
            "billable": self.billable,
            "executor": self.executor,
            # 带内置提示词的能力（抠图/去物/增强）不需要用户再写指令
            "has_builtin_prompt": bool(self.prompt_prefix),
        }


# --------------------------------------------------------------------------- #
# 内置能力（通用场景，覆盖绝大多数需求）
# --------------------------------------------------------------------------- #
BUILTIN_HANDLERS: tuple[EditHandler, ...] = (
    EditHandler(
        id="restyle",
        label="改样式/换内容",
        description=(
            "按用户指令修改该区域的内容、风格、材质、颜色、光照或氛围，画面其余部分保持完全不变。"
            "适用于换装、换表情/发型、换材质、调色、风格迁移、替换主体等绝大多数「把这里改成……」的需求。"
            "当用户需求无法明确归入其它能力时，一律选它。"
        ),
        engine=ENGINE_UPSTREAM,
        output=OUTPUT_COMPOSITE,
        per_region=False,
        billable=True,
    ),
    EditHandler(
        id="cutout",
        label="抠出为透明素材",
        description=(
            "把该区域的主体从背景中精确分离，输出透明背景的独立素材图片（PNG，带 alpha 通道）。"
            "适用于「抠出来」「去背景」「做成贴纸/素材/图标」等需求。"
            "【重要】本能力只产出独立素材，原图的该区域保持完全不变——"
            "不做任何美化、重绘、改色或风格调整。用户要的是「把原图那一块原样拿出来」。"
        ),
        # 抠图同样必须交给上游图像模型：平台不做任何本地像素处理，
        # 用户看到的每一张结果都来自 gpt-image-2，并按编辑单价计费。
        engine=ENGINE_UPSTREAM,
        output=OUTPUT_SPRITE,
        # 每个素材区域各产出 1 张：两个区域都选抠图时必须给 2 张素材，
        # 合并成 1 张会让「先抠左边、再抠右边」直接丢一半结果。
        per_region=True,
        billable=True,
        prompt_prefix=(
            "只处理红框标出的区域：把其中的主体完整分离出来，输出纯透明背景（alpha 通道）的 PNG；"
            "主体的内容、细节、颜色、光影必须与原图完全一致，"
            "不要重绘、不要美化、不要添加背景或阴影、不要改变风格。"
        ),
    ),
    EditHandler(
        id="transparent",
        label="就地挖空变透明",
        description=(
            "在原图内部把该区域擦除为透明，画面尺寸与其余内容完全不变，输出整图。"
            "适用于「把这里去掉并留空」「挖个洞」「留出透明区域」等需求。"
            "【与抠图的区别】抠图 = 把主体拿出来做成独立素材、原图不动；"
            "本能力 = 在原图上把这个位置挖空。两者语义相反，不可混用。"
        ),
        # 透明化仍然是图片编辑操作：先交给图片上游理解和生成，
        # 网关/编排层只负责 alpha 与选区外像素的确定性收口。
        engine=ENGINE_UPSTREAM,
        output=OUTPUT_COMPOSITE,
        per_region=False,
        billable=True,
        prompt_prefix="将该区域擦除为透明，保持整张图片尺寸、其余内容和原有 alpha 完全不变。",
    ),
    EditHandler(
        id="remove",
        label="去除物体",
        description=(
            "移除该区域内的物体、人物或瑕疵，并用周围背景自然填补，保持画面连贯无痕。"
            "适用于「去掉这个人/水印/杂物/痘痘」等需求。"
        ),
        engine=ENGINE_UPSTREAM,
        output=OUTPUT_COMPOSITE,
        per_region=False,
        billable=True,
        prompt_prefix="移除该区域内的物体，用与周围完全一致的背景自然填补，不留任何痕迹。",
    ),
    EditHandler(
        id="enhance",
        label="画质增强",
        description=(
            "提升该区域的清晰度、细节与分辨率，内容、构图与风格保持不变。"
            "适用于「变清晰」「修复模糊」「提高画质」「去噪」等需求。"
        ),
        engine=ENGINE_UPSTREAM,
        output=OUTPUT_COMPOSITE,
        per_region=False,
        billable=True,
        prompt_prefix="提升该区域的清晰度与细节表现，保持内容、构图与风格完全一致。",
    ),
)

BUILTIN_INDEX: dict[str, EditHandler] = {item.id: item for item in BUILTIN_HANDLERS}

# 兜底能力：当 LLM 给出未知 id 或用户未指定时使用
FALLBACK_HANDLER_ID = "restyle"


# --------------------------------------------------------------------------- #
# 加载（内置 + 系统配置扩展）
# --------------------------------------------------------------------------- #
def _parse_handler(raw: dict[str, Any]) -> EditHandler | None:
    """把一条 JSON 声明解析为 EditHandler（非法则返回 None）。"""
    handler_id = str(raw.get("id") or "").strip()
    if not handler_id:
        return None
    engine = str(raw.get("engine") or ENGINE_UPSTREAM).strip().lower()
    if engine not in _ENGINES:
        engine = ENGINE_UPSTREAM
    output = str(raw.get("output") or OUTPUT_COMPOSITE).strip().lower()
    if output not in _OUTPUTS:
        output = OUTPUT_COMPOSITE
    executor = str(raw.get("executor") or "").strip()
    if engine == ENGINE_LOCAL and executor not in _LOCAL_EXECUTORS:
        # 本地能力必须绑定到已实现的执行器，否则静默降级为上游能力
        logger.warning("自定义能力 %s 声明为 local 但 executor=%s 无效，已降级为 upstream", handler_id, executor)
        engine = ENGINE_UPSTREAM
        executor = ""
    base = BUILTIN_INDEX.get(handler_id)
    return EditHandler(
        id=handler_id,
        label=str(raw.get("label") or (base.label if base else handler_id)),
        description=str(raw.get("description") or (base.description if base else "")),
        engine=engine,
        output=output,
        per_region=bool(raw.get("per_region", base.per_region if base else False)),
        billable=bool(raw.get("billable", engine == ENGINE_UPSTREAM)),
        prompt_prefix=str(raw.get("prompt_prefix") or (base.prompt_prefix if base else "")),
        executor=executor,
    )


async def load_handlers(db: AsyncSession | None = None) -> dict[str, EditHandler]:
    """加载能力注册表：内置能力 + 系统配置中的自定义能力（同 id 覆盖）。

    :param db: 传入则合并 ``EDIT_HANDLERS`` 配置；为 None 时仅返回内置能力
    """
    handlers: dict[str, EditHandler] = dict(BUILTIN_INDEX)
    if db is None:
        return handlers
    from app.services import config_service  # 延迟导入，避免模块级循环依赖

    try:
        extra = await config_service.get_json(db, "EDIT_HANDLERS", [])
    except Exception:  # noqa: BLE001 - 配置读取失败不应影响编辑主流程
        logger.exception("读取 EDIT_HANDLERS 配置失败，使用内置能力")
        return handlers
    if not isinstance(extra, list):
        return handlers
    for raw in extra:
        if not isinstance(raw, dict):
            continue
        parsed = _parse_handler(raw)
        if parsed is not None:
            handlers[parsed.id] = parsed
    return handlers


def resolve_handler(handlers: dict[str, EditHandler], handler_id: str | None) -> EditHandler:
    """解析能力 id（未知 id 回退到兜底能力，保证任务不因 LLM 幻觉而失败）。"""
    if handler_id and handler_id in handlers:
        return handlers[handler_id]
    if handler_id:
        logger.warning("未知编辑能力 %s，回退为 %s", handler_id, FALLBACK_HANDLER_ID)
    return handlers.get(FALLBACK_HANDLER_ID) or BUILTIN_INDEX[FALLBACK_HANDLER_ID]


def render_catalog(handlers: dict[str, EditHandler]) -> str:
    """把注册表渲染为「能力清单」文本，供 LLM 意图分析时选择。

    清单完全由注册表驱动——管理员新增能力后，LLM 自动就知道它存在。
    """
    lines: list[str] = []
    for handler in handlers.values():
        suffix = "（本地处理，不计费）" if handler.engine == ENGINE_LOCAL else ""
        lines.append(f"- `{handler.id}`（{handler.label}）{suffix}：{handler.description}")
    return "\n".join(lines)


def with_prompt_prefix(handler: EditHandler, prefix: str) -> EditHandler:
    """返回替换了提示词前缀的能力副本（配置覆盖用）。"""
    return replace(handler, prompt_prefix=prefix)
