"""Project-owned provider account pool.

The pool stores generic provider credentials locally.  It deliberately does not
know about any particular upstream project: an account is just an API key (or
access token), an optional provider URL, and health metadata.  Image/chat
routers use it for round-robin selection and failure cooldowns.
"""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from pathlib import Path
from typing import Any

from app.config import settings
from app.utils.errors import ErrorCode, GatewayError


class AccountPool:
    """Small persistent pool suitable for a single gateway process."""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._loaded = False
        self._accounts: dict[str, dict[str, Any]] = {}
        self._cursor = 0
        self._jobs: dict[str, dict[str, Any]] = {}
        # A compose batch reserves all its accounts atomically.  Reservations
        # stay process-local, just like request leases, and never persist tokens
        # or unfinished work across a gateway restart.
        self._batches: dict[str, dict[str, Any]] = {}

    def _reclaim_batches(self, now: float) -> None:
        """Drop expired, inactive batches (including never-submitted siblings)."""
        for batch_id, batch in list(self._batches.items()):
            if not batch["active"] and batch["expires_at"] <= now:
                del self._batches[batch_id]

    def _reserved_accounts(self) -> set[str]:
        return {account_id for batch in self._batches.values() for account_id in batch["accounts"]}

    @staticmethod
    def _healthy(item: dict[str, Any], now: float) -> bool:
        return (
            item.get("status") not in {"disabled", "abnormal", "封禁", "禁用", "异常"}
            and float(item.get("cooldown_until") or 0) <= now
            and bool(item.get("access_token"))
        )

    @property
    def _path(self) -> Path:
        path = Path(settings.pool_file)
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    async def _ensure_loaded(self) -> None:
        if self._loaded:
            return
        async with self._lock:
            if self._loaded:
                return
            try:
                raw = json.loads(self._path.read_text(encoding="utf-8"))
                records = raw.get("accounts", []) if isinstance(raw, dict) else raw
                if isinstance(records, list):
                    for item in records:
                        if isinstance(item, dict) and item.get("access_token"):
                            record = self._normalize(item)
                            self._accounts[record["id"]] = record
            except (OSError, ValueError):
                # A missing or corrupt local pool starts empty.  The admin UI can
                # import credentials again without taking the gateway down.
                pass
            self._loaded = True

    async def _persist(self) -> None:
        payload = {"version": 1, "accounts": list(self._accounts.values())}
        temp = self._path.with_suffix(".tmp")
        temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(self._path)

    @staticmethod
    def _normalize(raw: dict[str, Any]) -> dict[str, Any]:
        token = str(raw.get("access_token") or raw.get("api_key") or raw.get("token") or "").strip()
        account_id = str(raw.get("id") or raw.get("account_id") or "").strip() or uuid.uuid4().hex
        return {
            "id": account_id,
            "access_token": token,
            "type": str(raw.get("type") or raw.get("provider") or "api_key"),
            "base_url": str(raw.get("base_url") or "").strip(),
            "status": str(raw.get("status") or "normal").strip().lower(),
            "quota": int(raw.get("quota") or 0),
            "proxy": str(raw.get("proxy") or "").strip(),
            "last_used": float(raw.get("last_used") or 0),
            "last_refresh": str(raw.get("last_refresh") or ""),
            "last_error": str(raw.get("last_error") or ""),
            "failures": int(raw.get("failures") or 0),
            "cooldown_until": float(raw.get("cooldown_until") or 0),
            # Leases are process-local: a count persisted before a crash/restart
            # would make the account look busy forever, so always start at 0.
            "in_flight": 0,
            "max_concurrency": max(1, int(raw.get("max_concurrency") or 2)),
        }

    async def list(self) -> list[dict[str, Any]]:
        await self._ensure_loaded()
        async with self._lock:
            return [dict(item) for item in self._accounts.values()]

    async def image_capacity(self) -> dict[str, Any]:
        """Report only credentials this gateway can route independently."""
        await self._ensure_loaded()
        now = time.time()
        async with self._lock:
            self._reclaim_batches(now)
            reserved = self._reserved_accounts()
            healthy = [item for item in self._accounts.values() if self._healthy(item, now)]
            return {
                "total": len(self._accounts),
                "healthy": len(healthy),
                "available": sum(
                    1 for item in healthy
                    if not int(item.get("in_flight") or 0) and item["id"] not in reserved
                ),
                "reserved": len(reserved),
                "independent_routing": True,
                "scope": "local",
            }

    async def import_accounts(self, tokens: list[str], accounts: list[dict[str, Any]]) -> dict[str, Any]:
        await self._ensure_loaded()
        added = skipped = refreshed = 0
        errors: list[str] = []
        async with self._lock:
            records = list(accounts) + [{"access_token": token} for token in tokens]
            for raw in records:
                if not isinstance(raw, dict):
                    continue
                record = self._normalize(raw)
                if not record["access_token"]:
                    errors.append("缺少 access_token/api_key")
                    continue
                existing = next(
                    (item for item in self._accounts.values() if item["access_token"] == record["access_token"]),
                    None,
                )
                if existing:
                    existing.update({k: v for k, v in record.items() if k in {"base_url", "type", "proxy", "quota"} and v})
                    existing["status"] = "normal"
                    existing["last_error"] = ""
                    existing["cooldown_until"] = 0
                    refreshed += 1
                else:
                    self._accounts[record["id"]] = record
                    added += 1
            await self._persist()
        return {"added": added, "skipped": skipped, "refreshed": refreshed, "errors": errors}

    async def delete(self, tokens: list[str]) -> dict[str, Any]:
        await self._ensure_loaded()
        wanted = {str(token).strip() for token in tokens if str(token).strip()}
        async with self._lock:
            removed = [key for key, item in self._accounts.items() if item["access_token"] in wanted or item["id"] in wanted]
            for key in removed:
                del self._accounts[key]
            await self._persist()
        return {"removed": len(removed)}

    async def update(self, payload: dict[str, Any]) -> dict[str, Any]:
        await self._ensure_loaded()
        token = str(payload.get("access_token") or payload.get("api_key") or "").strip()
        async with self._lock:
            item = next((value for value in self._accounts.values() if value["access_token"] == token or value["id"] == token), None)
            if item is None:
                return {"updated": False}
            for key in ("type", "status", "quota", "proxy", "base_url"):
                if key in payload and payload[key] is not None:
                    item[key] = payload[key]
            await self._persist()
            return {"updated": True, "id": item["id"]}

    async def select(self, *, kind: str) -> dict[str, Any] | None:
        """Select the least-loaded healthy account (round-robin breaks ties).

        Concurrent requests (e.g. one compose run fanning out N image tasks)
        each call this once.  Picking the account with the fewest in-flight
        leases spreads N parallel calls over N different accounts whenever the
        pool has them, instead of stacking them on one account's concurrency.
        """
        await self._ensure_loaded()
        now = time.time()
        async with self._lock:
            self._reclaim_batches(now)
            reserved = self._reserved_accounts()
            items = list(self._accounts.values())
            if not items:
                return None
            start = self._cursor % len(items)
            self._cursor += 1
            ordered = [items[(start + offset) % len(items)] for offset in range(len(items))]
            candidates = [
                item
                for item in ordered
                if self._healthy(item, now)
                and item["id"] not in reserved
                and int(item.get("in_flight") or 0) < int(item.get("max_concurrency") or 2)
            ]
            if not candidates:
                return None
            # min() keeps the first of equals, so round-robin order decides ties
            item = min(candidates, key=lambda value: int(value.get("in_flight") or 0))
            item["last_used"] = now
            item["last_kind"] = kind
            item["in_flight"] = int(item.get("in_flight") or 0) + 1
            return dict(item)

    async def acquire_image(
        self, *, batch_id: str = "", task_id: str = "", batch_total: int = 1
    ) -> dict[str, Any] | None:
        """Acquire one image lease, with strict distinct accounts per batch.

        An empty legacy pool returns None for a directly configured provider.
        A managed batch must have enough actual selectable credentials; it
        must never silently fall back to a shared administrator/provider key.
        """
        await self._ensure_loaded()
        if batch_total == 1 and not self._accounts:
            # A single request needs only the configured image provider; no
            # cross-task isolation is claimed or required in this case.
            return None
        if not batch_id:
            account = await self.select(kind="image")
            if account is None and await self.list():
                raise GatewayError(ErrorCode.POOL_UNAVAILABLE, "号池账号正在使用或冷却中，请稍后重试")
            return account
        if not task_id or not 1 <= batch_total <= 32:
            raise GatewayError(ErrorCode.VALIDATION_ERROR, "图片批次必须包含任务标识和 1–32 个独立任务")

        now = time.time()
        async with self._lock:
            self._reclaim_batches(now)
            batch = self._batches.get(batch_id)
            if batch is None:
                reserved = self._reserved_accounts()
                candidates = [
                    item for item in self._accounts.values()
                    if self._healthy(item, now)
                    and not int(item.get("in_flight") or 0)
                    and item["id"] not in reserved
                ]
                candidates.sort(key=lambda item: float(item.get("last_used") or 0))
                if len(candidates) < batch_total:
                    message = (
                        "当前远端账号池未提供按账号路由能力，无法为此批次保证独立账号；请配置可路由账号池"
                        if not self._accounts else
                        f"本批次需要 {batch_total} 个不同账号，当前可独立调度 {len(candidates)} 个；请补充账号或稍后重试"
                    )
                    raise GatewayError(
                        ErrorCode.POOL_UNAVAILABLE,
                        message,
                        {
                            "reason": "independent_routing_unavailable" if not self._accounts else "insufficient_accounts",
                            "required_accounts": batch_total, "available_accounts": len(candidates),
                        },
                    )
                batch = {
                    "total": batch_total,
                    "accounts": [item["id"] for item in candidates[:batch_total]],
                    "tasks": {}, "active": set(), "done": set(),
                    "expires_at": now + max(600, settings.read_timeout * 2),
                }
                self._batches[batch_id] = batch
            if batch["total"] != batch_total:
                raise GatewayError(ErrorCode.VALIDATION_ERROR, "同一图片批次的任务数量不一致")
            if task_id in batch["active"] or task_id in batch["done"]:
                raise GatewayError(ErrorCode.VALIDATION_ERROR, "该图片任务已在执行或已完成，请勿重复提交")
            if len(batch["tasks"]) >= batch_total:
                raise GatewayError(ErrorCode.VALIDATION_ERROR, "图片批次任务数超过预留账号数量")
            account_id = batch["accounts"][len(batch["tasks"])]
            account = self._accounts.get(account_id)
            if account is None or not self._healthy(account, now):
                raise GatewayError(ErrorCode.POOL_UNAVAILABLE, "为该图片任务预留的账号已不可用，请重新提交")
            batch["tasks"][task_id] = account_id
            batch["active"].add(task_id)
            batch["expires_at"] = now + max(600, settings.read_timeout * 2)
            account["last_used"] = now
            account["last_kind"] = "image"
            account["in_flight"] = int(account.get("in_flight") or 0) + 1
            return dict(account)

    async def release_image(self, account_id: str, *, batch_id: str = "", task_id: str = "") -> None:
        """Finish a request after all model retries; free completed batches."""
        await self._ensure_loaded()
        async with self._lock:
            item = self._accounts.get(account_id)
            if item:
                item["in_flight"] = max(0, int(item.get("in_flight") or 0) - 1)
            batch = self._batches.get(batch_id)
            if batch and batch["tasks"].get(task_id) == account_id:
                batch["active"].discard(task_id)
                batch["done"].add(task_id)
                # Retain a brief tombstone after completion so a duplicate task
                # cannot start the same batch again and charge twice.
                if len(batch["done"]) == batch["total"]:
                    batch["accounts"] = []
                batch["expires_at"] = time.time() + max(600, settings.read_timeout * 2)
            await self._persist()

    async def release(self, account_id: str) -> None:
        """Release one request lease, including failed requests."""
        await self._ensure_loaded()
        async with self._lock:
            item = self._accounts.get(account_id)
            if item:
                item["in_flight"] = max(0, int(item.get("in_flight") or 0) - 1)
                await self._persist()

    async def mark_success(self, account_id: str) -> None:
        await self._ensure_loaded()
        async with self._lock:
            item = self._accounts.get(account_id)
            if item:
                item["status"] = "normal"
                item["failures"] = 0
                item["last_error"] = ""
                item["cooldown_until"] = 0
                await self._persist()

    async def mark_failure(self, account_id: str, message: str, *, retryable: bool = True) -> None:
        await self._ensure_loaded()
        async with self._lock:
            item = self._accounts.get(account_id)
            if not item:
                return
            item["failures"] = int(item.get("failures") or 0) + 1
            item["last_error"] = message[:300]
            item["status"] = "limited" if retryable else "abnormal"
            item["cooldown_until"] = time.time() + min(300, 10 * item["failures"])
            await self._persist()

    async def start_job(self, *, action: str, tokens: list[str]) -> dict[str, Any]:
        """Run a provider-agnostic maintenance job.

        Generic API keys have no universal refresh/re-login endpoint.  We still
        expose the same progress contract for the admin UI and record the
        maintenance timestamp; provider-specific OAuth can be added as an
        adapter later without coupling the gateway to another application.
        """
        await self._ensure_loaded()
        job_id = uuid.uuid4().hex
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        selected = set(tokens)
        async with self._lock:
            count = 0
            for item in self._accounts.values():
                if selected and item["access_token"] not in selected and item["id"] not in selected:
                    continue
                item["last_refresh"] = now
                if action == "relogin":
                    item["last_error"] = "通用 API Key 无需重新登录"
                count += 1
            await self._persist()
        self._jobs[job_id] = {"job_id": job_id, "status": "completed", "done": count, "total": count, "action": action}
        return {"job_id": job_id}

    async def job(self, job_id: str) -> dict[str, Any]:
        return dict(self._jobs.get(job_id) or {"job_id": job_id, "status": "not_found", "done": 0, "total": 0})

    async def export(self, tokens: list[str], fmt: str) -> tuple[bytes, str, str]:
        import io
        import zipfile

        records = await self.list()
        wanted = {str(token).strip() for token in tokens if str(token).strip()}
        if wanted:
            records = [item for item in records if item["access_token"] in wanted or item["id"] in wanted]
        # Export is an admin-only internal endpoint; keep the full token so it
        # can be imported into another instance.  Never expose it in list views.
        body = json.dumps({"accounts": records}, ensure_ascii=False, indent=2).encode()
        if fmt == "zip":
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("accounts.json", body)
            return buf.getvalue(), "application/zip", 'attachment; filename="accounts.zip"'
        return body, "application/json", 'attachment; filename="accounts.json"'


account_pool = AccountPool()
