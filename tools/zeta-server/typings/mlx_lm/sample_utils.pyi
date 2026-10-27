from collections.abc import Callable
import mlx.core as mx

type Sampler = Callable[[mx.array], mx.array]
type LogitsProcessor = Callable[[mx.array, mx.array], mx.array]

def make_sampler(temp: float = ...) -> Sampler: ...
def make_logits_processors(*, repetition_penalty: float = ..., repetition_context_size: int = ...) -> list[LogitsProcessor]: ...
