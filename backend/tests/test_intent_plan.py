"""Model output plans must preserve requested outputs and the owned selection."""
from __future__ import annotations

from copy import deepcopy

import pytest

from app.services.edit_handlers import BUILTIN_INDEX, EditHandler
from app.services.intent_plan import MAX_OUTPUTS, validate_model_plan
from app.utils.errors import AppError, ErrorCode


@pytest.fixture
def selection():
    # Non-contiguous indices catch accidental position-based region matching.
    return {
        "asset_id": "owned-image",
        "regions": [
            {"index": 3, "region": {"x": 0.1, "y": 0.2, "w": 0.2, "h": 0.3}, "path": None},
            {
                "index": 7,
                "region": {"x": 0.5, "y": 0.4, "w": 0.25, "h": 0.35},
                "path": [{"x": 0.51, "y": 0.41}, {"x": 0.72, "y": 0.45}, {"x": 0.6, "y": 0.7}],
            },
            {"index": 11, "region": {"x": 0.2, "y": 0.6, "w": 0.15, "h": 0.2}, "path": None},
        ],
    }


def job(*indexes: int, kind: str = "composite", handler: str | None = None, label: str = "独立输出"):
    handler = handler or ("cutout" if kind == "sprite" else "restyle")
    return {
        "label": label,
        "output_kind": kind,
        "prompt": f"按照用户要求处理{label}，严格保留未指定修改的原图内容。",
        "ops": [{"region_index": index, "handler": handler, "prompt": f"精确处理区域 {index}"} for index in indexes],
    }


def plan(*jobs, **overrides):
    return {"image_count": len(jobs), "jobs": list(jobs), "confidence": 0.95, "reason": "依据用户要求的独立输出拆分", **overrides}


def validate(raw, selection):
    return validate_model_plan(raw, selection, dict(BUILTIN_INDEX))


def test_edit_and_extraction_remain_two_independent_outputs(selection):
    result = validate(plan(job(3, label="更换底色"), job(7, kind="sprite", label="独立透明素材")), selection)

    assert result["image_count"] == 2
    assert result["intent"] == "mixed"
    edited, extracted = result["jobs"]
    assert edited["output_kind"] == "composite"
    assert edited["preserve_outside"] is True
    assert extracted["output_kind"] == "sprite"
    assert extracted["region_indexes"] == [7]
    assert extracted["preserve_outside"] is False
    assert edited["region_indexes"] == [3]
    assert [item["index"] for item in result["jobs"]] == [1, 2]


def test_three_separate_edits_are_not_collapsed_by_handler_or_selection(selection):
    raw = plan(*(job(3, label=f"方案 {number}") for number in range(1, 4)))
    result = validate(raw, selection)

    assert result["image_count"] == 3
    assert len(result["jobs"]) == 3
    assert [item["label"] for item in result["jobs"]] == ["方案 1", "方案 2", "方案 3"]
    assert all(item["region_indexes"] == [3] for item in result["jobs"])


def test_one_output_can_apply_multiple_regions_without_multiplying_count(selection):
    result = validate(plan(job(3, 7, 11, label="在同一张图上统一修改")), selection)

    assert result["image_count"] == 1
    assert result["intent"] == "edit"
    assert result["jobs"][0]["region_indexes"] == [3, 7, 11]
    assert len(result["jobs"][0]["ops"]) == 3


def test_region_coordinates_and_lasso_path_come_from_original_selection(selection):
    before = deepcopy(selection)
    raw = plan(job(7))
    raw["jobs"][0]["ops"][0].update(region={"x": 0, "y": 0, "w": 1, "h": 1}, path=[])
    raw_before = deepcopy(raw)

    result = validate(raw, selection)

    op = result["jobs"][0]["ops"][0]
    assert op["index"] == 7
    assert op["region"] == before["regions"][1]["region"]
    assert op["path"] == before["regions"][1]["path"]
    assert selection == before
    assert raw == raw_before


def test_declared_custom_handler_is_supported_without_scenario_rules(selection):
    handlers = {**BUILTIN_INDEX, "custom_texture": EditHandler(id="custom_texture", label="自定义纹理", description="应用纹理")}
    result = validate_model_plan(plan(job(3, handler="custom_texture")), selection, handlers)

    assert result["jobs"][0]["handler"] == "custom_texture"
    assert result["jobs"][0]["ops"][0]["handler"] == "custom_texture"


@pytest.mark.parametrize("index", [1, 8, -1, "7", None])
def test_invented_or_noninteger_selection_index_is_rejected(selection, index):
    with pytest.raises(AppError) as error:
        validate(plan(job(index)), selection)
    assert error.value.code == ErrorCode.UPSTREAM_FORMAT_ERROR


def test_unknown_handler_is_rejected_instead_of_silently_restyling(selection):
    with pytest.raises(AppError) as error:
        validate(plan(job(3, handler="invented_capability")), selection)
    assert error.value.code == ErrorCode.UPSTREAM_FORMAT_ERROR


@pytest.mark.parametrize("image_count", [0, 1, 3, "2", None])
def test_output_count_must_match_independent_job_list(selection, image_count):
    with pytest.raises(AppError) as error:
        validate(plan(job(3), job(7), image_count=image_count), selection)
    assert error.value.code == ErrorCode.UPSTREAM_FORMAT_ERROR


@pytest.mark.parametrize("count", [0, MAX_OUTPUTS + 1])
def test_output_limit_is_enforced_without_truncating_user_request(selection, count):
    with pytest.raises(AppError) as error:
        validate(plan(*(job(3) for _ in range(count))), selection)
    assert error.value.code == ErrorCode.UPSTREAM_FORMAT_ERROR


def test_maximum_supported_output_count_is_preserved(selection):
    result = validate(plan(*(job(3, label=f"输出 {index}") for index in range(MAX_OUTPUTS))), selection)
    assert result["image_count"] == MAX_OUTPUTS
    assert len(result["jobs"]) == MAX_OUTPUTS


def test_model_authored_clarification_options_preserve_distinct_plans(selection):
    alternatives = [
        plan(job(3, 7), label="合并到同一张图", description="两处修改输出一张整图"),
        plan(job(3), job(7), label="各自单独生成", description="每处修改各输出一张整图"),
    ]
    result = validate(plan(job(3), needs_confirmation=True, question="合并还是分别输出？", options=alternatives), selection)

    assert result["needs_confirmation"] is True
    assert result["question"] == "合并还是分别输出？"
    assert [option["image_count"] for option in result["options"]] == [1, 2]
    assert [option["label"] for option in result["options"]] == ["合并到同一张图", "各自单独生成"]
    assert result["options"][0]["plan"]["jobs"][0]["region_indexes"] == [3, 7]
    assert len(result["options"][1]["plan"]["jobs"]) == 2


def test_invalid_clarification_plan_is_filtered_without_discarding_valid_choice(selection):
    alternatives = [plan(job(99), label="引用不存在区域"), plan(job(7, kind="sprite"), label="提取素材")]
    result = validate(plan(job(3), needs_confirmation=True, options=alternatives), selection)

    assert len(result["options"]) == 1
    assert result["options"][0]["label"] == "提取素材"
    assert result["options"][0]["plan"]["intent"] == "cutout"


@pytest.mark.parametrize("confidence", [0.0, 0.49])
def test_uncertain_model_decision_requires_confirmation(selection, confidence):
    result = validate(plan(job(3), confidence=confidence), selection)
    assert result["needs_confirmation"] is True
    assert result["question"]


@pytest.mark.parametrize("confidence", [float("nan"), float("inf"), "not a number"])
def test_nonfinite_or_invalid_confidence_is_rejected(selection, confidence):
    with pytest.raises(AppError):
        validate(plan(job(3), confidence=confidence), selection)


@pytest.mark.parametrize("kind,handler,indexes", [("composite", "cutout", [3]), ("sprite", "restyle", [3]), ("sprite", "cutout", [3, 7]), ("generate", "restyle", [3])])
def test_incompatible_output_shape_and_region_operations_are_rejected(selection, kind, handler, indexes):
    with pytest.raises(AppError) as error:
        validate(plan(job(*indexes, kind=kind, handler=handler)), selection)
    assert error.value.code == ErrorCode.UPSTREAM_FORMAT_ERROR


def test_fresh_generation_without_source_image_is_valid():
    result = validate(plan(job(kind="generate", label="全新创作")), {"asset_id": None, "regions": []})
    assert result["intent"] == "generate"
    assert result["jobs"][0]["ops"] == []


def test_edit_without_source_image_fails_before_dispatch(selection):
    selection["asset_id"] = None
    with pytest.raises(AppError) as error:
        validate(plan(job(3)), selection)
    assert error.value.code == ErrorCode.VALIDATION_ERROR


@pytest.mark.parametrize("field,value", [("options", {"unexpected": "object"}), ("observations", None), ("observations", 7), ("observations", {"private": "ignored"})])
def test_optional_model_fields_cannot_crash_plan_validation(selection, field, value):
    # Optional fields can be ignored or rejected, but never cause raw TypeError.
    try:
        result = validate(plan(job(3), **{field: value}), selection)
    except AppError as error:
        assert error.code == ErrorCode.UPSTREAM_FORMAT_ERROR
    else:
        assert isinstance(result["options"], list)
        assert isinstance(result["observations"], list)


@pytest.mark.parametrize("kind", [[], {}, None, True])
def test_malformed_output_type_is_a_visible_plan_error(selection, kind):
    item = job(3)
    item["output_kind"] = kind
    with pytest.raises(AppError):
        validate(plan(item), selection)


@pytest.mark.parametrize("count", [True, 1.0])
def test_output_count_requires_integer_not_boolean_or_float(selection, count):
    with pytest.raises(AppError):
        validate(plan(job(3), image_count=count), selection)


def test_boolean_region_id_cannot_alias_region_one(selection):
    selection["regions"][0]["index"] = 1
    with pytest.raises(AppError):
        validate(plan(job(True)), selection)


@pytest.mark.parametrize("value", [{"instruction": "edit region"}, ["edit region"], True])
def test_structured_values_cannot_be_coerced_into_execution_prompts(selection, value):
    item = job(3)
    item["prompt"] = value
    with pytest.raises(AppError):
        validate(plan(item), selection)
