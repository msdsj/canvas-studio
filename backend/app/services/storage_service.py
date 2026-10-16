"""本地存储服务：图片落盘、缩略图生成、对外 URL。

目录结构：`{storage_dir}/{user_id}/{yyyy}/{mm}/{uuid}.png`，缩略图在 `.../thumb/{uuid}.jpg`。
"""
from __future__ import annotations

import io
from datetime import datetime
from pathlib import Path

from PIL import Image

from app.config import settings
from app.utils.ids import new_id
from app.utils.logging import get_logger

logger = get_logger("app.storage")

THUMB_MAX = (400, 400)


def storage_root() -> Path:
    """返回存储根目录（确保存在）。"""
    root = Path(settings.storage_dir)
    root.mkdir(parents=True, exist_ok=True)
    return root


def public_url(relative_path: str) -> str:
    """把相对路径拼成对外 URL。"""
    return f"{settings.storage_public_base.rstrip('/')}/{relative_path.lstrip('/')}"


def _relative_dir(user_id: str) -> Path:
    """构造用户 + 年月子目录。"""
    now = datetime.utcnow()
    return Path(user_id) / f"{now:%Y}" / f"{now:%m}"


def image_size(data: bytes) -> tuple[int, int]:
    """读取图片宽高。"""
    try:
        with Image.open(io.BytesIO(data)) as img:
            return img.width, img.height
    except Exception:  # noqa: BLE001
        return 0, 0


def make_thumbnail(data: bytes) -> bytes:
    """生成 JPEG 缩略图字节。"""
    try:
        with Image.open(io.BytesIO(data)) as img:
            img = img.convert("RGB")
            img.thumbnail(THUMB_MAX)
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=82)
            return buf.getvalue()
    except Exception:  # noqa: BLE001
        logger.warning("缩略图生成失败，返回空字节")
        return b""


def save_image(user_id: str, data: bytes, ext: str = "png") -> dict:
    """保存图片与缩略图，返回 {rel_path,url,thumb_rel,thumb_url,width,height,size}。"""
    rel_dir = _relative_dir(user_id)
    abs_dir = storage_root() / rel_dir
    abs_dir.mkdir(parents=True, exist_ok=True)
    thumb_dir = abs_dir / "thumb"
    thumb_dir.mkdir(parents=True, exist_ok=True)

    name = f"{new_id()}.{ext.lstrip('.')}"
    abs_path = abs_dir / name
    abs_path.write_bytes(data)

    width, height = image_size(data)
    thumb_bytes = make_thumbnail(data)
    thumb_rel = str(rel_dir / "thumb" / f"{Path(name).stem}.jpg")
    if thumb_bytes:
        (storage_root() / thumb_rel).write_bytes(thumb_bytes)

    rel_path = str(rel_dir / name)
    return {
        "rel_path": rel_path,
        "url": public_url(rel_path),
        "thumb_rel": thumb_rel if thumb_bytes else "",
        "thumb_url": public_url(thumb_rel) if thumb_bytes else "",
        "width": width,
        "height": height,
        "size": len(data),
    }


def save_bytes(relative_path: str, data: bytes) -> str:
    """按给定相对路径保存字节，返回对外 URL。"""
    abs_path = storage_root() / relative_path
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    abs_path.write_bytes(data)
    return public_url(relative_path)


def cleanup_temp_files(max_age_hours: int = 24) -> int:
    """清理临时目录中过期文件（定时任务调用，返回清理数量）。"""
    import time

    tmp_dir = storage_root() / "tmp"
    if not tmp_dir.exists():
        return 0
    cutoff = time.time() - max_age_hours * 3600
    removed = 0
    for path in tmp_dir.rglob("*"):
        if path.is_file() and path.stat().st_mtime < cutoff:
            try:
                path.unlink()
                removed += 1
            except OSError:
                continue
    return removed
