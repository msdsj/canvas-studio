"""额度相关 Schema。"""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from app.schemas.common import ORMModel


class PricesOut(BaseModel):
    """单价表。"""

    image_standard: int
    image_hd: int
    edit: int
    chat: int


class QuotaAccountOut(BaseModel):
    """额度账户视图。"""

    balance: int
    threshold_pct: int
    total_granted: int
    prices: PricesOut


class QuotaTransactionOut(ORMModel):
    """额度流水输出。"""

    id: str
    user_id: str
    type: str
    amount: int
    status: str
    ref_id: str
    operator_id: str | None = None
    balance_after: int
    note: str
    created_at: datetime | None = None


class AdminQuotaAdjustRequest(BaseModel):
    """管理员额度调整请求。"""

    mode: str = Field(description="increase | decrease | set")
    amount: int = Field(ge=0)
    note: str = Field(default="", max_length=512)
