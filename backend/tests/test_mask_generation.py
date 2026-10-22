"""测试图片编辑 mask 生成逻辑。"""
import io
from PIL import Image
import pytest

from app.services.generate_service import _render_ops_mask
from app.services.edit_ops import EditOp
from app.services.edit_ops import region_to_pixels


def _mask(base_bytes, regions):
    return _render_ops_mask(base_bytes, [EditOp(region=region) for region in regions])


def test_render_union_mask_single_region():
    """测试单个区域的 mask 生成。"""
    # 创建 100x100 的测试图片
    img = Image.new("RGB", (100, 100), color="white")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    base_bytes = buf.getvalue()

    # 归一化区域：中心 50% 区域
    regions = [{"x": 0.25, "y": 0.25, "w": 0.5, "h": 0.5}]

    mask_bytes = _mask(base_bytes, regions)
    mask = Image.open(io.BytesIO(mask_bytes)).convert("RGBA")

    # 验证尺寸一致
    assert mask.size == (100, 100)

    # 验证 alpha 通道：中心透明（0），边缘不透明（255）
    alpha = mask.getchannel("A")
    # 中心点应该透明
    assert alpha.getpixel((50, 50)) == 0, "中心区域应该透明（需要编辑）"
    # 四角应该不透明
    assert alpha.getpixel((10, 10)) == 255, "区域外应该不透明（保持不变）"
    assert alpha.getpixel((90, 90)) == 255, "区域外应该不透明（保持不变）"


def test_render_union_mask_multiple_regions():
    """测试多个区域合并为一个 mask。"""
    img = Image.new("RGB", (100, 100), color="white")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    base_bytes = buf.getvalue()

    # 两个不相交的区域：左上角和右下角
    regions = [
        {"x": 0.1, "y": 0.1, "w": 0.3, "h": 0.3},  # 左上
        {"x": 0.6, "y": 0.6, "w": 0.3, "h": 0.3},  # 右下
    ]

    mask_bytes = _mask(base_bytes, regions)
    mask = Image.open(io.BytesIO(mask_bytes)).convert("RGBA")
    alpha = mask.getchannel("A")

    # 左上区域中心点应该透明
    x1, y1, w1, h1 = region_to_pixels(regions[0], 100, 100)
    center1 = (x1 + w1 // 2, y1 + h1 // 2)
    assert alpha.getpixel(center1) == 0, "左上区域应该透明"

    # 右下区域中心点应该透明
    x2, y2, w2, h2 = region_to_pixels(regions[1], 100, 100)
    center2 = (x2 + w2 // 2, y2 + h2 // 2)
    assert alpha.getpixel(center2) == 0, "右下区域应该透明"

    # 中心点（两个区域之间）应该不透明
    assert alpha.getpixel((50, 50)) == 255, "区域外应该不透明"


def test_render_union_mask_edge_cases():
    """测试边界情况：全图和空区域。"""
    img = Image.new("RGB", (100, 100), color="white")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    base_bytes = buf.getvalue()

    # 全图区域
    regions = [{"x": 0, "y": 0, "w": 1, "h": 1}]
    mask_bytes = _mask(base_bytes, regions)
    mask = Image.open(io.BytesIO(mask_bytes)).convert("RGBA")
    alpha = mask.getchannel("A")

    # 全图透明
    assert alpha.getpixel((50, 50)) == 0, "全图区域应该全透明"
    assert alpha.getpixel((10, 10)) == 0, "全图区域应该全透明"

    # 空区域列表
    mask_bytes = _mask(base_bytes, [])
    mask = Image.open(io.BytesIO(mask_bytes)).convert("RGBA")
    alpha = mask.getchannel("A")

    # 全图不透明
    assert alpha.getpixel((50, 50)) == 255, "无区域时应该全不透明"


def test_mask_format_compatibility():
    """验证生成的 mask 符合 OpenAI edits API 规范。"""
    img = Image.new("RGB", (100, 100), color="white")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    base_bytes = buf.getvalue()

    regions = [{"x": 0.2, "y": 0.2, "w": 0.6, "h": 0.6}]
    mask_bytes = _mask(base_bytes, regions)

    # 验证是有效的 PNG
    assert mask_bytes.startswith(b"\x89PNG\r\n\x1a\n"), "mask 必须是有效的 PNG 格式"

    # 验证是 RGBA 格式
    mask = Image.open(io.BytesIO(mask_bytes))
    assert mask.mode == "RGBA", "mask 必须包含 alpha 通道"

    # 验证 alpha 只有 0 或 255（无半透明）
    alpha = mask.getchannel("A")
    alpha_values = set(alpha.getdata())
    assert alpha_values.issubset({0, 255}), "alpha 通道应该只包含 0（透明）或 255（不透明）"
