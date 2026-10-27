from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class CompletionRequest(_message.Message):
    __slots__ = ("model", "prompt", "temperature", "repeat_penalty", "max_tokens", "stop", "notify_first_token", "notify_no_edit_impossible")
    MODEL_FIELD_NUMBER: _ClassVar[int]
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    TEMPERATURE_FIELD_NUMBER: _ClassVar[int]
    REPEAT_PENALTY_FIELD_NUMBER: _ClassVar[int]
    MAX_TOKENS_FIELD_NUMBER: _ClassVar[int]
    STOP_FIELD_NUMBER: _ClassVar[int]
    NOTIFY_FIRST_TOKEN_FIELD_NUMBER: _ClassVar[int]
    NOTIFY_NO_EDIT_IMPOSSIBLE_FIELD_NUMBER: _ClassVar[int]
    model: str
    prompt: str
    temperature: float
    repeat_penalty: float
    max_tokens: int
    stop: _containers.RepeatedScalarFieldContainer[str]
    notify_first_token: bool
    notify_no_edit_impossible: bool
    def __init__(self, model: _Optional[str] = ..., prompt: _Optional[str] = ..., temperature: _Optional[float] = ..., repeat_penalty: _Optional[float] = ..., max_tokens: _Optional[int] = ..., stop: _Optional[_Iterable[str]] = ..., notify_first_token: _Optional[bool] = ..., notify_no_edit_impossible: _Optional[bool] = ...) -> None: ...

class FirstToken(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class NoEditImpossible(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class CompletionResult(_message.Message):
    __slots__ = ("text", "finish_reason", "prompt_eval_count", "eval_count")
    TEXT_FIELD_NUMBER: _ClassVar[int]
    FINISH_REASON_FIELD_NUMBER: _ClassVar[int]
    PROMPT_EVAL_COUNT_FIELD_NUMBER: _ClassVar[int]
    EVAL_COUNT_FIELD_NUMBER: _ClassVar[int]
    text: str
    finish_reason: str
    prompt_eval_count: int
    eval_count: int
    def __init__(self, text: _Optional[str] = ..., finish_reason: _Optional[str] = ..., prompt_eval_count: _Optional[int] = ..., eval_count: _Optional[int] = ...) -> None: ...

class CompletionEvent(_message.Message):
    __slots__ = ("first_token", "no_edit_impossible", "final_result")
    FIRST_TOKEN_FIELD_NUMBER: _ClassVar[int]
    NO_EDIT_IMPOSSIBLE_FIELD_NUMBER: _ClassVar[int]
    FINAL_RESULT_FIELD_NUMBER: _ClassVar[int]
    first_token: FirstToken
    no_edit_impossible: NoEditImpossible
    final_result: CompletionResult
    def __init__(self, first_token: _Optional[_Union[FirstToken, _Mapping]] = ..., no_edit_impossible: _Optional[_Union[NoEditImpossible, _Mapping]] = ..., final_result: _Optional[_Union[CompletionResult, _Mapping]] = ...) -> None: ...

class HealthRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class HealthResponse(_message.Message):
    __slots__ = ("ready", "models")
    READY_FIELD_NUMBER: _ClassVar[int]
    MODELS_FIELD_NUMBER: _ClassVar[int]
    ready: bool
    models: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, ready: _Optional[bool] = ..., models: _Optional[_Iterable[str]] = ...) -> None: ...
