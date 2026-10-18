"""润色保真测试：纯函数，不连数据库、不连网络。

覆盖：
1. 主体词必须保留（模型/本地都不许把「橘猫」改掉）；
2. 「帮我」这类口语被删，但主体与用户文字不变；
3. 长度上限（各模式倍数与绝对增量）；
4. 「更简洁」不删括号里的说明，但删得掉「参考图2」这种元信息；
5. 模型偏离原意时被守退回退到原文，并在 notes 里写明。
"""
from __future__ import annotations

import pytest

from app.services import polish_service as ps


# ---------------------------------------------------------------------------
# 1. 主体词保留
# ---------------------------------------------------------------------------


def test_guard_keeps_subject_tokens() -> None:
    """local_variants 不能让主体消失。"""
    original = "一只橘猫在窗台上晒太阳"
    for mode in ("auto", "specific", "professional", "fix"):
        for item in ps.local_variants(original, "composer", mode, 2):
            assert "橘猫" in item["text"], (mode, item["text"])
            assert "窗台" in item["text"], (mode, item["text"])


def test_guard_detects_model_losing_subject() -> None:
    """模型把「橘猫」换成「猫」并丢光窗台信息时，判定偏离并回退原文。"""
    original = "一只橘猫在窗台上晒太阳，水彩风格"
    candidate = "一只猫，暖调侧逆光，浅景深，35mm，胶片颗粒，低饱和"
    guarded, notes = ps._fidelity_guard(original, candidate, mode="specific")
    assert guarded == original
    assert any("回退" in note for note in notes)


def test_guard_allows_added_render_params() -> None:
    """只补技术参数、主体全在，应放行并标记「未改动」。"""
    original = "一只橘猫在窗台上晒太阳"
    candidate = "一只橘猫在窗台上晒太阳，柔和的侧光，平视视角"
    guarded, notes = ps._fidelity_guard(original, candidate, mode="specific")
    assert guarded == candidate
    assert any("未改动" in note for note in notes)


def test_guard_keeps_user_text_and_numbers() -> None:
    """品牌名 / 数字 / 画幅这些字面内容不许被替换。"""
    original = "为「山茶」咖啡馆做海报，标语写「慢慢来」，3:4 竖版，中文手写字体"
    candidate = "为咖啡馆做海报，标语写「快一点」，4:3 横版，英文无衬线字体"
    guarded, _notes = ps._fidelity_guard(original, candidate, mode="auto")
    assert guarded == original


def test_guard_rejects_rewritten_copy() -> None:
    """只改了一句文案（慢慢来 → 快点来），其余都对，也必须回退。"""
    original = "为「山茶」咖啡馆做海报，标语写「慢慢来」，3:4 竖版"
    candidate = "为「山茶」咖啡馆做海报，标语写「快点来」，3:4 竖版"
    guarded, notes = ps._fidelity_guard(original, candidate, mode="auto")
    assert guarded == original
    assert any("回退" in note for note in notes)


def test_guard_keeps_appended_render_params_when_fillers_removed() -> None:
    """去掉「帮我」再补技术参数：不判偏离，也不把新增参数丢掉。"""
    original = "帮我做一个极简的咖啡杯壁纸"
    candidate = "帮我做一个极简的咖啡杯壁纸，高清细节，构图完整"
    guarded, notes = ps._fidelity_guard(original, candidate, mode="auto")
    assert "咖啡杯" in guarded and "窗" not in guarded
    assert len(guarded) >= len(original)
    assert any("守护" in note for note in notes)


# ---------------------------------------------------------------------------
# 2. 口语清理不伤主体
# ---------------------------------------------------------------------------


def test_cleanup_drops_oral_filler_keeps_subject() -> None:
    original = "帮我做一个极简的咖啡杯壁纸"
    cleaned = ps._cleanup(original)
    assert "帮我" not in cleaned
    assert "咖啡杯" in cleaned and "壁纸" in cleaned


def test_cleanup_keeps_degree_words() -> None:
    """「稍微」「有点」是用户对强度的要求，不能被当废话删掉。"""
    original = "把背景稍微调暗一点，天空有点发灰"
    cleaned = ps._cleanup(original)
    assert "稍微" in cleaned
    assert "有点" in cleaned


# ---------------------------------------------------------------------------
# 3. 长度上限
# ---------------------------------------------------------------------------


def test_length_cap_values() -> None:
    original = "一只橘猫在窗台"
    assert ps._length_cap(original, "auto") == max(int(7 * 1.25) + 40, 7)
    assert ps._length_cap(original, "specific") == max(int(7 * 1.6) + 80, 7)
    # specific 的额度必须大于 auto
    assert ps._length_cap(original, "specific") > ps._length_cap(original, "auto")


def test_guard_truncates_overlong_candidate() -> None:
    original = "一只橘猫在窗台上晒太阳"
    candidate = original + "，" + "极浅景深与胶片颗粒和柔和逆光" * 12
    guarded, notes = ps._fidelity_guard(original, candidate, mode="auto")
    assert len(guarded) <= ps._length_cap(original, "auto")
    assert "橘猫" in guarded
    assert any("截断" in note or "回退" in note for note in notes)


def test_normalize_variants_caps_model_output() -> None:
    original = "一只橘猫在窗台上晒太阳"
    raw = [
        {
            "label": "更具体",
            "text": original + "，" + "浅景深暖调柔光" * 40,
            "notes": ["补了光线"],
        }
    ]
    items = ps._normalize_variants(raw, original, "specific", 2)
    assert len(items) == 1
    assert len(items[0]["text"]) <= ps._length_cap(original, "specific")


# ---------------------------------------------------------------------------
# 4. 简洁模式与括号
# ---------------------------------------------------------------------------


def test_concise_keeps_parentheses_note() -> None:
    original = "做一个蓝色渐变海报（左上角留出二维码位置）"
    items = ps.local_variants(original, "composer", "concise", 1)
    assert "二维码" in items[0]["text"]


def test_concise_strips_meta_parentheses_only() -> None:
    original = "换成更亮的版本（参考图2）"
    cleaned = ps._cleanup(original, strip_parentheses=True)
    assert "参考图" not in cleaned
    assert "更亮" in cleaned


def test_vague_word_kept_and_expanded() -> None:
    """评价词不能被整词替换掉，必须保留原词再加说明。"""
    original = "做一个高级感的香水海报"
    items = ps.local_variants(original, "composer", "auto", 1)
    text = items[0]["text"]
    assert "高级" in text
    assert "香水" in text


# ---------------------------------------------------------------------------
# 5. 模型偏离 → 守卫回退
# ---------------------------------------------------------------------------


def test_normalize_variants_rolls_back_on_divergence() -> None:
    original = "一只橘猫在窗台上晒太阳"
    raw = [
        {
            "label": "更具体",
            "text": "一只柴犬在沙滩上奔跑，逆光剪影，暖橘色调，颗粒质感",
            "notes": ["补了光线"],
        }
    ]
    items = ps._normalize_variants(raw, original, "specific", 2)
    assert items, "至少应该保留一个回退版本"
    assert items[0]["text"] == original
    assert any("回退" in note for note in items[0]["notes"])


def test_normalize_variants_notes_report_fidelity() -> None:
    original = "一只橘猫在窗台上晒太阳"
    raw = [{"label": "更具体", "text": original + "，柔和侧光", "notes": ["补光线"]}]
    items = ps._normalize_variants(raw, original, "specific", 2)
    assert items[0]["text"] == original + "，柔和侧光"
    assert items[0]["notes"][0].startswith("已守护")


def test_notes_are_bounded() -> None:
    """notes 最多 3 条，前端只显示一行，不能让守卫说明把它挤爆。"""
    original = "一只橘猫在窗台上晒太阳"
    raw = [{"label": "更具体", "text": original + "，柔和侧光", "notes": ["a", "b", "c", "d"]}]
    items = ps._normalize_variants(raw, original, "specific", 2)
    assert len(items[0]["notes"]) <= 3


@pytest.mark.parametrize("mode", ["auto", "specific", "professional", "concise", "fix", "english"])
def test_local_variants_non_empty(mode: str) -> None:
    items = ps.local_variants("一只橘猫在窗台上晒太阳", "composer", mode, 2)
    assert items
    assert all(item["text"].strip() for item in items)
    assert all(len(item["notes"]) <= 3 for item in items)
