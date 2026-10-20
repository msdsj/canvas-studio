"""Multimodal intent planning, validated independent outputs and auditable execution."""
from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import AsyncSessionLocal
from app.models.chat import ChatSession
from app.models.skill import SkillRun
from app.models.user import User
from app.services import asset_service, config_service, generate_service
from app.services import edit_ops as ops_module
from app.services import prompt_service
from app.services.intent_plan import validate_model_plan
from app.services.edit_handlers import (
    OUTPUT_SPRITE,
    EditHandler,
    load_handlers,
    render_catalog,
)
from app.services.gateway_client import gateway_client
from app.utils.errors import AppError, ErrorCode
from app.utils.ids import new_id, utcnow
from app.utils.logging import get_logger

logger = get_logger("app.skills")

SKILL_IMAGE_INTENT = "image_edit_intent"


# --------------------------------------------------------------------------- #
# Skill 声明（可被 GET /api/chat/skills 读取，用于前端展示「编排规则」）
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class SkillStep:
    """一个编排步骤的声明。"""

    id: str
    title: str
    detail: str


@dataclass(frozen=True)
class SkillDef:
    """一个 Skill 的完整声明。"""

    id: str
    name: str
    description: str
    steps: tuple[SkillStep, ...]
    rules: tuple[str, ...] = field(default_factory=tuple)

    def to_public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "steps": [
                {"id": s.id, "title": s.title, "detail": s.detail} for s in self.steps
            ],
            "rules": list(self.rules),
        }


SKILLS: dict[str, SkillDef] = {
    SKILL_IMAGE_INTENT: SkillDef(
        id=SKILL_IMAGE_INTENT,
        name="画布编辑需求分析",
        description="结合用户提示词与原图，拆分独立产出并分配生成任务。",
        steps=(
            SkillStep("parse", "读取需求", "读取用户原话与画布选区，归一化坐标"),
            SkillStep("decide", "判定产出", "多模态模型分析需求并确定独立产出数量"),
            SkillStep("route", "编排决策", "直接执行 / 先向用户确认，二选一"),
            SkillStep("compose", "整理指令", "把每个区域改写成可直接执行的提示词"),
            SkillStep("dispatch", "提交生成", "按判定结果创建任务并开始生成"),
        ),
        rules=(
            "每次先由模型读取图片与用户需求，拆解可执行产出",
            "每项独立产出各建一个任务，批次内使用不同账号额度",
            "局部编辑保留选区外原像素，素材独立输出",
            "分析失败或指令矛盾时停止，不使用关键词规则代替模型",
        ),
    ),
}


# Public execution trace
class _Trace:
    """记录每一步的状态与耗时，最终随结果一起返回并落库。"""

    def __init__(self) -> None:
        self.steps: list[dict[str, Any]] = []
        self._started: dict[str, float] = {}

    def start(self, step_id: str, title: str, detail: str = "") -> dict[str, Any]:
        self._started[step_id] = time.perf_counter()
        payload = {
            "id": step_id,
            "title": title,
            "detail": detail,
            "status": "running",
            "elapsed_ms": 0,
        }
        self.steps.append(payload)
        return payload

    def finish(
        self,
        step_id: str,
        *,
        status: str = "done",
        detail: str | None = None,
        title: str | None = None,
        items: list[str] | None = None,
        thought: str | None = None,
        meta: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        started = self._started.pop(step_id, None)
        elapsed = int((time.perf_counter() - started) * 1000) if started else 0
        for step in reversed(self.steps):
            if step["id"] == step_id:
                step["status"] = status
                step["elapsed_ms"] = elapsed
                if detail is not None:
                    step["detail"] = detail
                if title is not None:
                    step["title"] = title
                if items is not None:
                    step["items"] = items
                if thought:
                    step["thought"] = thought
                if meta:
                    step["meta"] = meta
                return step
        step = {
            "id": step_id,
            "title": title or step_id,
            "detail": detail or "",
            "status": status,
            "elapsed_ms": elapsed,
        }
        self.steps.append(step)
        return step


# --------------------------------------------------------------------------- #
# 选区归一化
# --------------------------------------------------------------------------- #
def normalize_selection(selection: Any) -> dict[str, Any]:
    """把前端选区整理成内部结构（区域坐标 + 多边形 + 资产 id）。"""
    data = selection if isinstance(selection, dict) else {}
    raw_regions = data.get("regions")
    items = raw_regions if isinstance(raw_regions, list) else []
    regions: list[dict[str, Any]] = []
    for position, item in enumerate(items[: ops_module.MAX_OPS], start=1):
        if not isinstance(item, dict):
            continue
        source = item.get("region") if isinstance(item.get("region"), dict) else item
        region = ops_module.clean_region(source)
        if region is None:
            continue
        regions.append(
            {
                "index": int(item.get("index") or position),
                "region": region,
                "path": ops_module.clean_path(item.get("path")),
                "prompt": str(item.get("prompt") or "").strip(),
                "handler": str(item.get("handler") or "").strip(),
            }
        )
    return {
        "asset_id": str(data.get("asset_id") or "").strip() or None,
        # 掩码资产必须一起带走：确认时才重放计划，掩码丢了就等于用户没涂过。
        "mask_asset_id": str(data.get("mask_asset_id") or "").strip() or None,
        "target_id": str(data.get("target_id") or "").strip() or None,
        "revision": int(data.get("revision") or 0),
        "has_doodle": bool(data.get("has_doodle")),
        "width": int(data.get("width") or 0),
        "height": int(data.get("height") or 0),
        "regions": regions,
    }


# --------------------------------------------------------------------------- #
# 多模态模型规划
# --------------------------------------------------------------------------- #
async def _stream_model_plan(db, user, message, selection, handlers, sink):
    from app.services import compose_service, relay_service, vision_service
    template = await prompt_service.load(db, "skill_image_intent")
    # An older administrator template must not restore fixed scenario rules.
    contract = prompt_service.load_sync("skill_image_intent")
    system = prompt_service.render(template + "\n\n当前执行契约（优先于旧模板）：\n" + contract, catalog=render_catalog(handlers))
    selection_text = json.dumps({"regions": selection["regions"], "width": selection["width"], "height": selection["height"], "has_doodle": selection["has_doodle"]}, ensure_ascii=False)
    assets = [await asset_service.get_asset(db, user, selection["asset_id"])] if selection["asset_id"] else []
    content = vision_service.user_content(f"用户原话：{message}\n当前真实选区：{selection_text}", assets, selection["regions"])
    messages = [{"role": "system", "content": system}, {"role": "user", "content": content}]
    target = await relay_service.resolve(db, user.id)
    model = str(await config_service.get_value(db, "INTENT_PLANNER_MODEL", "") or "gpt-4o-mini")
    stream = None if target else gateway_client.llm_text_stream({"model": model, "messages": messages, "temperature": 0.1, "max_tokens": 6000})
    try:
        async for chunk in compose_service._stream_analysis(target, messages, sink, text_stream=stream, model=model):
            yield chunk
    except (AppError, asyncio.TimeoutError):
        raise
    except Exception as exc:
        logger.warning("意图分析流不可用: %s", type(exc).__name__)
        raise AppError(ErrorCode.UPSTREAM_ERROR, "需求分析暂时不可用，请检查模型连接后重试；未提交图片任务") from exc


def _reply_text(decision: dict[str, Any], selection: dict[str, Any]) -> str:
    """给用户看的一句结论（不复述内部字段名）。"""
    count = decision["image_count"]
    reason = decision.get("reason") or ""
    if decision.get("requires_image"):
        return "这件事需要一张底图：先在画布上选中一张图片，或用「上传」放一张进来。"
    if decision.get("needs_confirmation"):
        return decision.get("question") or f"有两种做法，产出数量不一样，你选一个我再开始。"
    if count >= 2:
        return f"这次要产出 {count} 张：{reason}。我按这个方案直接开始。"
    return f"这次产出 1 张：{reason}。我按这个方案直接开始。"


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #
def _sse(payload: dict[str, Any]) -> str:
    """把一条事件编码成 SSE 帧（`data: <json>\\n\\n`）。

    为什么必须在服务端编码：`StreamingResponse` 只接受 `str`/`bytes`。
    直接 `yield` 一个 dict 会被当成 dict 迭代出它的 **key**（"event"、"step"…），
    前端收到的是一堆裸单词、没有 `data:` 前缀 → 解析不出任何事件，
    表现为「点发送后一直转圈、步骤流始终为空」。编码只在这一处做，避免各处走样。
    """
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


async def stream_analysis(
    *,
    user: User,
    session_id: str,
    content: str,
    selection: Any,
    canvas_id: str | None,
    auto_execute: bool = True,
) -> AsyncIterator[str]:
    """执行 Skill 并把每一步实时吐出来（SSE 事件流）。

    事件类型（均为 `data: {json}` 帧）：
    - ``{"event":"step","step":{...}}`` 步骤状态变化（含 running）
    - ``{"event":"result","result":{...}}`` 最终结果（含 run_id / options / tasks）
    """
    skill = SKILLS[SKILL_IMAGE_INTENT]
    trace = _Trace()
    normalized = normalize_selection(selection)
    text = (content or "").strip()

    async with AsyncSessionLocal() as db:
        session = (
            await db.execute(select(ChatSession).where(ChatSession.id == session_id))
        ).scalar_one_or_none()
        if session is None or session.user_id != user.id:
            raise AppError(ErrorCode.NOT_FOUND, "会话不存在")

        user_message = await _append_message(db, session.id, user.id, "user", text)
        await db.execute(update(SkillRun).where(SkillRun.session_id == session.id, SkillRun.skill_id == SKILL_IMAGE_INTENT, SkillRun.status.in_(("confirm", "preview"))).values(status="voided", updated_at=utcnow()))
        await db.commit()

        handlers = await load_handlers(db)

        # 1) 读取需求
        step = trace.start("parse", skill.steps[0].title)
        yield _sse({"event": "step", "step": dict(step)})
        region_count = len(normalized["regions"])
        has_image = bool(normalized["asset_id"])
        parse_detail = (
            f"读到 {region_count} 个选区" if region_count else "没有选区，按整图理解"
        ) + ("，已选中底图" if has_image else "，未选中底图")
        step = trace.finish("parse", detail=parse_detail)
        yield _sse({"event": "step", "step": dict(step)})

        # The model is authoritative; deterministic validation never invents intent.
        step = trace.start("decide", skill.steps[1].title, "正在读取图片内容、选区编号和你的提示词")
        yield _sse({"event": "step", "step": dict(step)})
        try:
            sink: dict[str, Any] = {}
            async for chunk in _stream_model_plan(db, user, text, normalized, handlers, sink):
                yield chunk
            decision = validate_model_plan(sink["analysis"], normalized, handlers)
        except (AppError, asyncio.TimeoutError) as exc:
            message = exc.message if isinstance(exc, AppError) else "需求分析超时，请重试；未提交图片任务"
            step = trace.finish("decide", status="failed", detail=message)
            yield _sse({"event": "step", "step": dict(step)})
            attachment = {"type": "skill_run", "run_id": "", "skill": skill.to_public(), "status": "failed", "steps": list(trace.steps), "image_count": 0, "confidence": 0, "options": [], "task_ids": []}
            assistant = await _append_message(db, session.id, user.id, "assistant", message, attachments=[attachment])
            await db.commit()
            yield _sse({"event": "result", "result": {**attachment, "message_id": assistant.id, "user_message_id": user_message.id, "reply": message, "tasks": [], "demo": False}})
            return
        step = trace.finish("decide", detail=f"判定 {decision['image_count']} 张 · {decision['reason']}", items=decision.get("observations") or [], thought=sink.get("thought"), meta=sink["analysis"].get("_meta"))
        yield _sse({"event": "step", "step": dict(step)})

        # 3) 编排决策
        step = trace.start("route", skill.steps[2].title)
        yield _sse({"event": "step", "step": dict(step)})
        if decision.get("requires_image"):
            route = "needs_image"
            route_detail = "缺少底图，等待用户选中图片"
        elif decision.get("needs_confirmation"):
            route = "confirm"
            route_detail = "结论不唯一，交给用户选择"
        elif auto_execute:
            route = "direct"
            route_detail = "结论明确，直接执行"
        else:
            route = "preview"
            route_detail = "只给方案，等待用户确认"
        step = trace.finish("route", detail=route_detail)
        yield _sse({"event": "step", "step": dict(step)})

        # 4) 整理指令
        step = trace.start("compose", skill.steps[3].title)
        yield _sse({"event": "step", "step": dict(step)})
        ops = decision["ops"]
        options = decision["options"] if decision.get("needs_confirmation") else []
        compose_detail = f"整理了 {len(ops)} 条区域指令" if ops else "整图指令已就绪"
        step = trace.finish("compose", detail=compose_detail, items=[f"{job['index']}. {job['label']} · 区域 {'、'.join(str(i) for i in job['region_indexes']) or '整图'} · {'独立素材' if job['output_kind'] == OUTPUT_SPRITE else '完整图片'}" for job in decision.get("jobs") or []])
        yield _sse({"event": "step", "step": dict(step)})

        plan = {
            "intent": decision["intent"],
            "image_count": decision["image_count"],
            "variants": int(decision.get("variants") or 1),
            "ops": ops,
            "jobs": decision.get("jobs") or [],
            "asset_id": normalized["asset_id"],
            "target_id": normalized.get("target_id"),
            "selection_revision": int(normalized.get("revision") or 0),
            "selection_fingerprint": ops_module.selection_fingerprint(normalized["regions"]),
            "size": _guess_size(normalized),
        }
        # 产出明细（分组）：前端按组展示「1 张修改图 + 2 张素材」，
        # 而不是只给一个总数——总数会让用户误以为 3 张都是同一种东西。
        outputs = [{"handler": job["handler"], "label": job["label"], "kind": job["output_kind"], "count": 1, "region_indexes": job["region_indexes"]} for job in decision.get("jobs") or []]
        rule_hit = "model_plan"
        run = SkillRun(
            id=new_id(),
            user_id=user.id,
            session_id=session.id,
            canvas_id=canvas_id or session.canvas_id,
            message_id=user_message.id,
            skill_id=skill.id,
            status=route,
            image_count=int(decision["image_count"]),
            confidence=int(round(float(decision.get("confidence") or 0) * 100)),
            input={"content": text, "selection": normalized},
            plan=plan,
            steps=list(trace.steps),
            options=options,
            task_ids=[],
        )
        db.add(run)
        await db.flush()

        tasks: list[dict[str, Any]] = []
        # 5) 提交生成
        if route in {"direct", "preview"}:
            step = trace.start("dispatch", skill.steps[4].title)
            yield _sse({"event": "step", "step": dict(step)})
            if route == "direct":
                try:
                    tasks = await _dispatch(db, user, run, plan, ops, keep=(session, user_message))
                except AppError as exc:
                    # 提交失败（额度不足 / 并发任务已满 / 上游不可用）必须**在流里说清楚**。
                    # 之前这里直接抛出，SSE 会被拦腰切断：前端只看到"分析中"然后无限等待，
                    # 用户既不知道失败原因，也拿不到可重试的入口。
                    logger.warning("编排提交失败 run=%s: %s %s", run.id, exc.code, exc.message)
                    run.status = "failed"
                    step = trace.finish(
                        "dispatch",
                        detail=exc.message,
                        status="failed",
                    )
                    yield _sse({"event": "step", "step": dict(step)})
                    run.steps = list(trace.steps)
                    run.updated_at = utcnow()
                    await db.commit()
                    await _append_message(
                        db,
                        session.id,
                        user.id,
                        "assistant",
                        exc.message,
                        attachments=[
                            {
                                "type": "skill_run",
                                "run_id": run.id,
                                "skill": skill.to_public(),
                                "status": "failed",
                                "steps": list(trace.steps),
                                "image_count": run.image_count,
                                "confidence": run.confidence,
                                "reason": decision.get("reason") or "",
                                "options": [],
                                "requires_image": False,
                                "task_ids": [],
                                "rule_hit": rule_hit,
                                "outputs": outputs,
                                "jobs": plan.get("jobs") or [],
                                "selection_revision": plan["selection_revision"],
                                "selection_fingerprint": plan.get("selection_fingerprint"),
                                "target_id": plan.get("target_id"),
                                "canvas_id": run.canvas_id,
                            }
                        ],
                    )
                    await db.commit()
                    yield _sse(
                        {
                            "event": "result",
                            "result": {
                                "run_id": run.id,
                                "message_id": "",
                                "user_message_id": user_message.id,
                                "skill": skill.to_public(),
                                "status": "failed",
                                "image_count": run.image_count,
                                "confidence": run.confidence,
                                "reason": decision.get("reason") or "",
                                "reply": exc.message,
                                "steps": list(trace.steps),
                                "options": [],
                                "tasks": [],
                                "requires_image": False,
                                "demo": False,
                                "rule_hit": rule_hit,
                                "outputs": outputs,
                                "jobs": plan.get("jobs") or [],
                                "error_code": exc.code,
                                "selection_revision": plan["selection_revision"],
                                "selection_fingerprint": plan.get("selection_fingerprint"),
                                "target_id": plan.get("target_id"),
                                "canvas_id": run.canvas_id,
                            },
                        }
                    )
                    return
                run.status = "completed"
                run.task_ids = [item["id"] for item in tasks]
                step = trace.finish(
                    "dispatch",
                    detail=f"已提交 {len(tasks)} 个生成任务" if tasks else "没有可提交的任务",
                    status="done" if tasks else "skipped",
                )
            else:
                step = trace.finish("dispatch", detail="等待用户确认后提交", status="skipped")
            yield _sse({"event": "step", "step": dict(step)})
        else:
            trace.finish("dispatch", detail="尚未提交", status="skipped")

        run.steps = list(trace.steps)
        run.updated_at = utcnow()
        await db.commit()

        assistant = await _append_message(
            db,
            session.id,
            user.id,
            "assistant",
            _reply_text(decision, normalized),
            attachments=[
                {
                    "type": "skill_run",
                    "run_id": run.id,
                    "skill": skill.to_public(),
                    "status": run.status,
                    "steps": list(trace.steps),
                    "image_count": run.image_count,
                    "confidence": run.confidence,
                    "reason": decision.get("reason") or "",
                    "options": options,
                    "requires_image": bool(decision.get("requires_image")),
                    "task_ids": run.task_ids,
                    "rule_hit": rule_hit,
                    "outputs": outputs,
                                "jobs": plan.get("jobs") or [],
                    "selection_revision": plan["selection_revision"],
                    "selection_fingerprint": plan.get("selection_fingerprint"),
                    "target_id": plan.get("target_id"),
                    "canvas_id": run.canvas_id,
                }
            ],
        )
        await db.commit()

        # 记下这条 assistant 消息的 id：确认方案后要把它的附件快照回写成
        # 「已完成 + 选了哪个方案」，否则刷新页面会看到一张还能再点的确认卡，
        # 用户会以为刚才那次确认根本没生效。存在 run.input 里，不动表结构。
        run.input = {**(run.input or {}), "result_message_id": assistant.id}
        await db.commit()

        yield _sse(
            {
                "event": "result",
                "result": {
                    "run_id": run.id,
                    "message_id": assistant.id,
                    "user_message_id": user_message.id,
                    "skill": skill.to_public(),
                    "status": run.status,
                    "image_count": run.image_count,
                    "confidence": run.confidence,
                    "reason": decision.get("reason") or "",
                    "reply": assistant.content,
                    "steps": list(trace.steps),
                    "options": options,
                    "tasks": tasks,
                    "requires_image": bool(decision.get("requires_image")),
                    "demo": False,
                    "rule_hit": rule_hit,
                    "outputs": outputs,
                                "jobs": plan.get("jobs") or [],
                    "selection_revision": plan["selection_revision"],
                    "selection_fingerprint": plan.get("selection_fingerprint"),
                    "target_id": plan.get("target_id"),
                    "canvas_id": run.canvas_id,
                },
            }
        )


async def confirm_run(
    db: AsyncSession,
    user: User,
    run_id: str,
    option_id: str,
    selection_fingerprint: str = "",
) -> dict[str, Any]:
    """用户选定方案后执行（服务端凭 run_id 重建任务，不信任前端回传的计划）。

    :param selection_fingerprint: 客户端按**当前**选区重算的指纹。
        必须由客户端算并回传——拿服务端存的值和它自己比等于永远通过，
        用户在确认前又挪了选区/改了指令，旧计划就会被错误执行。
        为空表示调用方没有做校验（仅内部调用），此时退化为用存库选区自检。
    """
    run = (
        await db.execute(select(SkillRun).where(SkillRun.id == run_id))
    ).scalar_one_or_none()
    if run is None:
        raise AppError(ErrorCode.NOT_FOUND, "这次分析记录已失效，重新说一次需求就好")
    if run.user_id != user.id:
        raise AppError(ErrorCode.FORBIDDEN, "无权操作该记录")
    if run.status == "completed" and run.task_ids:
        # 幂等：重复点确认不重复建任务。顺手补一次附件回写，
        # 让历史数据（改动前确认的那些）刷新后也能显示「已选择」。
        await _sync_result_attachment(
            db, run, str((run.plan or {}).get("chosen_option_id") or "") or None
        )
        await db.commit()
        return {"run_id": run.id, "status": run.status, "task_ids": run.task_ids, "tasks": []}

    if run.status not in {"confirm", "preview"}:
        raise AppError(ErrorCode.TASK_STATE_CONFLICT, "这份计划已失效或正在提交，请刷新查看")

    options = run.options or []
    chosen = next((item for item in options if item.get("id") == option_id), None)
    if chosen is None:
        raise AppError(ErrorCode.VALIDATION_ERROR, "这个方案已经失效，重新说一次需求就好")

    # 计划必须仍然对应当前选区：选区在确认前被改过，旧结论就不能再执行
    expected = str((run.plan or {}).get("selection_fingerprint") or "")
    provided = str(selection_fingerprint or "").strip()
    if provided:
        actual = provided
    else:
        stored_selection = (run.input or {}).get("selection") or {}
        actual = ops_module.selection_fingerprint(stored_selection.get("regions"))
    if expected and actual != expected:
        raise AppError(
            ErrorCode.TASK_STATE_CONFLICT,
            "选区在确认前变了，这次分析已经作废，重新说一次需求就好",
        )

    plan = {**(run.plan or {})}
    option_plan = chosen.get("plan") or {}
    if option_plan.get("ops") is not None:
        plan["ops"] = option_plan["ops"]
    if option_plan.get("jobs") is not None:
        plan["jobs"] = option_plan["jobs"]
    plan["variants"] = int(option_plan.get("variants") or plan.get("variants") or 1)
    plan["intent"] = option_plan.get("intent") or plan.get("intent")
    plan["image_count"] = int(chosen.get("image_count") or plan.get("image_count") or 1)
    # 记下选了哪个方案：附件回写要用它，幂等重放时也靠它避免把 A 改写成 B
    plan["chosen_option_id"] = option_id

    previous_status = run.status
    claim = await db.execute(update(SkillRun).where(SkillRun.id == run.id, SkillRun.status.in_(("confirm", "preview"))).values(status="dispatching"))
    if claim.rowcount != 1:
        raise AppError(ErrorCode.TASK_STATE_CONFLICT, "这份计划正在提交，请稍后查看")
    run.plan = plan
    await db.commit()
    try:
        tasks = await _dispatch(db, user, run, plan, plan.get("ops") or [])
    except AppError:
        run.status = previous_status
        await db.commit()
        raise
    run.status = "completed"
    run.task_ids = [item["id"] for item in tasks]
    run.image_count = plan["image_count"]
    run.plan = plan
    run.updated_at = utcnow()
    await _sync_result_attachment(db, run, option_id)
    await db.commit()
    return {
        "run_id": run.id,
        "status": run.status,
        "task_ids": run.task_ids,
        "tasks": tasks,
    }


async def _sync_result_attachment(
    db: AsyncSession, run: SkillRun, option_id: str | None = None
) -> None:
    """把「已确认」写回那条 assistant 消息的 skill_run 附件快照。

    附件是分析当时的快照，确认后如果不回写，刷新页面看到的仍然是
    ``status=confirm`` + ``task_ids=[]`` 的旧状态 —— 卡片又变成可点，
    用户会以为刚才那次确认没生效（真实费用是安全的，但信任感是崩的）。

    :param option_id: 用户选定的方案 id；为 None 时（幂等重放且没记录过）
        只回写状态与任务，不覆盖已有的 ``chosen_option_id``，避免把 A 改写成 B。

    只在方法内部延迟导入 ChatMessage：`chat_service` 反向依赖本模块，
    顶层导入会形成循环。
    """
    from app.models.chat import ChatMessage

    message_id = str((run.input or {}).get("result_message_id") or "").strip()
    if not message_id:
        return
    message = (
        await db.execute(select(ChatMessage).where(ChatMessage.id == message_id))
    ).scalar_one_or_none()
    if message is None:
        return

    attachments = list(message.attachments or [])
    touched = False
    for index, item in enumerate(attachments):
        if not isinstance(item, dict) or item.get("type") != "skill_run":
            continue
        if str(item.get("run_id") or "") != run.id:
            continue
        updated = {
            **item,
            "status": "completed",
            "task_ids": list(run.task_ids or []),
            "image_count": int(run.image_count),
            "jobs": (run.plan or {}).get("jobs") or [],
        }
        if option_id:
            updated["chosen_option_id"] = option_id
        attachments[index] = updated
        touched = True
    if not touched:
        return
    # JSON 列必须整体重新赋值，原地改 dict 不会被 SQLAlchemy 标记为脏
    message.attachments = attachments


async def _dispatch(
    db: AsyncSession,
    user: User,
    run: SkillRun,
    plan: dict[str, Any],
    ops: list[dict[str, Any]],
    *,
    keep: tuple[Any, ...] = (),
) -> list[dict[str, Any]]:
    """按计划创建生成任务并立即开始执行。"""
    from app.services import batch_service, task_service
    from app.services.intent_plan import invalid
    jobs = plan.get("jobs") or []
    if not jobs:
        raise invalid("计划已过期，需要重新分析")
    selection = (run.input or {}).get("selection") or {}
    asset_id = plan.get("asset_id") or selection.get("asset_id")
    asset = await asset_service.get_asset(db, user, str(asset_id)) if asset_id else None
    mask_url = None
    if selection.get("mask_asset_id"):
        mask_asset = await asset_service.get_asset(db, user, selection["mask_asset_id"])
        mask_url = mask_asset.url
    prices = [await generate_service.resolve_cost(db, "generate" if job["output_kind"] == "generate" and not job.get("use_reference", bool(asset)) else "edit") for job in jobs]
    await batch_service.preflight(db, user.id, len(jobs), sum(prices))
    # Persist the plan before quota operations (which can roll back).
    await db.commit()
    dispatch_id = new_id()
    created = []
    try:
        for job in jobs:
            extra = {"skill_run_id": run.id, "batch_index": job["index"], "batch_total": len(jobs), "batch_label": job["label"], "pool_batch_id": dispatch_id, "pool_task_id": str(job["index"]), "pool_batch_total": len(jobs), "output_kind": job["output_kind"], "region_indexes": job["region_indexes"], "preserve_outside": job["preserve_outside"], "planned_output": True}
            kwargs = dict(prompt=job["prompt"], model="gpt-image-2", size=str(plan.get("size") or "1024x1024"), session_id=run.session_id, canvas_id=run.canvas_id, idempotency_key=f"intent:{run.id}:{dispatch_id}:{job['index']}", extra=extra)
            if job["output_kind"] == "generate" and not job.get("use_reference", bool(asset)):
                task, is_new = await generate_service.create_image_task(db, user.id, quality="standard", n=1, **kwargs)
            else:
                if asset is None:
                    raise AppError(ErrorCode.VALIDATION_ERROR, "缺少原图，请重新选择图片")
                # The uploaded mask can contain sibling regions. Each output gets its own mask.
                task, is_new = await generate_service.create_edit_task(db, user.id, base_image_url=asset.url, mask_url=mask_url if job["ops"] else None, edit_ops=job["ops"], **kwargs)
            created.append((task.id, is_new, {"id": task.id, "type": task.type, "status": task.status, "prompt": task.prompt, "cost": task.cost, "image_count": 1, "index": job["index"], "label": job["label"]}))
    except AppError:
        for obj in (run, *keep):
            await db.refresh(obj)
        for task_id, is_new, _ in created:
            if is_new:
                await task_service.fail_and_refund(db, task_id, ErrorCode.TASK_STATE_CONFLICT.value, "本批次未能完整提交，额度已退回，请重新提交")
        raise
    for task_id, is_new, _ in created:
        if is_new:
            _spawn_run(task_id)
    return [payload for _, _, payload in created]


_BACKGROUND: set[asyncio.Task[None]] = set()


def _spawn_run(task_id: str) -> None:
    """后台执行生成任务（流式响应里拿不到 BackgroundTasks，这里自己管引用）。"""
    task = asyncio.create_task(generate_service.run_task(task_id))
    _BACKGROUND.add(task)
    task.add_done_callback(_BACKGROUND.discard)


def _guess_size(selection: dict[str, Any]) -> str:
    """按底图比例挑一个上游支持的尺寸（缺省 1024x1024）。"""
    width = int(selection.get("width") or 0)
    height = int(selection.get("height") or 0)
    if width <= 0 or height <= 0:
        return "1024x1024"
    ratio = width / height
    if ratio > 1.2:
        return "1536x1024"
    if ratio < 0.83:
        return "1024x1536"
    return "1024x1024"


async def _append_message(
    db: AsyncSession,
    session_id: str,
    user_id: str,
    role: str,
    content: str,
    attachments: list[Any] | None = None,
):
    """直接写消息（避免与 chat_service 形成循环导入）。"""
    from app.models.chat import ChatMessage

    message = ChatMessage(
        id=new_id(),
        session_id=session_id,
        user_id=user_id,
        role=role,
        content=content,
        attachments=attachments or [],
    )
    db.add(message)
    await db.flush()
    return message


def list_skills() -> list[dict[str, Any]]:
    """对外暴露 Skill 声明（前端据此展示编排规则，证明执行未偏离）。"""
    return [skill.to_public() for skill in SKILLS.values()]
