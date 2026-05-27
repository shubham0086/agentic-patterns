"""
BaseAgent — base class for all agents.
Implements multi-provider LLM routing with session circuit breaker.
See: docs/02-multi-provider-llm-routing.md
"""

from __future__ import annotations
import hashlib
import json
import os
import re
from typing import TYPE_CHECKING

import httpx

if TYPE_CHECKING:
    from .blackboard import Blackboard

# ── Provider configuration ────────────────────────────────────────────────────

PROVIDER_CONFIGS = {
    "ollama": {
        "base_url": os.getenv("OLLAMA_BASE_URL", "http://localhost:11434"),
        "model": os.getenv("OLLAMA_MODEL", "qwen2.5-coder:7b"),
        "timeout": 90.0,
        "requires_key": False,
    },
    "opencode": {
        "base_url": "https://opencode.ai/zen/v1",
        "model": os.getenv("OPENCODE_MODEL", "minimax-m2.5-free"),
        "timeout": 30.0,
        "requires_key": True,
        "key_env": "OPENCODE_API_KEY",
    },
    "openrouter": {
        "base_url": "https://openrouter.ai/api/v1",
        "model": os.getenv("OPENROUTER_MODEL", "meta-llama/llama-3.3-70b-instruct:free"),
        "timeout": 45.0,
        "requires_key": True,
        "key_env": "OPENROUTER_API_KEY",
    },
    "gemini": {
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "model": os.getenv("GEMINI_MODEL", "gemini-2.0-flash"),
        "timeout": 60.0,
        "requires_key": True,
        "key_env": "GEMINI_API_KEY",
    },
    "openai": {
        "base_url": "https://api.openai.com/v1",
        "model": os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
        "timeout": 60.0,
        "requires_key": True,
        "key_env": "OPENAI_API_KEY",
    },
    "anthropic": {
        "base_url": "https://api.anthropic.com/v1",
        "model": os.getenv("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001"),
        "timeout": 60.0,
        "requires_key": True,
        "key_env": "ANTHROPIC_API_KEY",
    },
}

# Session-level circuit breaker — shared across all agent instances
_exhausted: set[str] = set()
_response_cache: dict[str, str] = {}


class BaseAgent:
    def __init__(self, name: str):
        self.name = name
        self.provider_order = [
            p.strip()
            for p in os.getenv("PROVIDER_ORDER", "ollama").split(",")
            if p.strip() in PROVIDER_CONFIGS
        ]

    # ── Override in subclass ───────────────────────────────────────────────────

    def system_prompt(self) -> str:
        return "You are a helpful AI assistant. Respond concisely and accurately."

    def build_prompt(self, goal: str, context: str, blackboard: "Blackboard") -> str:
        if context:
            return f"Goal: {goal}\n\nContext from prior agents:\n{context}\n\nProvide your analysis."
        return f"Goal: {goal}\n\nProvide your analysis."

    def parse_output(self, raw: str, blackboard: "Blackboard") -> None:
        blackboard.append_note(self.name, raw.strip())

    # ── Core execution ─────────────────────────────────────────────────────────

    async def execute(self, blackboard: "Blackboard", context: str = "") -> None:
        sys_prompt = self.system_prompt()
        prompt = self.build_prompt(blackboard.goal, context, blackboard)

        cache_key = hashlib.sha256(f"{sys_prompt}\x00{prompt}".encode()).hexdigest()

        if cache_key in _response_cache:
            print(f"  [{self.name}] cache hit")
            self.parse_output(_response_cache[cache_key], blackboard)
            return

        raw = await self._call_with_failover(sys_prompt, prompt, blackboard)
        _response_cache[cache_key] = raw
        self.parse_output(raw, blackboard)

    # ── Provider routing ───────────────────────────────────────────────────────

    async def _call_with_failover(self, system_prompt: str, prompt: str, blackboard: "Blackboard") -> str:
        for provider in self.provider_order:
            if provider in _exhausted:
                continue

            cfg = PROVIDER_CONFIGS[provider]

            if cfg["requires_key"] and not os.getenv(cfg["key_env"]):
                continue

            try:
                print(f"  [{self.name}] trying {provider}/{cfg['model']}")
                result = await self._call(provider, cfg, system_prompt, prompt)
                cost = self._estimate_cost(provider, prompt, result)
                blackboard.record_cost(self.name, cost)
                return result
            except httpx.HTTPStatusError as err:
                print(f"  [{self.name}] {provider} HTTP {err.response.status_code}")
                if err.response.status_code in (401, 403):
                    _exhausted.add(provider)
            except Exception as err:
                print(f"  [{self.name}] {provider} failed: {err}")

        raise RuntimeError(
            f"[{self.name}] All providers failed or unconfigured. "
            "Install Ollama and run: ollama pull qwen2.5-coder:7b"
        )

    async def _call(self, provider: str, cfg: dict, system_prompt: str, prompt: str) -> str:
        if provider == "ollama":
            return await self._call_ollama(cfg, system_prompt, prompt)
        if provider == "anthropic":
            return await self._call_anthropic(cfg, system_prompt, prompt)
        return await self._call_openai_compat(cfg, system_prompt, prompt)

    async def _call_ollama(self, cfg: dict, system_prompt: str, prompt: str) -> str:
        async with httpx.AsyncClient(timeout=cfg["timeout"]) as client:
            res = await client.post(
                f"{cfg['base_url']}/api/chat",
                json={
                    "model": cfg["model"],
                    "stream": False,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": prompt},
                    ],
                },
            )
            res.raise_for_status()
            return res.json()["message"]["content"]

    async def _call_openai_compat(self, cfg: dict, system_prompt: str, prompt: str) -> str:
        key = os.getenv(cfg["key_env"])
        async with httpx.AsyncClient(timeout=cfg["timeout"]) as client:
            res = await client.post(
                f"{cfg['base_url']}/chat/completions",
                headers={"Authorization": f"Bearer {key}"},
                json={
                    "model": cfg["model"],
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": prompt},
                    ],
                },
            )
            res.raise_for_status()
            return res.json()["choices"][0]["message"]["content"]

    async def _call_anthropic(self, cfg: dict, system_prompt: str, prompt: str) -> str:
        async with httpx.AsyncClient(timeout=cfg["timeout"]) as client:
            res = await client.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": os.getenv("ANTHROPIC_API_KEY", ""),
                    "anthropic-version": "2023-06-01",
                },
                json={
                    "model": cfg["model"],
                    "max_tokens": 4096,
                    "system": system_prompt,
                    "messages": [{"role": "user", "content": prompt}],
                },
            )
            res.raise_for_status()
            return res.json()["content"][0]["text"]

    # ── Utilities ──────────────────────────────────────────────────────────────

    @staticmethod
    def clean_json(raw: str) -> dict | list | None:
        """Never use json.loads() on raw LLM output — use this instead."""
        try:
            match = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw)
            cleaned = match.group(1) if match else raw
            return json.loads(cleaned.strip())
        except (json.JSONDecodeError, AttributeError):
            return None

    def _estimate_cost(self, provider: str, prompt: str, result: str) -> float:
        tokens = (len(prompt) + len(result)) // 4
        rates = {
            "ollama": 0, "opencode": 0, "openrouter": 0.0000002,
            "gemini": 0.00000015, "openai": 0.00000015, "anthropic": 0.00000025,
        }
        return tokens * rates.get(provider, 0)
