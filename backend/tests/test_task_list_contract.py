"""`_LIST_COLUMNS` 与 `GenerationTaskOut` 的字段契约。

背景（2026-10-21 事故）
---------------------
为降低 16 并发下 ORM 实体化的开销，`task_service.list_tasks` 从
`select(GenerationTask)` 改成 `select(*_LIST_COLUMNS)` 并返回 `dict`。
列清单漏了 `idempotency_key`，导致 `GenerationTaskOut.model_validate` 抛
`ValidationError: idempotency_key Field required`，整个 `/api/generate/tasks`
返回 500 —— 而前端在不停轮询这个接口，等于列表页彻底不可用。

这类漂移是**静默**的：改列清单的人不会想到去读 schema。所以这里用测试把
两份定义锁在一起，任何一边加字段而另一边没跟上，测试立刻红。
"""
from __future__ import annotations

from sqlalchemy import inspect as sa_inspect

from app.models.generation import GenerationTask
from app.schemas.task import GenerationTaskOut
from app.services.task_service import _LIST_COLUMNS


def _columns_selected() -> set[str]:
    """把 `_LIST_COLUMNS` 里的 InstrumentedAttribute 还原成列名字集合。"""
    names: set[str] = set()
    for col in _LIST_COLUMNS:
        key = getattr(col, "key", None)
        assert key, f"_LIST_COLUMNS 里出现了非列对象：{col!r}"
        names.add(key)
    return names


def test_list_columns_cover_all_required_schema_fields() -> None:
    """必填字段必须全在列清单里，否则 `model_validate` 直接 500。"""
    required = {name for name, field in GenerationTaskOut.model_fields.items() if field.is_required()}
    missing = required - _columns_selected()
    assert not missing, (
        f"_LIST_COLUMNS 缺少必填字段 {sorted(missing)}；"
        "`GenerationTaskOut.model_validate` 会抛 ValidationError，/api/generate/tasks 将 500"
    )


def test_list_columns_are_real_model_columns() -> None:
    """列清单里的每一项都必须是 `GenerationTask` 的真实列（防拼写错误）。"""
    model_cols = set(sa_inspect(GenerationTask).columns.keys())
    unknown = _columns_selected() - model_cols
    assert not unknown, f"_LIST_COLUMNS 引用了模型里不存在的列：{sorted(unknown)}"


def test_params_column_is_kept() -> None:
    """`params` 是前端结果卡片的依赖（size/model/n/batch_*/region_indexes）。"""
    assert "params" in _columns_selected()
