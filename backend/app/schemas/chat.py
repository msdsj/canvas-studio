"""对话相关 Schema。"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from app.schemas.common import ORMModel


class ChatSessionCreateRequest(BaseModel):
    """新建会话请求。"""

    canvas_id: str | None = None
    title: str | None = Field(default=None, max_length=255)
    # 新建对话时同时开一张干净画布：对话与画布是 1:1 绑定的，
    # 只建会话不建画布会出现「新对话里还躺着上一轮图」的错位。
    new_canvas: bool = False


class ChatSessionUpdateRequest(BaseModel):
    """会话更新请求。"""

    title: str | None = Field(default=None, max_length=255)
    canvas_id: str | None = None


class ChatSelectionRegion(BaseModel):
    """一个选区（矩形或自由多边形）。"""

    index: int | None = None
    region: dict[str, float]
    path: list[dict[str, float]] | None = None
    prompt: str = ""
    handler: str = ""


class ChatSelection(BaseModel):
    """画布选区上下文：底图资产 + 若干选区。"""

    asset_id: str | None = None
    # 画笔/套索产生的掩码图资产 id：有掩码时编辑必须只作用于这块像素，
    # 否则用户精细涂抹的区域在上游会被忽略，变成整图重绘。
    mask_asset_id: str | None = None
    # 画布元素 id：与 canvas_id + revision 组成三元组，用于判断计划是否还有效
    target_id: str | None = None
    # 选区版本号：增删选区/改能力/改区域提示词都会 +1（平移缩放不动）
    revision: int = 0
    has_doodle: bool = False
    width: int = 0
    height: int = 0
    regions: list[ChatSelectionRegion] = Field(default_factory=list)


class ChatAnalyzeRequest(BaseModel):
    """需求分析请求（中转站）。"""

    session_id: str
    content: str = Field(min_length=1, max_length=8000)
    canvas_id: str | None = None
    selection: ChatSelection | None = None
    # false = 只出方案不执行（用于「先给我看看方案」）
    auto_execute: bool = True


class ChatComposeRequest(BaseModel):
    """纯生图全链路请求（需求分析 → 澄清 → 提示词 → 生图）。"""

    session_id: str
    content: str = Field(min_length=1, max_length=8000)
    canvas_id: str | None = None
    # 参考图资产 id（上传 / 粘贴进来的图片）
    image_refs: list[str] = Field(default_factory=list)
    selection: ChatSelection | None = None
    # 用户显式同意「未配置中转站时用本地模板先试一次」
    allow_degraded: bool = False
    # 生图模型：gpt-image-2（2.0）/ gpt-image-2.5（2.5）
    model: str | None = None


class ChatConfirmRequest(BaseModel):
    """确认某个方案并执行。"""

    option_id: str
    # 确认时的选区指纹：必须由客户端按当前选区重算并回传。
    # 服务端拿它和 run.plan 里的指纹比对——不能拿存的值和它自己比，
    # 那样等于永远通过，选区变了也照样执行旧计划。
    selection_fingerprint: str


class ChatSessionOut(ORMModel):
    """会话输出。"""

    id: str
    user_id: str
    canvas_id: str | None = None
    title: str
    created_at: datetime | None = None
    updated_at: datetime | None = None


class ChatMessageOut(ORMModel):
    """消息输出。"""

    id: str
    session_id: str
    user_id: str
    role: str
    content: str
    attachments: list[Any] = Field(default_factory=list)
    generation_task_id: str | None = None
    created_at: datetime | None = None


class ChatMessageCreateRequest(BaseModel):
    """发送消息（走 SSE）请求。"""

    session_id: str
    content: str = Field(min_length=1, max_length=8000)
    canvas_id: str | None = None
    image_refs: list[str] = Field(default_factory=list)


class ChatStreamChunk(BaseModel):
    """SSE 数据块。"""

    delta: str = ""
    done: bool = False
    demo: bool = False
    error_code: str | None = None


class BatchDeleteRequest(BaseModel):
    """批量删除（消息 / 素材共用这类入参）。"""

    ids: list[str] = Field(default_factory=list, max_length=200)
