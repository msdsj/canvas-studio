"""本地抠图服务：把框选区域从原图中精确抠出为「透明背景独立素材」。

设计原则
--------
1. **确定性优先**：抠图不重绘内容，逐像素保留原图主体，天然满足「仅修改选中区域、
   其余完全保留」的平台铁律；上游文生图会重绘像素，故不作为默认路径。
2. **零硬依赖**：纯 Pillow 即可工作；若环境装有 ``rembg`` / ``opencv-python``，
   自动升级为深度学习或 GrabCut 分割，质量更高（无需改任何调用方代码）。
3. **严格贴合选区**：处理范围严格限定在框选矩形内，绝不越界影响框外像素；
   后续仅做「向内收紧」（trim），不向外扩张。

三级策略（``strategy="auto"`` 时按序探测，失败自动降级）
-------------------------------------------------------
- ``rembg``   ：u2net 深度学习前景分割，质量最佳（需 ``pip install rembg``）
- ``grabcut`` ：OpenCV GrabCut 交互式分割（需 ``pip install opencv-python-headless``）
- ``chroma``  ：边缘采样背景色 + 自适应阈值，纯 Pillow 兜底（始终可用）
"""
from __future__ import annotations

import io
import statistics
from typing import Any

from PIL import Image, ImageChops, ImageFilter

from app.utils.logging import get_logger

logger = get_logger("app.cutout_service")

# 前景判定阈值：alpha 低于该值视为透明（用于 trim 与前景占比统计）
_ALPHA_EPSILON = 12
# 抠图前景占比低于该比例时，判定为「抠失败」，回退为纯选区裁剪
_MIN_FOREGROUND_RATIO = 0.01
# 边缘采样带宽（像素）
_EDGE_BAND = 2
# 边缘采样步长（降采样，控制聚类开销）
_EDGE_STEP = 2


def region_to_pixels(
    region: dict[str, Any], width: int, height: int
) -> tuple[int, int, int, int]:
    """归一化选区 → 像素矩形 ``(x, y, w, h)``，并夹取到图像范围内（绝不越界）。"""
    x = max(0, min(width - 1, round(float(region.get("x", 0)) * width)))
    y = max(0, min(height - 1, round(float(region.get("y", 0)) * height)))
    w = max(1, min(width - x, round(float(region.get("w", 1)) * width)))
    h = max(1, min(height - y, round(float(region.get("h", 1)) * height)))
    return x, y, w, h


# --------------------------------------------------------------------------- #
# 可选增强：rembg / OpenCV（存在即用，不存在静默降级）
# --------------------------------------------------------------------------- #
_REMBG_REMOVE: Any = None
_REMBG_PROBED = False
_CV2: Any = None
_CV2_PROBED = False


def _load_rembg() -> Any:
    """惰性加载 rembg（首次调用探测一次，避免重复 import 开销）。"""
    global _REMBG_REMOVE, _REMBG_PROBED
    if not _REMBG_PROBED:
        _REMBG_PROBED = True
        try:
            from rembg import remove  # type: ignore[import-not-found]

            _REMBG_REMOVE = remove
            logger.info("抠图增强已启用：rembg（深度学习前景分割）")
        except Exception:  # noqa: BLE001 - 可选依赖，缺失属正常
            _REMBG_REMOVE = None
    return _REMBG_REMOVE


def _load_cv2() -> Any:
    """惰性加载 OpenCV（首次调用探测一次）。"""
    global _CV2, _CV2_PROBED
    if not _CV2_PROBED:
        _CV2_PROBED = True
        try:
            import cv2  # type: ignore[import-not-found]

            _CV2 = cv2
            logger.info("抠图增强已启用：OpenCV GrabCut")
        except Exception:  # noqa: BLE001 - 可选依赖，缺失属正常
            _CV2 = None
    return _CV2


def available_strategies() -> list[str]:
    """返回当前环境实际可用的抠图策略（供后台配置页展示）。"""
    names = ["chroma"]
    if _load_cv2() is not None:
        names.insert(0, "grabcut")
    if _load_rembg() is not None:
        names.insert(0, "rembg")
    return names


# --------------------------------------------------------------------------- #
# 策略实现
# --------------------------------------------------------------------------- #
def _cutout_rembg(crop: Image.Image) -> Image.Image | None:
    """rembg 深度学习分割（不可用时返回 None）。"""
    remove = _load_rembg()
    if remove is None:
        return None
    out = remove(crop.convert("RGB"))
    if not isinstance(out, Image.Image):
        return None
    return out.convert("RGBA")


def _cutout_grabcut(crop: Image.Image) -> Image.Image | None:
    """OpenCV GrabCut 分割（不可用或图像过小时返回 None）。"""
    cv2 = _load_cv2()
    if cv2 is None:
        return None
    try:
        import numpy as np  # type: ignore[import-not-found]
    except Exception:  # noqa: BLE001
        return None
    width, height = crop.size
    if width < 16 or height < 16:
        return None
    bgr = np.array(crop.convert("RGB"))[:, :, ::-1].copy()
    mask = np.zeros((height, width), np.uint8)
    inset_x = max(1, int(width * 0.06))
    inset_y = max(1, int(height * 0.06))
    rect = (inset_x, inset_y, max(1, width - inset_x * 2), max(1, height - inset_y * 2))
    bgd = np.zeros((1, 65), np.float64)
    fgd = np.zeros((1, 65), np.float64)
    cv2.grabCut(bgr, mask, rect, bgd, fgd, 5, cv2.GC_INIT_WITH_RECT)
    alpha = np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0).astype("uint8")
    out = crop.convert("RGBA")
    out.putalpha(Image.fromarray(alpha, "L"))
    return out


def _cutout_chroma(crop: Image.Image) -> Image.Image:
    """边缘采样背景色 + 自适应阈值生成 alpha（纯 Pillow，始终可用）。

    思路：选区四边最外 2px 视为背景，聚类出 1-2 个背景色；每个像素取「到最近背景色
    的通道最大差」作为前景置信度，配合自适应阈值映射为 0/255 的软 alpha。
    """
    rgb = crop.convert("RGB")
    width, height = rgb.size
    samples = _edge_samples(rgb)
    backgrounds = _cluster_backgrounds(samples, k=2)

    dist: Image.Image | None = None
    for background in backgrounds:
        reference = Image.new("RGB", (width, height), background)
        diff = ImageChops.difference(rgb, reference)
        red, green, blue = diff.split()
        # 通道最大差（比欧氏距离更抗单通道噪声，且全为 C 实现，快）
        channel_dist = ImageChops.lighter(ImageChops.lighter(red, green), blue)
        dist = channel_dist if dist is None else ImageChops.darker(dist, channel_dist)
    if dist is None:  # pragma: no cover - samples 为空时才会走到
        return crop

    low, high = _adaptive_thresholds(samples, backgrounds)
    span = max(1, high - low)
    alpha = dist.point(
        lambda v: 0 if v <= low else (255 if v >= high else int((v - low) * 255 / span))
    )
    alpha = _denoise_alpha(alpha)
    out = crop.copy()
    out.putalpha(alpha)
    return out


_STRATEGY_ORDER: dict[str, tuple[str, ...]] = {
    "auto": ("rembg", "grabcut", "chroma"),
    "rembg": ("rembg", "chroma"),
    "grabcut": ("grabcut", "chroma"),
    "chroma": ("chroma",),
    # 上游生成透明背景的路径由编排层负责；本地兜底仍用 chroma，保证不空手而归
    "upstream": ("chroma",),
}


def _run_strategy(crop: Image.Image, name: str) -> Image.Image | None:
    """执行单个策略，异常不向外抛（视为该策略不可用）。"""
    try:
        if name == "rembg":
            return _cutout_rembg(crop)
        if name == "grabcut":
            return _cutout_grabcut(crop)
        return _cutout_chroma(crop)
    except Exception:  # noqa: BLE001 - 单策略失败即降级，不影响整体可用性
        logger.exception("抠图策略 %s 执行失败，尝试降级", name)
        return None


# --------------------------------------------------------------------------- #
# 工具函数
# --------------------------------------------------------------------------- #
def _edge_samples(rgb: Image.Image, band: int = _EDGE_BAND, step: int = _EDGE_STEP):
    """采集选区四边最外 ``band`` 像素作为背景样本。"""
    width, height = rgb.size
    pixels = rgb.load()
    band = max(1, min(band, height // 2, width // 2))
    step = max(1, step)
    rows = list(range(band)) + list(range(height - band, height))
    cols = list(range(band)) + list(range(width - band, width))
    samples: list[tuple[int, int, int]] = []
    for x in range(0, width, step):
        for y in rows:
            samples.append(pixels[x, y])
    for y in range(0, height, step):
        for x in cols:
            samples.append(pixels[x, y])
    return samples


def _median_color(colors: list[tuple[int, int, int]]) -> tuple[int, int, int]:
    """取颜色中位数（比均值更抗离群点）。"""
    return (
        int(statistics.median(c[0] for c in colors)),
        int(statistics.median(c[1] for c in colors)),
        int(statistics.median(c[2] for c in colors)),
    )


def _color_distance(a: tuple[int, int, int], b: tuple[int, int, int]) -> int:
    """颜色平方距离（比较用，无需开方）。"""
    return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2


def _cluster_backgrounds(
    samples: list[tuple[int, int, int]], k: int = 2
) -> list[tuple[int, int, int]]:
    """对边缘样本做轻量 k-means，兼容「纯色背景」与「双色/渐变背景」两种情况。"""
    if not samples:
        return [(0, 0, 0)]
    if k <= 1 or len(samples) < 8:
        return [_median_color(samples)]
    ordered = sorted(samples, key=lambda c: c[0] + c[1] + c[2])
    centers = [ordered[0], ordered[-1]]
    for _ in range(3):
        buckets: list[list[tuple[int, int, int]]] = [[] for _ in range(k)]
        for color in samples:
            nearest = min(range(k), key=lambda i: _color_distance(color, centers[i]))
            buckets[nearest].append(color)
        next_centers = [
            _median_color(bucket) if bucket else centers[i] for i, bucket in enumerate(buckets)
        ]
        if next_centers == centers:
            break
        centers = next_centers
    return centers


def _adaptive_thresholds(
    samples: list[tuple[int, int, int]], backgrounds: list[tuple[int, int, int]]
) -> tuple[int, int]:
    """按边缘噪声水平自适应定阈值：背景越干净，阈值越紧。"""
    if not samples:
        return 12, 40
    distances = sorted(
        min(_color_distance(color, bg) for bg in backgrounds) ** 0.5 for color in samples
    )
    index = min(len(distances) - 1, int(len(distances) * 0.95))
    noise = distances[index]
    low = max(10.0, noise * 1.8)
    high = max(low * 2.0, low + 22.0)
    return int(min(low, 90)), int(min(high, 180))


def _denoise_alpha(alpha: Image.Image, size: int = 3) -> Image.Image:
    """形态学开运算去孤立噪点 + 闭运算填内部空洞。"""
    width, height = alpha.size
    if width < size * 2 or height < size * 2:
        return alpha
    opened = alpha.filter(ImageFilter.MinFilter(size)).filter(ImageFilter.MaxFilter(size))
    return opened.filter(ImageFilter.MaxFilter(size)).filter(ImageFilter.MinFilter(size))


def _feather_alpha(alpha: Image.Image, radius: int) -> Image.Image:
    """边缘羽化：让抠图结果与原图背景衔接更自然。"""
    if radius < 1:
        return alpha
    return alpha.filter(ImageFilter.GaussianBlur(radius))


def _guard_alpha(sprite: Image.Image, crop: Image.Image) -> Image.Image:
    """兜底保护：前景占比过低说明抠图失败，回退为「纯选区裁剪」而非交付空白素材。"""
    total = sprite.width * sprite.height
    if total <= 0:
        return crop
    histogram = sprite.getchannel("A").histogram()
    foreground = sum(histogram[_ALPHA_EPSILON:])
    ratio = foreground / total
    if ratio >= _MIN_FOREGROUND_RATIO:
        return sprite
    logger.warning("抠图前景占比仅 %.2f%%，回退为纯选区裁剪", ratio * 100)
    return crop


def _trim_sprite(sprite: Image.Image, pad_ratio: float) -> Image.Image:
    """向内收紧到主体包围盒（去掉四周全透明留白），并保留少量透明边距。"""
    mask = sprite.getchannel("A").point(lambda v: 255 if v > _ALPHA_EPSILON else 0)
    bbox = mask.getbbox()
    if not bbox:
        return sprite
    left, top, right, bottom = bbox
    pad = int(round(min(right - left, bottom - top) * max(0.0, pad_ratio)))
    return sprite.crop(
        (
            max(0, left - pad),
            max(0, top - pad),
            min(sprite.width, right + pad),
            min(sprite.height, bottom + pad),
        )
    )


# --------------------------------------------------------------------------- #
# 对外主入口
# --------------------------------------------------------------------------- #
def extract_sprite(
    base_bytes: bytes,
    region: dict[str, Any],
    *,
    strategy: str = "auto",
    feather: bool = True,
    trim: bool = True,
    pad_ratio: float = 0.02,
) -> bytes:
    """把 ``region`` 指定区域从原图抠出为透明背景 PNG 素材字节。

    :param base_bytes: 原图字节（任意格式，内部统一按 RGBA 处理）
    :param region: 归一化选区 ``{x, y, w, h}``（相对原图宽高，取值 0-1）
    :param strategy: ``auto`` / ``rembg`` / ``grabcut`` / ``chroma``
    :param feather: 是否对 alpha 边缘羽化（更自然）
    :param trim: 是否向内收紧到主体包围盒
    :param pad_ratio: trim 时主体四周保留的透明边距（相对主体短边）
    :return: RGBA PNG 字节（透明背景，尺寸 = 收紧后的主体包围盒）
    """
    with Image.open(io.BytesIO(base_bytes)) as opened:
        source = opened.convert("RGBA")
    width, height = source.size
    x, y, w, h = region_to_pixels(region, width, height)
    crop = source.crop((x, y, x + w, y + h))

    order = _STRATEGY_ORDER.get(strategy, _STRATEGY_ORDER["chroma"])
    sprite: Image.Image | None = None
    for name in order:
        sprite = _run_strategy(crop, name)
        if sprite is not None:
            break
    if sprite is None:  # pragma: no cover - chroma 必然返回结果
        sprite = crop

    if feather:
        sprite.putalpha(_feather_alpha(sprite.getchannel("A"), max(1, round(min(crop.size) / 220))))
    sprite = _guard_alpha(sprite, crop)
    if trim:
        sprite = _trim_sprite(sprite, pad_ratio)

    buffer = io.BytesIO()
    sprite.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()
