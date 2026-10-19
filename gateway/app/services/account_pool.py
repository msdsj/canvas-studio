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


class AccountPool:
    """Small persistent pool suitable for a single gateway process."""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._loaded = False
        self._accounts: dict[str, dict[str, Any]] = {}
        self._cursor = 0
        self._jobs: dict[str, dict[str, Any]] = {}

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
            items = list(self._accounts.values())
            if not items:
                return None
            start = self._cursor % len(items)
            self._cursor += 1
            ordered = [items[(start + offset) % len(items)] for offset in range(len(items))]
            candidates = [
                item
                for item in ordered
                if item.get("status") not in {"disabled", "abnormal"}
                and float(item.get("cooldown_until") or 0) <= now
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
