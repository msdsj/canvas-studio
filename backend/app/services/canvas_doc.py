"""画布文档合并：元素级增量 patch 与 LWW 合并。

为什么不直接上 CRDT
-------------------
Excalidraw 的场景是「一个元素数组 + appState + files」。真实协作冲突几乎都发生在
**同一个元素**上（两人同时拖同一个矩形），而不同元素之间本来就是独立的。因此
按元素 id 做 last-write-wins 就能覆盖 99% 的场景，代价却远低于引入 Yjs
（多一个 Node 协同服务、一套二进制协议、一次数据模型迁移）。

已知取舍
--------
- **同一元素并发修改**：后到者赢，先到者的那次修改会丢。UI 上通过「正在编辑」
  的远程高亮降低概率，但不做自动合并（自动合并两个不同的旋转角度只会更奇怪）。
- **appState 不合并**：视口、缩放、选中状态是「每个人的视角」，合并会导致
  两个人互相抢镜头。
- **删除是墓碑**：删掉的 id 会记进墓碑集合，后续再收到该 id 的更新会被忽略，
  否则会出现「删了又自己长回来」的灵异现象。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable

from app.utils.errors import AppError, ErrorCode

#: 单次 patch 允许的最大元素数：防止恶意/异常客户端一次推整份文档
MAX_PATCH_ELEMENTS = 800
#: 墓碑上限：超过后淘汰最早的（正常协作里不会删到这么多）
MAX_TOMBSTONES = 5000


def empty_state() -> dict[str, Any]:
    """空场景。"""
    return {"elements": [], "appState": {}, "files": {}}


def normalize_state(raw: Any) -> dict[str, Any]:
    """把任意来源的场景收敛成合法结构。

    `state` 是用户可写的 JSON 列，历史数据里出现过 None / 字符串 / 缺字段，
    读出来必须先归一，否则合并逻辑会在 `.get` 上炸。
    """
    if not isinstance(raw, dict):
        return empty_state()
    elements = raw.get("elements")
    app_state = raw.get("appState")
    files = raw.get("files")
    return {
        "elements": [item for item in elements if isinstance(item, dict) and item.get("id")]
        if isinstance(elements, list)
        else [],
        "appState": app_state if isinstance(app_state, dict) else {},
        "files": files if isinstance(files, dict) else {},
    }


def _index(elements: Iterable[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """元素 id → 元素。"""
    result: dict[str, dict[str, Any]] = {}
    for element in elements:
        element_id = str(element.get("id") or "")
        if element_id:
            result[element_id] = element
    return result


def _element_version(element: dict[str, Any]) -> int:
    """取元素自带的版本号（Excalidraw 的 `version` / `versionNonce`）。

    两者都可能缺失或不是数字，统一兜底为 0；比较时用 `>=` 让「没有版本号」的
    客户端也能覆盖旧值，而不是永远被服务端旧数据压住。
    """
    for key in ("version", "versionNonce"):
        value = element.get(key)
        if isinstance(value, (int, float)):
            return int(value)
    return 0


def diff_states(previous: Any, current: Any) -> dict[str, list]:
    """对比两份完整场景，算出增量 patch（客户端在断线重连后补发时用）。"""
    before = _index(normalize_state(previous)["elements"])
    after = _index(normalize_state(current)["elements"])
    added = [after[key] for key in after if key not in before]
    updated = [
        after[key]
        for key in after
        if key in before and _element_version(after[key]) > _element_version(before[key])
    ]
    deleted = [key for key in before if key not in after]
    return {"added": added, "updated": updated, "deleted": deleted}


@dataclass
class Patch:
    """一次增量修改。"""

    added: list[dict[str, Any]] = field(default_factory=list)
    updated: list[dict[str, Any]] = field(default_factory=list)
    deleted: list[str] = field(default_factory=list)
    #: 视口等客户端本地状态，服务端只透传不合并
    app_state: dict[str, Any] | None = None

    @property
    def is_empty(self) -> bool:
        return not (self.added or self.updated or self.deleted or self.app_state)

    def to_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "added": self.added,
            "updated": self.updated,
            "deleted": self.deleted,
        }
        if self.app_state is not None:
            payload["app_state"] = self.app_state
        return payload


def parse_patch(raw: Any) -> Patch:
    """校验并构造 patch。

    客户端传上来的任何东西都不可信：元素必须是带 id 的 dict，deleted 必须是字符串，
    总量有上限。校验失败抛 422，而不是让半个 patch 生效。
    """
    if not isinstance(raw, dict):
        raise AppError(ErrorCode.VALIDATION_ERROR, "同步数据格式不对")
    added = raw.get("added") or []
    updated = raw.get("updated") or []
    deleted = raw.get("deleted") or []
    if not isinstance(added, list) or not isinstance(updated, list) or not isinstance(deleted, list):
        raise AppError(ErrorCode.VALIDATION_ERROR, "同步数据格式不对")

    total = len(added) + len(updated) + len(deleted)
    if total > MAX_PATCH_ELEMENTS:
        raise AppError(ErrorCode.VALIDATION_ERROR, "这次同步的内容太多了，稍后再试")

    def _clean(items: list[Any]) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            element_id = str(item.get("id") or "").strip()
            if not element_id:
                continue
            result.append({**item, "id": element_id})
        return result

    app_state = raw.get("app_state")
    return Patch(
        added=_clean(added),
        updated=_clean(updated),
        deleted=[str(item) for item in deleted if isinstance(item, str) and item],
        app_state=app_state if isinstance(app_state, dict) else None,
    )


def apply_patch(
    state: dict[str, Any],
    patch: Patch,
    tombstones: set[str] | None = None,
) -> dict[str, Any]:
    """把 patch 应用到场景上，返回新场景（不修改入参）。

    - added：不存在则追加，已存在则按版本号覆盖（处理「补发」场景）；
    - updated：只改已存在的元素；对已删除元素（墓碑）的更新直接丢弃；
    - deleted：从元素表移除并登记墓碑。
    """
    base = normalize_state(state)
    elements = _index(base["elements"])
    tombstones = tombstones if tombstones is not None else set()

    for element in patch.added:
        element_id = element["id"]
        if element_id in tombstones:
            continue
        existing = elements.get(element_id)
        if existing is None or _element_version(element) >= _element_version(existing):
            elements[element_id] = element

    for element in patch.updated:
        element_id = element["id"]
        if element_id in tombstones:
            continue
        existing = elements.get(element_id)
        if existing is None:
            # 客户端认为「更新」，服务端没有：当作新增，否则这次修改会凭空消失
            elements[element_id] = element
            continue
        if _element_version(element) >= _element_version(existing):
            elements[element_id] = element

    for element_id in patch.deleted:
        elements.pop(element_id, None)
        tombstones.add(element_id)

    merged = {
        "elements": list(elements.values()),
        "appState": dict(base["appState"]),
        "files": dict(base["files"]),
    }
    if patch.app_state is not None:
        # appState 是「共享的画布设置」（背景色等），但视口类字段由各端自己维护；
        # 这里只接受非视口字段，避免两个人互相抢镜头。
        for key, value in patch.app_state.items():
            if key in _VIEWPORT_KEYS:
                continue
            merged["appState"][key] = value
    return merged


#: 不参与服务端合并的 appState 字段（各端视角独立）
_VIEWPORT_KEYS = frozenset(
    {
        "scrollX",
        "scrollY",
        "zoom",
        "selectedElementIds",
        "selectedGroupIds",
        "editingElement",
        "cursorButton",
        "activeTool",
    }
)


def trim_tombstones(tombstones: set[str], limit: int = MAX_TOMBSTONES) -> None:
    """墓碑超限时清空（极端情况下的兜底，避免内存无界增长）。"""
    if len(tombstones) > limit:
        tombstones.clear()
