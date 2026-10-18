"""系统配置服务：唯一真源 = `system_configs` 表，env 兜底。

支持：读取（secret 掩码）、批量写入、解析单价 / Demo 开关 / 上游配置，并主动推送网关。
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings, upstream_settings
from app.models.system_config import SystemConfig
from app.utils.ids import utcnow
from app.utils.logging import get_logger

logger = get_logger("app.config_service")


@dataclass(frozen=True)
class ConfigDef:
    """配置项定义。"""

    key: str
    value: str
    value_type: str  # string | int | bool | json | secret
    category: str
    description: str
    is_secret: bool = False


# 默认配置清单（seed 时写入；缺失时兜底）
DEFAULT_CONFIGS: list[ConfigDef] = [
    ConfigDef("TEXT_API_BASE_URL", upstream_settings.text_base_url, "string", "integration", "文本对话 provider 地址（OpenAI 兼容，通常填到 /v1）"),
    ConfigDef("TEXT_API_KEY", upstream_settings.text_api_key, "secret", "integration", "文本对话 provider API Key", is_secret=True),
    ConfigDef("TEXT_MODEL", upstream_settings.text_model, "string", "integration", "普通对话模型名称"),
    ConfigDef("LLM_BASE_URL", upstream_settings.llm_base_url, "string", "integration", "意图分析模型中转地址（OpenAI 兼容）"),
    ConfigDef("LLM_API_KEY", upstream_settings.llm_api_key, "secret", "integration", "意图分析模型 API Key", is_secret=True),
    ConfigDef("LLM_MODEL", upstream_settings.llm_model, "string", "integration", "意图分析模型名称（留空使用默认模型）"),
    ConfigDef("IMAGE_API_BASE_URL", upstream_settings.image_base_url, "string", "integration", "图片 provider 地址（OpenAI 兼容，通常填到 /v1）"),
    ConfigDef("IMAGE_API_KEY", upstream_settings.image_api_key, "secret", "integration", "图片 provider API Key", is_secret=True),
    ConfigDef("IMAGE_MODEL", upstream_settings.image_model, "string", "integration", "图片模型名称"),
    ConfigDef("HTTP_PROXY", upstream_settings.http_proxy, "string", "network", "HTTP 代理"),
    ConfigDef("HTTPS_PROXY", upstream_settings.https_proxy, "string", "network", "HTTPS 代理"),
    ConfigDef("DEMO_MODE", settings.demo_mode, "string", "demo", "Demo 模式 auto|on|off"),
    ConfigDef("OPEN_REGISTRATION", str(settings.open_registration).lower(), "bool", "registration", "是否开放注册"),
    ConfigDef("MAINTENANCE_MODE", str(settings.maintenance_mode).lower(), "bool", "registration", "维护模式"),
    ConfigDef("INITIAL_GRANT", str(settings.initial_grant), "int", "quota", "新用户初始赠送积分"),
    ConfigDef("QUOTA_PRICE_IMAGE", str(settings.quota_price_image), "int", "quota", "标准生图单价"),
    ConfigDef("QUOTA_PRICE_IMAGE_HD", str(settings.quota_price_image_hd), "int", "quota", "高清生图单价"),
    ConfigDef("QUOTA_PRICE_EDIT", str(settings.quota_price_edit), "int", "quota", "编辑单价"),
    ConfigDef("QUOTA_PRICE_CHAT", str(settings.quota_price_chat), "int", "quota", "对话单价"),
    ConfigDef("QUOTA_WARN_PCT", str(settings.quota_warn_pct), "int", "quota", "额度预警阈值(%)"),
    ConfigDef("MAX_ACTIVE_TASKS_PER_USER", str(settings.max_active_tasks_per_user), "int", "pool", "每用户并发活跃任务上限"),
    ConfigDef("POOL_AUTOREFRESH_MINUTES", str(settings.pool_autorefresh_minutes), "int", "pool", "号池自动刷新周期(分钟)"),
    # ---- 编辑提示词内置配置（上传/编辑流程共用，随用户提示词一并透传上游）----
    ConfigDef(
        "EDIT_PROMPT_TEMPLATE",
        "请仅修改图中红色框选标记的区域，未标记区域保持完全不变。",
        "string",
        "prompt",
        "编辑任务内置提示词前缀（自动拼接在用户提示词之前）",
    ),
    ConfigDef(
        "EDIT_PROMPT_PRESETS",
        json.dumps(
            [
                {"id": "enhance", "label": "画质增强", "prompt": "提升该区域的清晰度与细节，保持内容一致"},
                {"id": "remove", "label": "去除杂物", "prompt": "去除该区域的物体，并用周围背景自然填补"},
                {"id": "replace", "label": "替换主体", "prompt": "将该区域的主体替换为"},
                {"id": "style", "label": "风格迁移", "prompt": "将该区域改为水彩插画风格，其余保持不变"},
                {"id": "color", "label": "调整色调", "prompt": "调整该区域的色调与光影，使其更自然"},
            ],
            ensure_ascii=False,
        ),
        "json",
        "prompt",
        "上传/编辑内置提示词预设（JSON 数组，每项含 id/label/prompt）",
    ),
    # ---- 可插拔编辑能力 + 意图分析（对标 lovart 的智能编排核心）----
    ConfigDef(
        "EDIT_HANDLERS",
        "[]",
        "json",
        "prompt",
        "自定义编辑能力（JSON 数组）：纯声明式扩展，无需改代码；同 id 覆盖内置能力。"
        "字段 id/label/description/engine(upstream|local)/output(composite|sprite)/"
        "per_region/billable/prompt_prefix/executor",
    ),
    ConfigDef(
        "CUTOUT_STRATEGY",
        "auto",
        "string",
        "prompt",
        "抠图兜底策略 auto|rembg|grabcut|chroma（仅在上游未返回 alpha 通道时启用）",
    ),
    ConfigDef(
        "CUTOUT_LOCAL_FALLBACK",
        "false",
        "bool",
        "prompt",
        "抠图本地兜底：仅在图片上游返回结果但丢弃 alpha 时启用，默认关闭",
    ),
    ConfigDef(
        "EDIT_CONCURRENCY",
        "3",
        "int",
        "prompt",
        "编辑任务并发调用上游的区域数上限（1~6）。每个选区一次独立调用，并发执行以缩短总耗时",
    ),
    ConfigDef(
        "INTENT_PLANNER_MODEL",
        "gpt-4o-mini",
        "string",
        "prompt",
        "意图分析（自然语言 → 结构化编辑计划）使用的模型",
    ),
    ConfigDef(
        "PROMPT_INTENT_PLANNER",
        "",
        "string",
        "prompt",
        "意图分析系统提示词覆盖（留空则用内置模板 app/prompts/intent_planner.md）",
    ),
    # ---- 纯生图全链路（需求分析 / 提示词工程 / 润色）----
    ConfigDef(
        "AI_RELAY_ALLOW_GLOBAL",
        "false",
        "bool",
        "integration",
        "允许未配置个人中转站的用户使用平台公共中转（会产生平台侧模型费用，默认关闭）",
    ),
    ConfigDef(
        "PROMPT_COMPOSE_ANALYZE",
        "",
        "string",
        "prompt",
        "生图需求分析提示词覆盖（留空则用 app/prompts/compose_analyze.md）",
    ),
    ConfigDef(
        "PROMPT_COMPOSE_PROMPT",
        "",
        "string",
        "prompt",
        "生图提示词工程提示词覆盖（留空则用 app/prompts/compose_prompt.md）",
    ),
    ConfigDef(
        "PROMPT_POLISH",
        "",
        "string",
        "prompt",
        "提示词润色提示词覆盖（留空则用 app/prompts/polish.md）",
    ),
]


async def get_json(db: AsyncSession, key: str, default: Any = None) -> Any:
    """读取 JSON 型配置（解析失败时回退默认值）。"""
    raw = await get_raw(db, key, None)
    if not raw:
        return default
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        logger.warning("配置 %s 不是合法 JSON，回退默认值", key)
        return default


def _coerce(raw: str, value_type: str) -> Any:
    """按类型转换配置值。"""
    if value_type == "int":
        try:
            return int(raw)
        except (TypeError, ValueError):
            return 0
    if value_type == "bool":
        return str(raw).strip().lower() in {"1", "true", "yes", "on"}
    return raw


async def ensure_defaults(db: AsyncSession) -> None:
    """确保默认配置项存在（缺则补）。"""
    existing_rows = (await db.execute(select(SystemConfig))).scalars().all()
    by_key = {row.key: row for row in existing_rows}
    # Existing installations used the two reference services as configuration
    # names. Migrate their values once, then remove the obsolete rows so the
    # admin UI and gateway no longer advertise those services.
    legacy_map = {
        "SUB2API_BASE_URL": "TEXT_API_BASE_URL",
        "SUB2API_API_KEY": "TEXT_API_KEY",
        "CHATGPT2API_BASE_URL": "IMAGE_API_BASE_URL",
        "CHATGPT2API_ADMIN_KEY": "IMAGE_API_KEY",
    }
    for old_key, new_key in legacy_map.items():
        old = by_key.get(old_key)
        if old is None:
            continue
        if new_key not in by_key and old.value:
            for item in DEFAULT_CONFIGS:
                if item.key == new_key:
                    db.add(
                        SystemConfig(
                            key=new_key,
                            value=old.value,
                            value_type=item.value_type,
                            is_secret=item.is_secret,
                            category=item.category,
                            description=item.description,
                        )
                    )
                    by_key[new_key] = True
                    break
        await db.delete(old)
    present = set(by_key)
    for item in DEFAULT_CONFIGS:
        if item.key not in present:
            db.add(
                SystemConfig(
                    key=item.key,
                    value=item.value,
                    value_type=item.value_type,
                    is_secret=item.is_secret,
                    category=item.category,
                    description=item.description,
                )
            )
    await db.flush()


async def get_raw(db: AsyncSession, key: str, default: str | None = None) -> str:
    """读取配置原始字符串。"""
    result = await db.execute(select(SystemConfig).where(SystemConfig.key == key))
    row = result.scalar_one_or_none()
    if row is not None:
        return row.value
    for item in DEFAULT_CONFIGS:
        if item.key == key:
            return item.value
    return default if default is not None else ""


async def get_value(db: AsyncSession, key: str, default: Any = None) -> Any:
    """读取并按类型转换配置值。"""
    result = await db.execute(select(SystemConfig).where(SystemConfig.key == key))
    row = result.scalar_one_or_none()
    if row is not None:
        return _coerce(row.value, row.value_type)
    for item in DEFAULT_CONFIGS:
        if item.key == key:
            return _coerce(item.value, item.value_type)
    return default


def _mask(value: str) -> str:
    """对敏感值做掩码。"""
    if not value:
        return ""
    if len(value) <= 4:
        return "*" * len(value)
    return value[:3] + "*" * max(len(value) - 6, 3) + value[-3:]


async def get_all(db: AsyncSession, masked: bool = True) -> list[dict[str, Any]]:
    """读取全部配置项（可选掩码）。"""
    await ensure_defaults(db)
    result = await db.execute(select(SystemConfig).order_by(SystemConfig.category, SystemConfig.key))
    items: list[dict[str, Any]] = []
    for row in result.scalars().all():
        value = _mask(row.value) if (masked and row.is_secret) else row.value
        items.append(
            {
                "key": row.key,
                "value": value,
                "value_type": row.value_type,
                "is_secret": row.is_secret,
                "category": row.category,
                "description": row.description,
                "updated_at": row.updated_at,
            }
        )
    return items


async def set_many(
    db: AsyncSession, values: dict[str, Any], operator_id: str | None
) -> list[str]:
    """批量写入配置并返回被更新的键。

    对于 secret 项：若传入值与掩码相同（含 `*`）则跳过，避免把掩码写回。
    """
    await ensure_defaults(db)
    updated: list[str] = []
    result = await db.execute(select(SystemConfig))
    index = {row.key: row for row in result.scalars().all()}
    for key, raw_value in values.items():
        row = index.get(key)
        if row is None:
            continue
        str_value = _stringify(raw_value)
        if row.is_secret and "*" in str_value:
            continue  # 掩码值不覆盖真实 secret
        row.value = str_value
        row.updated_at = utcnow()
        row.updated_by = operator_id
        updated.append(key)
    await db.flush()
    return updated


def _stringify(value: Any) -> str:
    """把任意值序列化为字符串存储。"""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


async def prices(db: AsyncSession) -> dict[str, int]:
    """返回单价表（可被配置覆盖）。"""
    return {
        "image_standard": int(await get_value(db, "QUOTA_PRICE_IMAGE", settings.quota_price_image)),
        "image_hd": int(await get_value(db, "QUOTA_PRICE_IMAGE_HD", settings.quota_price_image_hd)),
        "edit": int(await get_value(db, "QUOTA_PRICE_EDIT", settings.quota_price_edit)),
        "chat": int(await get_value(db, "QUOTA_PRICE_CHAT", settings.quota_price_chat)),
    }


async def demo_mode(db: AsyncSession) -> str:
    """返回 Demo 模式（auto/on/off）。"""
    value = str(await get_value(db, "DEMO_MODE", settings.demo_mode)).strip().lower()
    return value if value in {"auto", "on", "off"} else "auto"


async def resolve_upstream(db: AsyncSession) -> dict[str, Any]:
    """解析上游 + 代理 + Demo 配置（用于推送给网关）。"""
    return {
        "text": {
            "base_url": await get_raw(db, "TEXT_API_BASE_URL", upstream_settings.text_base_url),
            "api_key": await get_raw(db, "TEXT_API_KEY", upstream_settings.text_api_key),
            "model": await get_raw(db, "TEXT_MODEL", upstream_settings.text_model),
        },
        "llm": {
            "base_url": await get_raw(db, "LLM_BASE_URL", upstream_settings.llm_base_url),
            "api_key": await get_raw(db, "LLM_API_KEY", upstream_settings.llm_api_key),
            "model": await get_raw(db, "LLM_MODEL", upstream_settings.llm_model),
        },
        "image": {
            "base_url": await get_raw(db, "IMAGE_API_BASE_URL", upstream_settings.image_base_url),
            "api_key": await get_raw(db, "IMAGE_API_KEY", upstream_settings.image_api_key),
            "model": await get_raw(db, "IMAGE_MODEL", upstream_settings.image_model),
        },
        "proxy": {
            "http_proxy": await get_raw(db, "HTTP_PROXY", upstream_settings.http_proxy),
            "https_proxy": await get_raw(db, "HTTPS_PROXY", upstream_settings.https_proxy),
        },
        "demo_mode": await demo_mode(db),
    }


async def push_to_gateway(db: AsyncSession) -> dict[str, Any]:
    """把解析后的运行时配置推送给网关（内存缓存即生效）。"""
    from app.services.gateway_client import gateway_client  # 延迟导入避免循环依赖

    payload = await resolve_upstream(db)
    try:
        result = await gateway_client.push_config(payload)
        logger.info("已推送配置到网关: %s", result)
        return result
    except Exception as exc:  # noqa: BLE001 - 网关不可达不影响本地保存
        logger.warning("推送配置到网关失败（网关可能未启动）: %s", exc)
        return {"ok": False, "message": str(exc)}
