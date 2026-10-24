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


class QuotaSeriesPoint(BaseModel):
    """用量趋势的一天（按服务器时区 +08:00 切天）。"""

    date: str
    consumed: int = 0
    granted: int = 0


class QuotaTypeStat(BaseModel):
    """按流水类型的分布。"""

    type: str
    count: int = 0
    #: 账本口径合计（消耗为负、入账为正）
    amount: int = 0
    #: 绝对发生额（画图表直接用，不用再取符号）
    abs_amount: int = 0


class QuotaSummaryOut(BaseModel):
    """用量页汇总。"""

    balance: int = 0
    total_granted: int = 0
    total_consumed: int = 0
    series: list[QuotaSeriesPoint] = Field(default_factory=list)
    by_type: list[QuotaTypeStat] = Field(default_factory=list)


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
