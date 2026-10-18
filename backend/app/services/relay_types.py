"""L1 传输层的类型、失败分类策略与预算常量（唯一来源）。

分层职责
--------
- **L1 传输层**（本文件 + `relay_service` + `relay_chain`）：只解决「拿到一段可用的
  文本」。响应体形态不对 / 超时 / 5xx 都在这一层处理；
- **L2 语义层**（`compose_service._call_json` + `plan_validator`）：只解决「这段文本
  能不能解析成合规 JSON」。两层不合并——否则「上游返回网页」会被当成「模型输出格式
  不对」而重复消耗纠错预算（见架构 ADR-1）。

铁律
----
1. `FailureKind` **永远不进用户文案**，只进日志与 `data.reason`；用户文案由前端按
   `reason → i18n key` 映射（ADR-7）。本文件里的 `USER_MESSAGES` 只是兜底，且不含
   `json` / `html` / `HTTP` / 异常类名 / 堆栈。
2. 预算常量必须硬编码在此处，不允许调用方覆盖——否则上游持续故障时会把上游额度
   打穿（ADR-3）。
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any

from app.utils.errors import ErrorCode


class FailureKind(str, Enum):
    """上游失败的分类。判定顺序见 `relay_service._classify_failure()`（严格按 ADR-2）。"""

    OK = "ok"
    CONNECT_ERROR = "connect_error"
    BAD_URL = "bad_url"
    TIMEOUT = "timeout"
    AUTH_ERROR = "auth_error"
    HTTP_5XX = "http_5xx"
    HTTP_4XX = "http_4xx"
    EMPTY_BODY = "empty_body"
    HTML_BODY = "html_body"
    NOT_JSON = "not_json"
    TRUNCATED_JSON = "truncated_json"
    NOT_OBJECT = "not_object"
    UPSTREAM_REFUSED = "upstream_refused"
    TRUNCATED_OUTPUT = "truncated_output"
    NO_CONTENT = "no_content"
    BUDGET_EXHAUSTED = "budget_exhausted"


# --------------------------------------------------------------------------- #
# 预算（硬上限，任一触发即终止整链）
# --------------------------------------------------------------------------- #
#: 链上最多几个模型（primary + 模型链 ≤2 + 跨 provider ≤1）
MAX_MODELS = 4
#: 最多几次 HTTP 调用。5 次 ≈「primary 重试 1 次 + fb1 重试 1 次 + fb2 试 1 次」
MAX_HTTP_CALLS = 5
#: 同一模型内最多重试几次（=1 表示最多 2 次调用）
MAX_RETRY_PER_MODEL = 1
#: 从第一次调用开始计时，到点即终止（秒）。防止 5 × 90s = 7.5 分钟的白屏
TOTAL_DEADLINE_S = 120.0
#: 配置里最多存几个备用模型（C5：存 3、试 2）
MAX_FALLBACK_STORED = 3
#: 运行时最多遍历几个备用模型（延迟保护）
MAX_FALLBACK_TRIED = 2
#: 单个模型名的长度上限
MAX_MODEL_NAME_CHARS = 120
#: 放大 max_tokens 的天花板（截断类失败重试时用）
MAX_TOKENS_CEILING = 8192
#: 截断类失败重试时 max_tokens 的放大倍数
TOKEN_BOOST = 1.5
#: 同模型重试间隔（秒）
RETRY_BACKOFF_S = 0.3
#: 同模型重试时 temperature 的下调步长（让输出更收敛）
TEMPERATURE_STEP = 0.2
#: 日志里保留的响应体前缀长度（永不进响应）
BODY_HEAD_CHARS = 120


# --------------------------------------------------------------------------- #
# 失败策略：每个 FailureKind 的重试 / 换模型 / 终止行为
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class FailurePolicy:
    """一个失败分类该怎么处理。

    Attributes:
        fatal: 终止整链（配置类错误，换模型/换 provider 都救不了）。
        retry_same_model: 同一模型再试一次。
        switch_model: 换下一个模型（或下一个 provider）是否有意义。
        boost_max_tokens: 重试时放大 `max_tokens`（截断类失败的唯一解）。
    """

    fatal: bool = False
    retry_same_model: bool = False
    switch_model: bool = True
    boost_max_tokens: bool = False


_OK = FailurePolicy(fatal=False, retry_same_model=False, switch_model=False)
_FATAL = FailurePolicy(fatal=True, retry_same_model=False, switch_model=False)
_RETRY_AND_SWITCH = FailurePolicy(fatal=False, retry_same_model=True, switch_model=True)
_SWITCH_ONLY = FailurePolicy(fatal=False, retry_same_model=False, switch_model=True)

#: `http_4xx` 的默认策略：参数/额度问题，换模型无用（模型名错的情况在
#: `relay_service._classify_failure()` 里被单独升级为 `_SWITCH_ONLY`）。
FAILURE_POLICIES: dict[FailureKind, FailurePolicy] = {
    FailureKind.OK: _OK,
    # 配置错误：换模型、换 provider 都救不了，继续尝试只是在浪费用户时间
    FailureKind.CONNECT_ERROR: _FATAL,
    FailureKind.BAD_URL: _FATAL,
    FailureKind.AUTH_ERROR: _FATAL,
    # 超时：读超时 90s，重试一次就把等待拉到 180s+，体验上等价于卡死 → 直接换模型
    FailureKind.TIMEOUT: _SWITCH_ONLY,
    # 5xx：值得再给同一个模型一次机会
    FailureKind.HTTP_5XX: _RETRY_AND_SWITCH,
    # 4xx：默认终止；模型名写错时由分类函数升级为「换模型」
    FailureKind.HTTP_4XX: _FATAL,
    FailureKind.EMPTY_BODY: _RETRY_AND_SWITCH,
    FailureKind.HTML_BODY: _RETRY_AND_SWITCH,
    FailureKind.NOT_JSON: _RETRY_AND_SWITCH,
    FailureKind.TRUNCATED_JSON: FailurePolicy(
        fatal=False, retry_same_model=True, switch_model=True, boost_max_tokens=True
    ),
    FailureKind.NOT_OBJECT: _RETRY_AND_SWITCH,
    FailureKind.UPSTREAM_REFUSED: _SWITCH_ONLY,
    FailureKind.TRUNCATED_OUTPUT: FailurePolicy(
        fatal=False, retry_same_model=True, switch_model=True, boost_max_tokens=True
    ),
    FailureKind.NO_CONTENT: _RETRY_AND_SWITCH,
    # 预算耗尽不是「上游的错」，是链已经走完
    FailureKind.BUDGET_EXHAUSTED: _FATAL,
}

#: 4xx 里「模型名写错」的特征词：命中就值得换模型再试
MODEL_NAME_ERROR_HINTS: tuple[str, ...] = ("model", "does not exist", "not found", "no such model")


def policy_for(kind: FailureKind) -> FailurePolicy:
    """取某个失败分类的处理策略（未知分类按「终止」处理，宁可少试不滥试）。"""
    return FAILURE_POLICIES.get(kind, _FATAL)


# --------------------------------------------------------------------------- #
# 错误语义（R03）：下一步动作 + 兜底文案
# --------------------------------------------------------------------------- #
#: `data.next_actions` 的合法取值（前端按 `errors.upstream.action.*` 映射）
NEXT_ACTIONS: dict[FailureKind, tuple[str, ...]] = {
    FailureKind.HTML_BODY: ("check_base_url", "switch_model"),
    FailureKind.EMPTY_BODY: ("retry_later", "switch_model"),
    FailureKind.NOT_JSON: ("switch_model", "check_base_url"),
    FailureKind.TRUNCATED_JSON: ("raise_max_tokens", "switch_model"),
    FailureKind.TRUNCATED_OUTPUT: ("raise_max_tokens",),
    FailureKind.NOT_OBJECT: ("switch_model",),
    FailureKind.NO_CONTENT: ("raise_max_tokens",),
    FailureKind.TIMEOUT: ("switch_model", "retry_later"),
    FailureKind.HTTP_5XX: ("retry_later", "switch_model"),
    FailureKind.HTTP_4XX: ("switch_model", "check_api_key"),
    FailureKind.AUTH_ERROR: ("check_api_key",),
    FailureKind.CONNECT_ERROR: ("check_base_url",),
    FailureKind.UPSTREAM_REFUSED: ("switch_model",),
    FailureKind.BUDGET_EXHAUSTED: ("retry_later", "check_api_key"),
    FailureKind.BAD_URL: ("check_base_url",),
}


def next_actions_for(kind: FailureKind) -> list[str]:
    """给错误卡的「下一步」建议（枚举，无自由文本）。"""
    return list(NEXT_ACTIONS.get(kind, ("retry_later",)))


#: 兜底文案：**不含** `json` / `html` / `HTTP` / 异常类名 / 堆栈（R01 硬性要求）。
#: 正常情况下前端按 `data.reason` 渲染 i18n 文案，这里只在直出场景兜底。
USER_MESSAGES: dict[FailureKind, str] = {
    FailureKind.HTML_BODY: "返回的内容是一张网页，地址可能填成了网站首页",
    FailureKind.EMPTY_BODY: "这次没有拿到正文，稍后再试一次",
    FailureKind.NOT_JSON: "返回的内容不是可用的数据格式",
    FailureKind.TRUNCATED_JSON: "输出被截断了，把「最大输出 tokens」调大再试",
    FailureKind.TRUNCATED_OUTPUT: "输出被截断了，把「最大输出 tokens」调大再试",
    FailureKind.NOT_OBJECT: "返回的数据结构不对，换一个模型试试",
    FailureKind.NO_CONTENT: "模型只输出了思考过程、没有正文，把「最大输出 tokens」调大再试",
    FailureKind.TIMEOUT: "响应超时了，换一个模型再试",
    FailureKind.HTTP_5XX: "对方服务暂时不可用，稍后再试或换一个模型",
    FailureKind.HTTP_4XX: "请求被拒绝了，换一个模型或检查 Key",
    FailureKind.AUTH_ERROR: "Key 不对或已失效，检查一下 Key",
    FailureKind.CONNECT_ERROR: "连不上这个中转站，检查一下地址和网络",
    FailureKind.UPSTREAM_REFUSED: "对方明确拒绝了这次请求，换一个模型试试",
    FailureKind.BUDGET_EXHAUSTED: "已经试遍了所有模型，稍后再试或换一个中转站",
    FailureKind.BAD_URL: "中转站地址不合法，检查一下地址",
}


def user_message_for(kind: FailureKind) -> str:
    """取兜底文案。"""
    return USER_MESSAGES.get(kind, "这次没能拿到可用的结果，稍后再试一次")


#: 失败分类 → 对外错误码。配置类错误保持既有语义（一期错误码行为零变化），
#: 只有「格式类」失败归到新增的 `UPSTREAM_FORMAT_ERROR`（ADR-7）。
ERROR_CODE_FOR: dict[FailureKind, ErrorCode] = {
    FailureKind.CONNECT_ERROR: ErrorCode.PROXY_UNREACHABLE,
    FailureKind.BAD_URL: ErrorCode.VALIDATION_ERROR,
    FailureKind.AUTH_ERROR: ErrorCode.UPSTREAM_ERROR,
    FailureKind.HTTP_4XX: ErrorCode.UPSTREAM_ERROR,
    FailureKind.HTTP_5XX: ErrorCode.UPSTREAM_ERROR,
    FailureKind.TIMEOUT: ErrorCode.UPSTREAM_ERROR,
    FailureKind.HTML_BODY: ErrorCode.UPSTREAM_FORMAT_ERROR,
    FailureKind.EMPTY_BODY: ErrorCode.UPSTREAM_FORMAT_ERROR,
    FailureKind.NOT_JSON: ErrorCode.UPSTREAM_FORMAT_ERROR,
    FailureKind.TRUNCATED_JSON: ErrorCode.UPSTREAM_FORMAT_ERROR,
    FailureKind.NOT_OBJECT: ErrorCode.UPSTREAM_FORMAT_ERROR,
    FailureKind.UPSTREAM_REFUSED: ErrorCode.UPSTREAM_FORMAT_ERROR,
    FailureKind.TRUNCATED_OUTPUT: ErrorCode.UPSTREAM_FORMAT_ERROR,
    FailureKind.NO_CONTENT: ErrorCode.UPSTREAM_FORMAT_ERROR,
    FailureKind.BUDGET_EXHAUSTED: ErrorCode.UPSTREAM_FORMAT_ERROR,
}


def error_code_for(kind: FailureKind) -> ErrorCode:
    """取对外错误码。"""
    return ERROR_CODE_FOR.get(kind, ErrorCode.UPSTREAM_ERROR)


# --------------------------------------------------------------------------- #
# 调用记录
# --------------------------------------------------------------------------- #
@dataclass
class RelayAttempt:
    """一次 HTTP 调用的记录（成功那次也记录）。

    `body_head` 只用于日志，**永不进响应体**（可能含上游原始报文 / 内网地址）。
    """

    model: str
    provider: str
    provider_id: str | None
    try_index: int
    ok: bool
    reason: FailureKind
    http_status: int | None
    elapsed_ms: int
    body_head: str = ""


@dataclass
class RelayCall:
    """一次 HTTP 调用的分类结果（不抛异常，把决策交给上层）。"""

    kind: FailureKind
    policy: FailurePolicy
    content: str = ""
    payload: dict[str, Any] | None = None
    status: int | None = None
    body_head: str = ""
    elapsed_ms: int = 0
    #: 是否真的发出了 HTTP 请求。`bad_url` 在发请求前就被拦下，不计入调用次数预算。
    sent: bool = True


@dataclass
class RelayOutcome:
    """整条链的结果（成功时返回，失败时转成 `AppError.data`）。"""

    content: str
    model: str
    provider: str
    source: str
    elapsed_ms: int
    attempts: list[RelayAttempt]
    chain: list[str]
    total_calls: int
    degraded: bool

    def attempts_by_model(self) -> list[dict[str, Any]]:
        """把调用记录**按模型聚合**成错误卡需要的形状。

        错误卡要展示「已尝试：A → B → C」，用户关心的是「哪个模型试了几次、为什么
        失败」，不是每一次调用的流水。按模型聚合还能保证 `tries` 与展示顺序一致。
        """
        return aggregate_attempts(self.attempts)


def aggregate_attempts(attempts: list[RelayAttempt]) -> list[dict[str, Any]]:
    """按「provider + 模型」聚合调用记录，保持首次出现顺序。"""
    order: list[str] = []
    buckets: dict[str, dict[str, Any]] = {}
    for attempt in attempts:
        key = f"{attempt.provider}\u0000{attempt.model}"
        if key not in buckets:
            order.append(key)
            buckets[key] = {
                "model": attempt.model,
                "provider": attempt.provider,
                "tries": 0,
                "reason": attempt.reason.value,
                "elapsed_ms": 0,
            }
        bucket = buckets[key]
        bucket["tries"] += 1
        bucket["elapsed_ms"] += attempt.elapsed_ms
        bucket["reason"] = attempt.reason.value
    return [buckets[key] for key in order]
