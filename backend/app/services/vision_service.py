"""Prepare owned local images for multimodal analysis without exposing storage URLs."""
from __future__ import annotations

import base64
import io
from typing import Any

from PIL import Image, ImageOps

from app.services import generate_service


def image_part(data: bytes) -> dict[str, Any]:
    with Image.open(io.BytesIO(data)) as source:
        image = ImageOps.exif_transpose(source).convert("RGBA")
        background = Image.new("RGBA", image.size, (255, 255, 255, 255))
        image = Image.alpha_composite(background, image).convert("RGB")
        image.thumbnail((1400, 1400))
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=88)
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{encoded}", "detail": "high"}}


def user_content(text: str, assets: list[Any], ops: list[dict[str, Any]] | None = None) -> Any:
    if not assets:
        return text
    parts: list[dict[str, Any]] = [{"type": "text", "text": text}]
    for index, asset in enumerate(assets):
        data, _ = generate_service._local_bytes(asset.url)
        parts.extend([{"type": "text", "text": f"参考图 {index + 1}（原图像素）"}, image_part(data)])
        if index == 0 and ops:
            from app.services import edit_ops
            parsed = edit_ops.normalize_ops(ops)
            guide = generate_service._render_ops_guide(data, parsed)
            parts.extend([{"type": "text", "text": "以下为同一原图的选区编号定位图；标注不是图像内容。"}, image_part(guide)])
    return parts
