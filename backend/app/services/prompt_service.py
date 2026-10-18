"""提示词模板服务：模板文件 + 系统配置覆盖。

模板以 Markdown 文件存放在 ``app/prompts/``，占位符使用 ``{{name}}`` 语法
（刻意避开 ``{}``，因为模板里包含 JSON 示例，用 ``str.format`` 会冲突）。

覆盖优先级：``system_configs.PROMPT_<NAME>`` > ``app/prompts/<name>.md`` > 代码内置兜底。

管理员因此可以在后台直接改提示词，**无需改代码、无需重启**。
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.utils.logging import get_logger

logger = get_logger("app.prompt_service")

PROMPTS_DIR = Path(__file__).resolve().parent.parent / "prompts"

# 代码内置兜底：模板文件缺失时保证功能仍可用
_FALLBACKS: dict[str, str] = {
    "intent_planner": (
        "你是图像编辑意图分析器。根据用户需求，从下面的能力清单中选择合适的 handler，"
        "输出 JSON：{\"reply\": \"...\", \"ops\": [{\"region_index\": 1, \"handler\": \"...\","
        " \"prompt\": \"...\", \"intensity\": \"fine\"}]}。\n\n## 可用能力\n\n{{catalog}}\n"
    ),
}


def config_key(name: str) -> str:
    """模板名 → 系统配置键（``intent-planner`` → ``PROMPT_INTENT_PLANNER``）。"""
    normalized = name.replace("-", "_").replace(".", "_").replace("/", "_").upper()
    return f"PROMPT_{normalized}"


def render(template: str, **values: Any) -> str:
    """用 ``{{name}}`` 占位符渲染模板（缺失的占位符原样保留，便于排查）。"""
    output = template
    for key, value in values.items():
        output = output.replace("{{" + key + "}}", str(value))
    return output


def load_sync(name: str) -> str:
    """同步读取模板（配置 → 文件 → 兜底）。"""
    path = PROMPTS_DIR / f"{name}.md"
    try:
        if path.exists():
            return path.read_text(encoding="utf-8")
    except Exception:  # noqa: BLE001 - 读取失败回退兜底
        logger.exception("读取提示词模板 %s 失败", path)
    return _FALLBACKS.get(name, "")


async def load(db: AsyncSession | None, name: str) -> str:
    """读取模板（系统配置优先，其次文件，最后兜底）。"""
    if db is not None:
        from app.services import config_service  # 延迟导入，避免循环依赖

        try:
            override = await config_service.get_raw(db, config_key(name), "")
        except Exception:  # noqa: BLE001 - 配置异常不影响主流程
            logger.exception("读取提示词配置 %s 失败", name)
            override = ""
        if override and override.strip():
            return override
    return load_sync(name)
