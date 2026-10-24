"""邮件服务：确认 / 重置邮件。

开发态（`CS_EMAIL_BACKEND=console`）把链接打印到控制台并落 `data/mail.log`；
生产可用 SMTP（aiosmtplib）。
"""
from __future__ import annotations

import os
from pathlib import Path

import aiosmtplib
from email.message import EmailMessage

from app.config import settings
from app.utils.logging import get_logger

logger = get_logger("app.email")


def _append_mail_log(subject: str, to: str, body: str) -> None:
    """把邮件内容追加到本地 mail.log（开发态留痕）。"""
    path = Path(settings.mail_log_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fp:
        fp.write(f"==== {subject} -> {to} ====\n{body}\n\n")


async def _send(subject: str, to: str, body: str) -> None:
    """发送邮件：console 打印日志 / smtp 真实发送。"""
    if settings.email_backend == "smtp" and settings.smtp_host:
        message = EmailMessage()
        message["From"] = settings.smtp_from
        message["To"] = to
        message["Subject"] = subject
        message.set_content(body)
        await aiosmtplib.send(
            message,
            hostname=settings.smtp_host,
            port=settings.smtp_port,
            username=settings.smtp_user or None,
            password=settings.smtp_password or None,
            start_tls=settings.smtp_tls,
            timeout=20,
        )
        logger.info("已通过 SMTP 发送邮件 -> %s", to)
        return

    # console 后端：打印 + 落日志文件
    logger.info("[MAIL][console] %s -> %s\n%s", subject, to, body)
    _append_mail_log(subject, to, body)


async def send_verify_email(to: str, token: str) -> None:
    """发送邮箱确认邮件。"""
    link = f"{settings.frontend_base_url}/verify-email?token={token}"
    body = (
        "欢迎使用 MSDSJ！\n\n"
        f"请点击以下链接完成邮箱确认（{settings.verify_token_ttl_hours} 小时内有效）：\n{link}\n"
    )
    await _send("[MSDSJ] 邮箱确认", to, body)


async def send_reset_email(to: str, token: str) -> None:
    """发送密码重置邮件。"""
    link = f"{settings.frontend_base_url}/reset-password?token={token}"
    body = (
        "您正在重置 MSDSJ 密码。\n\n"
        f"请点击以下链接完成重置（{settings.reset_token_ttl_hours} 小时内有效）：\n{link}\n\n"
        "如果这不是您的操作，请忽略本邮件。\n"
    )
    await _send("[MSDSJ] 重置密码", to, body)


def mail_dir() -> str:
    """返回邮件日志所在目录（供测试/排查）。"""
    return os.path.dirname(os.path.abspath(settings.mail_log_path))


async def send_team_invite_email(to: str, team_name: str, inviter: str, token: str, role: str) -> None:
    """发送团队邀请邮件。

    邀请链接指向前端 `/team/join?token=...`：被邀请人登录后即可接受，
    若邮箱尚未注册，会先走注册再自动加入（令牌与邮箱绑定，不能转给他人）。
    """
    link = f"{settings.frontend_base_url}/team/join?token={token}"
    role_label = {"owner": "超级管理员", "admin": "管理员", "member": "成员"}.get(role, "成员")
    body = (
        f"{inviter} 邀请你加入团队「{team_name}」，身份：{role_label}。\n\n"
        f"点击链接接受邀请（7 天内有效）：\n{link}\n\n"
        "如果这不是给你的邀请，忽略本邮件即可。\n"
    )
    await _send(f"[MSDSJ] 加入团队「{team_name}」", to, body)
