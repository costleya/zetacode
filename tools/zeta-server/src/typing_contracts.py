"""Shared request and response typing contracts for the decoder modules."""

from collections.abc import Callable
from typing import NotRequired, TypedDict

TokenSequence = list[int]
CancellationCheck = Callable[[], bool]
TokenCallback = Callable[[], None]


class DraftStatistics(TypedDict):
    forward_passes: int
    proposed_tokens: int
    accepted_tokens: int
    zero_accept_batches: int


class TokenUsage(TypedDict):
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int


class CacheStatistics(TypedDict):
    cached_prompt_tokens: int


class MemorySnapshot(TypedDict):
    scope: str
    active_bytes: int
    cache_bytes: int
    peak_bytes: int
    kv_cache_bytes: int
    cache_limit_bytes: int


class GenerationResult(TypedDict):
    text: str
    finish_reason: str
    tokens: TokenSequence
    usage: TokenUsage
    cache: CacheStatistics
    draft_stats: NotRequired[DraftStatistics]
    prompt_sha256: NotRequired[str]
    memory: NotRequired[MemorySnapshot]
