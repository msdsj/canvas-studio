"""额度流水模型（账本，唯一写入方 = backend）。"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.utils.ids import new_id, utcnow


class QuotaTransaction(Base):
    """额度流水：预扣(processing)→确认(success)/回滚(refunded)。"""

    __tablename__ = "quota_transactions"
    __table_args__ = (
        UniqueConstraint("ref_id", "type", name="uq_quota_ref_type"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id"), index=True, nullable=False
    )
    type: Mapped[str] = mapped_column(String(32), index=True, nullable=False)
    # 团队共享额度池流水：非空表示这一笔动的是 `teams.balance`，
    # 而 `user_id` 仍然记录发起人，用于「谁花了团队的额度」的对账。
    team_id: Mapped[str | None] = mapped_column(String(36), index=True, nullable=True)
    amount: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(16), index=True, default="processing")
    ref_id: Mapped[str] = mapped_column(String(64), index=True, default="")
    operator_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    balance_after: Mapped[int] = mapped_column(Integer, default=0)
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
