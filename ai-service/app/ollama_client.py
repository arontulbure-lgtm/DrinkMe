"""Thin async client for the Ollama HTTP API (chat with structured output)."""
from __future__ import annotations

import json
import logging
from typing import Any

import httpx

from .config import Settings

log = logging.getLogger("ai-service.ollama")


class ModelUnavailable(Exception):
    """Ollama is not reachable or the model is not pulled."""


class ModelTimeout(Exception):
    pass


class ModelInvalidOutput(Exception):
    pass


class OllamaClient:
    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None):
        self._settings = settings
        self._client = httpx.AsyncClient(
            base_url=settings.ollama_url,
            timeout=httpx.Timeout(settings.ollama_timeout_s, connect=3.0),
            transport=transport,
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def list_models(self) -> list[str]:
        try:
            r = await self._client.get("/api/tags", timeout=3.0)
            r.raise_for_status()
        except (httpx.HTTPError, ValueError):
            return []
        return [m.get("name", "") for m in r.json().get("models", [])]

    async def chat_json(
        self,
        model: str,
        system: str,
        user: str,
        schema: dict[str, Any],
        *,
        images: list[str] | None = None,
        temperature: float = 0.2,
        num_predict: int = 512,
        num_ctx: int = 4096,
        keep_alive: str | None = None,
    ) -> dict[str, Any]:
        message: dict[str, Any] = {"role": "user", "content": user}
        if images:
            message["images"] = images
        body = {
            "model": model,
            "messages": [{"role": "system", "content": system}, message],
            "format": schema,
            "stream": False,
            "think": False,
            "keep_alive": keep_alive or self._settings.keep_alive,
            "options": {"temperature": temperature, "num_predict": num_predict, "num_ctx": num_ctx},
        }
        try:
            r = await self._client.post("/api/chat", json=body)
        except httpx.TimeoutException as exc:
            raise ModelTimeout() from exc
        except httpx.HTTPError as exc:
            raise ModelUnavailable() from exc
        if r.status_code == 404:
            raise ModelUnavailable()
        if r.status_code >= 400:
            # The body can echo the prompt, so only the status is logged.
            log.warning("ollama chat failed with status %s", r.status_code)
            raise ModelUnavailable()
        content = r.json().get("message", {}).get("content", "")
        try:
            data = json.loads(content)
        except json.JSONDecodeError as exc:
            raise ModelInvalidOutput() from exc
        if not isinstance(data, dict):
            raise ModelInvalidOutput()
        return data
