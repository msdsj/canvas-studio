"""参数自适应：场景画幅、显式覆盖、编辑跟随原图。

这几条是本轮需求里最容易「看着实现、实际跑偏」的部分：
只要有人把兜底改回 1024x1024，或让 params 里的 size 覆盖执行参数，
对应用例就会红。
"""
from __future__ import annotations

from app.services import param_service


def test_desktop_wallpaper_is_landscape():
    result = param_service.infer("帮我做一张电脑壁纸，赛博朋克城市")
    assert result["aspect"] == "16:9"
    assert result["source"] == "scene"
    assert result["scene"] == "desktop_wallpaper"
    assert result["width"] > result["height"]


def test_phone_wallpaper_is_portrait():
    result = param_service.infer("手机壁纸，星空下的雪山")
    assert result["aspect"] == "9:16"
    assert result["height"] > result["width"]


def test_avatar_is_square():
    result = param_service.infer("生成一个应用图标")
    assert result["aspect"] == "1:1"
    assert result["source"] == "scene"


def test_poster_is_three_by_four():
    result = param_service.infer("秋季露营海报，暖色调")
    assert result["aspect"] == "3:4"


def test_generic_prompt_never_defaults_to_square():
    result = param_service.infer("一只橘猫在窗台")
    assert result["aspect"] != "1:1"
    assert result["source"] == "fallback"


def test_explicit_ratio_beats_scene():
    result = param_service.infer("电脑壁纸，但我要 9:16 竖版构图")
    assert result["aspect"] == "9:16"
    assert result["source"] == "text"


def test_explicit_pixels_are_mapped_to_supported_size():
    result = param_service.infer("尺寸 2000x1000 的横幅")
    assert result["source"] == "text"
    # 上游只支持三档，必须映射而不是把 2000x1000 直接发上去
    assert result["size"] in {"1024x1024", "1536x1024", "1024x1536"}
    assert result["width"] > result["height"]


def test_manual_override_wins():
    result = param_service.infer("随便画点什么", override_aspect="16:9")
    assert result["aspect"] == "16:9"
    assert result["source"] == "manual"


def test_edit_follows_source_image():
    result = param_service.infer("把背景换成海边", kind="edit", source_image=(800, 1200))
    assert result["locked"] is True
    assert result["size"] == "1024x1536"
    assert result["height"] > result["width"]


def test_quality_and_strength_are_extracted():
    assert param_service.infer("4K 高清，轻微提亮")["quality"] == "hd"
    assert param_service.infer("轻微提亮")["style_strength"] < 0.5
    assert param_service.infer("强烈重塑画面")["style_strength"] > 0.8
