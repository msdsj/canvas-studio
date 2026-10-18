"""后台系统配置路由（读写 / 掩码 / 推送网关 / 连通性测试）。"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.deps import require_admin
from app.models.user import User
from app.schemas.config import ConfigTestRequest
from app.services import audit_service, config_service
from app.services.gateway_client import gateway_client
from app.utils.errors import AppError, ErrorCode, envelope

router = APIRouter(
    prefix="/api/admin/config", tags=["admin"], dependencies=[Depends(require_admin)]
)


@router.get("")
async def get_config(db: AsyncSession = Depends(get_db)) -> dict:
    """读取全部配置（secret 掩码）。"""
    return envelope({"items": await config_service.get_all(db, masked=True)})


@router.put("")
async def update_config(
    payload: dict[str, Any] = Body(...),
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict:
    """批量更新配置并推送网关即生效。"""
    updated = await config_service.set_many(db, payload, admin.id)
    await audit_service.log(
        db,
        action="config_update",
        actor=admin,
        target_type="config",
        detail={"updated": updated},
    )
    await db.commit()
    await config_service.push_to_gateway(db)
    return envelope({"updated": updated})


@router.post("/test")
async def test_config(payload: ConfigTestRequest) -> dict:
    """连通性测试（区分 proxy / upstream）。"""
    if payload.target not in {"text", "image", "llm", "pool", "proxy"}:
        raise AppError(ErrorCode.VALIDATION_ERROR, "target 必须是 text|image|llm|pool|proxy")
    result = await gateway_client.config_test(payload.target)
    return envelope(result)
