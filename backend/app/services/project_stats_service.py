"""项目卡片统计：封面图、元素数、首个画布缩略图。

实现要点
--------
- 画布 `state` 是可能几十 MB 的 JSON（含 base64 图片），**不能读进 Python 解析**；
  这里用 SQLite JSON1（`json_each` / `json_extract`，3.38+ 内置）在 SQL 侧展开，
  元素计数一条 `GROUP BY` 出全部项目。
- 封面取「最新画布里最新的图片元素」：优先 `customData.assetId` 对应的资产缩略图，
  再退到 `customData.sourceUrl` / `link`（只认可本平台 `/static/` 地址，
  避免把用户填的外链当封面）。
- 三条 SQL 覆盖整页项目，不做「每个项目查一次」的 N+1。
"""
from __future__ import annotations

from typing import Any, Sequence

from sqlalchemy import func, select, true
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.asset import Asset
from app.models.canvas import Canvas

#: 封面候选行数上限：只影响封面挑选，不影响元素计数
MAX_COVER_CANDIDATES = 400

EMPTY_CARD: dict[str, Any] = {"cover_url": None, "item_count": 0, "thumbnail_url": None}


def _static_url(raw: Any) -> str | None:
    """只接受本平台静态资源地址，避免把用户填的外链当封面。"""
    if not isinstance(raw, str):
        return None
    value = raw.strip()
    if value.startswith("/static/"):
        return value
    if value.startswith(("http://", "https://")) and "/static/" in value:
        return value
    return None


async def _asset_urls(db: AsyncSession, asset_ids: Sequence[str]) -> dict[str, str]:
    """批量取资产可展示 URL（优先缩略图）。"""
    ids = [asset_id for asset_id in dict.fromkeys(asset_ids) if asset_id]
    if not ids:
        return {}
    rows = (
        await db.execute(
            select(Asset.id, Asset.thumb_url, Asset.url).where(Asset.id.in_(ids))
        )
    ).all()
    return {str(row[0]): str(row[1] or row[2]) for row in rows if (row[1] or row[2])}


async def project_cards(
    db: AsyncSession, project_ids: Sequence[str]
) -> dict[str, dict[str, Any]]:
    """批量算项目卡片数据，返回 `{project_id: {cover_url, item_count, thumbnail_url}}`。"""
    ids = list(dict.fromkeys(project_ids))
    cards: dict[str, dict[str, Any]] = {pid: dict(EMPTY_CARD) for pid in ids}
    if not ids:
        return cards

    elements = func.json_each(Canvas.state, "$.elements").table_valued("value", "key")
    element_value = elements.c.value
    alive = func.coalesce(func.json_extract(element_value, "$.isDeleted"), 0) == 0

    # 1) 元素数（不含 Excalidraw 软删除的墓碑元素）
    count_rows = (
        await db.execute(
            select(Canvas.project_id, func.count())
            .select_from(Canvas)
            .join(elements, true())
            .where(Canvas.project_id.in_(ids), alive)
            .group_by(Canvas.project_id)
        )
    ).all()
    for project_id, count in count_rows:
        cards[project_id]["item_count"] = int(count or 0)

    # 2) 首个画布缩略图（原实现每项目查一次 → N+1，这里合并为一条）
    thumb_rows = (
        await db.execute(
            select(Canvas.project_id, Canvas.thumbnail_url)
            .where(Canvas.project_id.in_(ids), Canvas.thumbnail_url.is_not(None))
            .order_by(Canvas.created_at.asc())
        )
    ).all()
    for project_id, thumb in thumb_rows:
        if cards[project_id]["thumbnail_url"] is None:
            cards[project_id]["thumbnail_url"] = thumb

    # 3) 封面：最新画布里最新的图片元素
    asset_id = func.json_extract(element_value, "$.customData.assetId")
    source_url = func.json_extract(element_value, "$.customData.sourceUrl")
    link = func.json_extract(element_value, "$.link")
    candidates = (
        await db.execute(
            select(Canvas.project_id, asset_id, source_url, link)
            .select_from(Canvas)
            .join(elements, true())
            .where(
                Canvas.project_id.in_(ids),
                alive,
                func.json_extract(element_value, "$.type") == "image",
            )
            .order_by(Canvas.updated_at.desc(), elements.c.key.desc())
            .limit(MAX_COVER_CANDIDATES)
        )
    ).all()

    urls = await _asset_urls(db, [row[1] for row in candidates if row[1]])
    for project_id, asset, source, link_url in candidates:
        if cards[project_id]["cover_url"]:
            continue
        cards[project_id]["cover_url"] = (
            urls.get(str(asset)) if asset else None
        ) or _static_url(source) or _static_url(link_url)
    return cards
