"""对话路由 `/api/chat/*`（含 SSE 消息流）。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.deps import get_current_user
from app.models.skill import SkillRun
from app.models.user import User
from app.schemas.chat import (
    ChatAnalyzeRequest,
    ChatComposeRequest,
    ChatConfirmRequest,
    BatchDeleteRequest,
    ChatMessageCreateRequest,
    ChatMessageOut,
    ChatSessionCreateRequest,
    ChatSessionOut,
    ChatSessionUpdateRequest,
)
from app.services import chat_service, compose_service, skills
from app.utils.errors import envelope
from app.utils.pagination import normalize_page, paginated

router = APIRouter(prefix="/api/chat", tags=["chat"])

# SSE 必须禁掉中间层缓冲：否则步骤事件会被攒到最后一次性吐出，
# 用户看到的是「一直转圈，然后突然全出来」，思考链路就白做了。
_SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


@router.get("/sessions")
async def list_sessions(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    canvas_id: str | None = Query(default=None),
) -> dict:
    """列出会话。"""
    sessions = await chat_service.list_sessions(db, user.id, canvas_id)
    return envelope([ChatSessionOut.model_validate(s).model_dump() for s in sessions])


@router.post("/sessions")
async def create_session(
    payload: ChatSessionCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """新建会话（可选同时开一张干净画布）。"""
    session = await chat_service.create_session(
        db, user.id, payload.canvas_id, payload.title, new_canvas=payload.new_canvas
    )
    await db.commit()
    return envelope(ChatSessionOut.model_validate(session).model_dump())


@router.get("/sessions/{session_id}")
async def get_session(
    session_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """获取会话（含绑定的画布 id，前端据此加载对应画布）。"""
    session = await chat_service.get_session(db, user.id, session_id)
    return envelope(ChatSessionOut.model_validate(session).model_dump())


@router.patch("/sessions/{session_id}")
async def update_session(
    session_id: str,
    payload: ChatSessionUpdateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """重命名会话 / 重新绑定画布。"""
    session = await chat_service.update_session(
        db, user.id, session_id, payload.title, payload.canvas_id
    )
    await db.commit()
    return envelope(ChatSessionOut.model_validate(session).model_dump())


@router.delete("/sessions/{session_id}")
async def delete_session(
    session_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """删除会话。"""
    await chat_service.delete_session(db, user.id, session_id)
    await db.commit()
    return envelope({})


@router.get("/sessions/{session_id}/messages")
async def list_messages(
    session_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=50, ge=1, le=100),
) -> dict:
    """分页查询会话消息。"""
    page, size = normalize_page(page, size)
    rows, total = await chat_service.list_messages(db, user.id, session_id, page, size)
    items = [ChatMessageOut.model_validate(r).model_dump() for r in rows]
    return envelope(paginated(items, total, page, size))


@router.delete("/messages/{message_id}")
async def delete_message(
    message_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """删除单条消息（软删）。"""
    await chat_service.delete_message(db, user.id, message_id)
    await db.commit()
    return envelope({"deleted": message_id})


@router.post("/messages/batch-delete")
async def batch_delete_messages(
    payload: BatchDeleteRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """批量删除消息（「全选」后一次清掉）。"""
    count = await chat_service.delete_messages(db, user.id, payload.ids)
    await db.commit()
    return envelope({"deleted": count})


@router.post("/analyze")
async def analyze(
    payload: ChatAnalyzeRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """需求分析中转站：实时吐判定步骤，必要时停下来等用户选方案。

    返回 SSE：
    - `{"event":"step","step":{...}}` 每一步的状态（running / done / skipped）
    - `{"event":"result","result":{...}}` 最终结论（run_id / 产出数量 / 任务 / 待选方案）
    """
    await chat_service.get_session(db, user.id, payload.session_id)  # 先校验归属
    selection = payload.selection.model_dump() if payload.selection else None
    return StreamingResponse(
        skills.stream_analysis(
            user=user,
            session_id=payload.session_id,
            content=payload.content,
            selection=selection,
            canvas_id=payload.canvas_id,
            auto_execute=payload.auto_execute,
        ),
        media_type="text/event-stream",
        headers=_SSE_HEADERS,
    )


@router.post("/compose")
async def compose(
    payload: ChatComposeRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """纯生图全链路：需求分析 → 歧义澄清 → 方案推导 → 最终提示词 → 生图。

    SSE 事件：
    - `{"event":"step","step":{id,title,detail,status,elapsed_ms,items[]}}` 全链路思考
    - `{"event":"result","result":{status,reply,final_prompt,options,tasks,...}}`
      status ∈ direct / clarify / unconfigured / failed
    """
    await chat_service.get_session(db, user.id, payload.session_id)
    selection = payload.selection.model_dump() if payload.selection else None
    return StreamingResponse(
        compose_service.stream_compose(
            user=user,
            session_id=payload.session_id,
            content=payload.content,
            canvas_id=payload.canvas_id,
            image_refs=payload.image_refs,
            selection=selection,
            model=payload.model,
            allow_degraded=payload.allow_degraded,
        ),
        media_type="text/event-stream",
        headers=_SSE_HEADERS,
    )


@router.post("/runs/{run_id}/confirm")
async def confirm_run(
    run_id: str,
    payload: ChatConfirmRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """按用户选定的方案执行（服务端凭 run_id 重建任务，不信任客户端回传的计划）。

    两条链路共用这个入口，按 run 的 skill_id 分流：
    - `image_compose`：澄清方案的提示词直接建任务；
    - 其它：画布框选编辑的 ops 计划。
    """
    run = (
        await db.execute(select(SkillRun).where(SkillRun.id == run_id))
    ).scalar_one_or_none()
    if run is not None and run.skill_id == compose_service.SKILL_COMPOSE:
        result = await compose_service.confirm_compose(db, user, run_id, payload.option_id)
        return envelope(result)

    result = await skills.confirm_run(
        db, user, run_id, payload.option_id, payload.selection_fingerprint
    )
    return envelope(result)


@router.get("/skills")
async def list_skills(user: User = Depends(get_current_user)) -> dict:
    """暴露 Skill 声明（步骤与编排规则），用于前端展示「AI 按什么规则执行」。"""
    return envelope({"skills": skills.list_skills()})


@router.post("/messages")
async def send_message(
    payload: ChatMessageCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """发送消息 → SSE 流式回复（经网关；demo 时模拟）。"""
    session = await chat_service.get_session(db, user.id, payload.session_id)
    _, ref_id, cost = await chat_service.prepare_turn(
        db, user.id, session, payload.content, payload.image_refs
    )
    gateway_payload = await chat_service.build_payload(db, session.id, payload.content)
    return StreamingResponse(
        chat_service.stream_and_finalize(session.id, user.id, ref_id, cost, gateway_payload),
        media_type="text/event-stream",
    )
