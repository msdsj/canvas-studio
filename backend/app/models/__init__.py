"""ORM 模型聚合导出。

导入顺序有意义：`teams` 必须在任何引用 `teams.id` 外键的模型之前导入，
否则 `create_all` 建表时可能因为找不到被引用表而失败。
"""
from app.models.team import Team, TeamInvitation, TeamMember
from app.models.user import User

from app.models.ai_provider import AIProvider
from app.models.announcement import Announcement
from app.models.asset import Asset
from app.models.audit import AuditLog
from app.models.canvas import Canvas
from app.models.chat import ChatMessage, ChatSession
from app.models.collaboration import CanvasCollaborator
from app.models.email_token import EmailToken
from app.models.generation import GenerationTask
from app.models.invite import InviteCode
from app.models.pro_code import ProCode
from app.models.project import CanvasProject
from app.models.quota import QuotaTransaction
from app.models.skill import SkillRun
from app.models.skill_pack import TeamSkillPack, UserSkillOverride, UserSkillPack
from app.models.system_config import SystemConfig

__all__ = [
    "AIProvider",
    "Announcement",
    "Asset",
    "AuditLog",
    "Canvas",
    "CanvasCollaborator",
    "CanvasProject",
    "ChatMessage",
    "ChatSession",
    "EmailToken",
    "GenerationTask",
    "InviteCode",
    "ProCode",
    "QuotaTransaction",
    "SkillRun",
    "SystemConfig",
    "Team",
    "TeamInvitation",
    "TeamMember",
    "TeamSkillPack",
    "User",
    "UserSkillOverride",
    "UserSkillPack",
]
