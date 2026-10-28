from collections.abc import Callable, Sequence
from typing import Protocol
import mlx.core as mx

class CacheEntry(Protocol):
    def is_trimmable(self) -> bool: ...
    @property
    def nbytes(self) -> int: ...

type PromptCache = list[CacheEntry]

class Tokenizer(Protocol):
    eos_token_id: int | None
    eos_token_ids: set[int]
    def encode(self, text: str, **kwargs: object) -> list[int]: ...
    def decode(self, tokens: Sequence[int]) -> str: ...

class ModelArguments(Protocol):
    max_position_embeddings: int
    tie_word_embeddings: bool

class Embedding(Protocol):
    def as_linear(self, hidden: mx.array) -> mx.array: ...

class ModelBody(Protocol):
    embed_tokens: Embedding
    def __call__(self, inputs: mx.array, *, cache: PromptCache) -> mx.array: ...

class LanguageModel(Protocol):
    args: ModelArguments
    model_type: str
    model: ModelBody
    lm_head: Callable[[mx.array], mx.array]
    def __call__(self, inputs: mx.array, *, cache: PromptCache) -> mx.array: ...

def load(path_or_hf_repo: str, **kwargs: object) -> tuple[LanguageModel, Tokenizer]: ...
