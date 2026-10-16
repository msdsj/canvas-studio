"""画布路由 `/api/canvases/*` 与 `/api/share/*`。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.schemas.canvas import CanvasOut, CanvasUpdateRequest
from app.services import canvas_service
from app.utils.errors import envelope

router = APIRouter(prefix="/api", tags=["canvases"])


@router.get("/canvases/{canvas_id}")
async def get_canvas(
    canvas_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """获取画布（含 state）。"""
    canvas = await canvas_service.get_canvas(db, user.id, canvas_id)
    return envelope(CanvasOut.model_validate(canvas).model_dump())


@router.patch("/canvases/{canvas_id}")
async def update_canvas(
    canvas_id: str,
    payload: CanvasUpdateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """自动保存画布。"""
    canvas = await canvas_service.update_canvas(
        db, user.id, canvas_id, payload.name, payload.state, payload.thumbnail
    )
    await db.commit()
    return envelope({"updated_at": canvas.updated_at})


@router.delete("/canvases/{canvas_id}")
async def delete_canvas(
    canvas_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """删除画布。"""
    await canvas_service.delete_canvas(db, user.id, canvas_id)
    await db.commit()
    return envelope({})


@router.post("/canvases/{canvas_id}/share")
async def share_canvas(
    canvas_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """开启只读分享。"""
    token, url = await canvas_service.share_canvas(db, user.id, canvas_id)
    await db.commit()
    return envelope({"share_token": token, "url": url})


@router.delete("/canvases/{canvas_id}/share")
async def unshare_canvas(
    canvas_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """关闭分享。"""
    await canvas_service.unshare_canvas(db, user.id, canvas_id)
    await db.commit()
    return envelope({})


@router.get("/canvases/{canvas_id}/export")
async def export_canvas(
    canvas_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    format: str = Query(default="json"),
) -> Response:
    """导出画布（png | json）。"""
    fmt = "png" if format == "png" else "json"
    content, media_type, filename = await canvas_service.export_canvas(db, user.id, canvas_id, fmt)
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/share/{token}")
async def get_shared_canvas(token: str, db: AsyncSession = Depends(get_db)) -> dict:
    """公开只读分享页（脱敏）。"""
    canvas = await canvas_service.get_shared(db, token)
    return envelope(
        {
            "id": canvas.id,
            "name": canvas.name,
            "state": canvas.state,
            "thumbnail_url": canvas.thumbnail_url,
            "updated_at": canvas.updated_at,
        }
    )
