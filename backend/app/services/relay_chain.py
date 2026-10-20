"""L1 传输层的链构造与预算遍历（ADR-3）。

职责边界
--------
- `relay_service`：单次调用 + 失败分类（协议适配 / SSRF / 响应体解析）；
- 本模块：**链怎么排、试几次、什么时候放弃**。只消费 `RelayCall.kind/.policy`，
  不关心 HTTP 细节。

双层 fallback（不是二选一）
--------------------------
1. **provider 内模型链**：`ai_providers.fallback_models`（0–3 个有序模型名），
   运行时只遍历前 2 个（延迟保护，C5：存 3 试 2）；
2. **provider 间互备**：同用户其他 provider（`updated_at desc`）取第 1 个作为
   二级候选，**不改表**。

硬预算（任一触发即终止，防止把上游额度打穿）
-------------------------------------------
`MAX_MODELS=4` / `MAX_HTTP_CALLS=5` / `MAX_RETRY_PER_MODEL=1` / `TOTAL_DEADLINE_S=120`
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, replace
from typing import Any, NoReturn

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.services import relay_service
from app.services.relay_types import (
    MAX_FALLBACK_STORED,
    MAX_FALLBACK_TRIED,
    MAX_HTTP_CALLS,
    MAX_MODELS,
    MAX_RETRY_PER_MODEL,
    MAX_TOKENS_CEILING,
    RETRY_BACKOFF_S,
    TEMPERATURE_STEP,
    TOKEN_BOOST,
    TOTAL_DEADLINE_S,
    FailureKind,
    RelayAttempt,
    RelayCall,
    RelayOutcome,
    aggregate_attempts,
    error_code_for,
    next_actions_for,
    user_message_for,
)
from app.utils.errors import AppError, ErrorCode
from app.utils.ids import new_id
from app.utils.logging import get_logger

logger = get_logger("app.relay_chain")

#: 未配置中转站时的引导文案（与一期一致：调用方不得当成「AI 说不知道」）
UNCONFIGURED_MESSAGE = "还没有配置 AI 中转站，先在左侧「中转站」里填好地址、Key 和模型"


@dataclass
class ChainPlan:
    """一次调用的完整计划（`/api/ai/status` 的 `chain_preview` 也用它）。"""

    #: 实际会遍历的目标（≤ MAX_MODELS）
    targets: list[relay_service.RelayTarget]
    #: 用户配置的备用模型（归一后，≤ MAX_FALLBACK_STORED）
    fallback_models: list[str]
    #: 跨 provider 互备候选（仅展示用，不含 Key）
    backup_provider: dict[str, Any] | None = None

    @property
    def models(self) -> list[str]:
        """计划遍历的模型名，供错误卡展示「A → B → C」。"""
        return [item.model for item in self.targets]


def normalize_fallback_models(
    raw: Any,
    primary_model: str = "",
    *,
    limit: int = MAX_FALLBACK_STORED,
) -> list[str]:
    """归一备用模型列表：strip → 去空 → 去重（保序）→ 去掉等于主模型 → 截断。

    写入侧（`routers/ai.py`）与读取侧（`build_chain_plan`）共用同一个函数，
    保证「配置页看到的」与「实际会试的」不会漂移。
    """
    items = relay_service.safe_model_list(raw)
    primary = (primary_model or "").strip()
    result: list[str] = []
    for item in items:
        value = item.strip()
        if not value:
            continue
        if primary and value == primary:
            continue
        if value in result:
            continue
        result.append(value)
        if len(result) >= limit:
            break
    return result


async def _backup_target(
    db: AsyncSession | None, user_id: str, primary: relay_service.RelayTarget
) -> relay_service.RelayTarget | None:
    """同用户其他 provider（`updated_at desc`）的第一个可用项。

    只取第 1 个（R02 的「最多再试 1 个」），且必须同时有 `base_url` 与 `model`
    才有意义。日志与错误卡只记 provider `name`，不记 `base_url` 与 Key。
    """
    if db is None or not primary.provider_id:
        # 显式传入 target（如连通性测试 / 单测）时不做跨 provider 猜测
        return None
    from app.models.ai_provider import AIProvider

    rows = (
        await db.execute(
            select(AIProvider)
            .where(
                AIProvider.user_id == user_id,
                # 跨 provider 互备只在「个人配置」范围内挑选：
                # 团队的统一配置是管理员定的，不能被成员自己的备用项顶掉
                AIProvider.scope == "personal",
                AIProvider.id != primary.provider_id,
            )
            .order_by(AIProvider.updated_at.desc())
            .limit(5)
        )
    ).scalars().all()
    for row in rows:
        base_url = (row.base_url or "").strip()
        model = (row.model or "").strip()
        if not base_url or not model:
            continue
        return relay_service.RelayTarget(
            source="user",
            name=row.name or "备用中转站",
            kind=row.kind or "compatible",
            base_url=base_url,
            api_key=(row.api_key or "").strip(),
            model=model,
            temperature=float(row.temperature if row.temperature is not None else 0.7),
            max_tokens=int(row.max_tokens or 2048),
            extra=dict(row.extra or {}),
            supports_vision=bool(row.supports_vision),
            fallback_models=[],
            provider_id=row.id,
        )
    return None


async def build_chain_plan(
    db: AsyncSession | None, user_id: str, primary: relay_service.RelayTarget
) -> ChainPlan:
    """构造链：primary → 模型链（≤2）→ 跨 provider（≤1），去重后截断到 4。"""
    configured = normalize_fallback_models(primary.fallback_models, primary.model)
    targets: list[relay_service.RelayTarget] = [primary]

    for model in configured[:MAX_FALLBACK_TRIED]:
        if any(item.model == model for item in targets):
            continue
        # 同一个 provider 的地址 / Key / 协议不变，只换模型名
        targets.append(replace(primary, model=model, fallback_models=[]))

    backup = await _backup_target(db, user_id, primary)
    if backup is not None and not any(item.model == backup.model for item in targets):
        targets.append(backup)

    # 去重（同名模型只保留首次出现）+ 去掉空模型名 + 硬上限
    unique: list[relay_service.RelayTarget] = []
    for item in targets:
        model = (item.model or "").strip()
        if not model:
            continue
        if any(existing.model == model for existing in unique):
            continue
        unique.append(item)
    unique = unique[:MAX_MODELS]

    return ChainPlan(
        targets=unique,
        fallback_models=configured,
        backup_provider=(
            {"id": backup.provider_id, "name": backup.name, "model": backup.model}
            if backup is not None
            else None
        ),
    )


async def build_chain(
    db: AsyncSession | None, user_id: str, primary: relay_service.RelayTarget
) -> list[relay_service.RelayTarget]:
    """只要目标列表的便捷入口（`chain_preview` 与单测用）。"""
    plan = await build_chain_plan(db, user_id, primary)
    return plan.targets


def _retry_temperature(base: float | None, try_index: int) -> float | None:
    """同模型重试时下调 temperature（让输出更收敛，ADR-2 第 5 条）。"""
    if try_index <= 1 or base is None:
        return base
    return max(0.0, round(base - TEMPERATURE_STEP * (try_index - 1), 2))


def _raise_exhausted(
    *,
    reason: FailureKind,
    chain: list[str],
    attempts: list[RelayAttempt],
    total_calls: int,
    elapsed_ms: int,
    purpose: str,
) -> NoReturn:
    """整链失败：抛结构化 `AppError`（`data` 里没有一个自由文本字段）。

    `message` 用兜底文案（不含 json / html / HTTP / 异常类名 / 堆栈）；
    前端按 `code + data.reason` 渲染三段式错误卡（ADR-7）。
    """
    trace_id = f"relay_{new_id()[:12]}"
    data = {
        "reason": reason.value,
        "chain": list(chain),
        "attempts": aggregate_attempts(attempts),
        "total_calls": total_calls,
        "elapsed_ms": elapsed_ms,
        "next_actions": next_actions_for(reason),
        "trace_id": trace_id,
    }
    logger.warning(
        "relay 链终止 purpose=%s reason=%s chain=%s calls=%s elapsed_ms=%s trace_id=%s",
        purpose,
        reason.value,
        "->".join(chain),
        total_calls,
        elapsed_ms,
        trace_id,
    )
    raise AppError(error_code_for(reason), user_message_for(reason), data=data)


async def chat_resilient(
    db: AsyncSession | None,
    user_id: str,
    messages: list[dict[str, Any]],
    *,
    json_mode: bool = False,
    temperature: float | None = None,
    max_tokens: int | None = None,
    target: relay_service.RelayTarget | None = None,
    purpose: str = "generic",
) -> RelayOutcome:
    """带韧性的调用：链遍历 + 三重预算 + 失败分类（ADR-3）。

    Args:
        db: 数据库会话；仅在需要解析配置 / 跨 provider 互备时使用。
        user_id: 用户 id。
        messages: OpenAI 风格的 messages。
        json_mode: 是否要求 `response_format=json_object`。
        temperature / max_tokens: 覆盖目标默认值。
        target: 显式指定目标（跳过 `resolve`，连通性测试与单测用）。
        purpose: `compose` / `polish` / `plan` / `generic`，仅用于日志与统计。

    Returns:
        `RelayOutcome`（含全量 `attempts`，供错误卡与可观测面板消费）。

    Raises:
        AppError: 未配置中转站（VALIDATION_ERROR），或整链失败（结构化 data）。
    """
    primary = target
    if primary is None:
        if db is None:
            raise AppError(ErrorCode.VALIDATION_ERROR, UNCONFIGURED_MESSAGE)
        primary = await relay_service.resolve(db, user_id)
    if primary is None:
        raise AppError(ErrorCode.VALIDATION_ERROR, UNCONFIGURED_MESSAGE)

    plan = await build_chain_plan(db, user_id, primary)
    if not plan.targets:
        # 模型名为空：无法发起任何调用，按配置问题如实报错（不伪造成功）
        raise AppError(
            ErrorCode.VALIDATION_ERROR,
            "还没有填模型名，在「中转站」里补上模型名再试",
        )

    deadline = time.monotonic() + TOTAL_DEADLINE_S
    started = time.monotonic()
    attempts: list[RelayAttempt] = []
    total_calls = 0
    last_reason: FailureKind = FailureKind.BUDGET_EXHAUSTED
    success: RelayCall | None = None
    winner: relay_service.RelayTarget | None = None
    budget_hit = False
    stopped = False

    for item in plan.targets:
        if stopped:
            break
        base_temperature = temperature if temperature is not None else item.temperature
        try_index = 0
        boosted_tokens: int | None = None
        while True:
            try_index += 1
            if total_calls >= MAX_HTTP_CALLS or time.monotonic() >= deadline:
                budget_hit = True
                stopped = True
                break
            call = await relay_service._chat_once(
                item,
                messages,
                json_mode=json_mode,
                temperature=_retry_temperature(base_temperature, try_index),
                max_tokens=boosted_tokens or max_tokens,
            )
            total_calls += 1 if call.sent else 0
            attempts.append(
                RelayAttempt(
                    model=item.model,
                    provider=item.name,
                    provider_id=item.provider_id,
                    try_index=try_index,
                    ok=call.kind is FailureKind.OK,
                    reason=call.kind,
                    http_status=call.status,
                    elapsed_ms=call.elapsed_ms,
                    body_head=call.body_head,
                )
            )
            logger.info(
                "relay attempt purpose=%s model=%s provider=%s try=%s kind=%s status=%s "
                "elapsed_ms=%s total_calls=%s",
                purpose,
                item.model,
                item.name,
                try_index,
                call.kind.value,
                call.status,
                call.elapsed_ms,
                total_calls,
            )
            if call.kind is FailureKind.OK:
                success = call
                winner = item
                stopped = True
                break

            last_reason = call.kind
            if call.policy.fatal:
                # 配置类错误：换模型、换 provider 都救不了，立即终止整链
                stopped = True
                break
            if not call.policy.retry_same_model or try_index > MAX_RETRY_PER_MODEL:
                break
            if call.policy.boost_max_tokens:
                base_tokens = boosted_tokens or max_tokens or item.max_tokens
                boosted_tokens = min(int(base_tokens * TOKEN_BOOST), MAX_TOKENS_CEILING)
            await asyncio.sleep(RETRY_BACKOFF_S)

    elapsed_ms = int((time.monotonic() - started) * 1000)

    if success is not None and winner is not None:
        return RelayOutcome(
            content=success.content,
            model=winner.model,
            provider=winner.name,
            source=winner.source,
            elapsed_ms=elapsed_ms,
            attempts=attempts,
            chain=plan.models,
            total_calls=total_calls,
            # 不是链上第一个模型成功 → 前端提示「已用备用模型生成」
            degraded=winner.model != plan.targets[0].model,
        )

    reason = FailureKind.BUDGET_EXHAUSTED if budget_hit else last_reason
    _raise_exhausted(
        reason=reason,
        chain=plan.models,
        attempts=attempts,
        total_calls=total_calls,
        elapsed_ms=elapsed_ms,
        purpose=purpose,
    )
