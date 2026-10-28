"""Private gRPC completions for local Zeta verification and Qwen FIM."""
from __future__ import annotations

from collections.abc import Callable, Generator
from concurrent.futures import Future
from types import FrameType
from typing import TYPE_CHECKING, Literal, NoReturn, cast

if TYPE_CHECKING:
    from typing_contracts import GenerationResult

import argparse
from concurrent.futures import CancelledError, ThreadPoolExecutor
import json
import logging
import math
import os
import queue
import signal
import threading
import time
import uuid

# MLX reads this at initialization; changing it requires a server restart.
os.environ.setdefault('MLX_METAL_RESIDENCY_REFRESH_INTERVAL_MS', '1000')

import grpc
from opentelemetry import trace
from opentelemetry.trace import SpanKind

import observability

import completion_pb2
import completion_pb2_grpc
from decoder import Decoder, GenerationCancelled, MLXAllocator, nonnegative_int
from continuation_decoder import ContinuationDecoder
from setup_progress import SetupProgress, resolve_model
from unix_grpc_server import PrivateUnixSocket, create_server, validate_socket_path


class CompletionService(completion_pb2_grpc.CompletionServiceServicer):
    def __init__(self, decoder: Decoder | None, continuation_decoder: ContinuationDecoder | None,
                 model_id: str = 'zeta-2.1',
                 continuation_model_id: str = 'qwen2.5-coder-7b-instruct',
                 request_timeout: object = 30) -> None:
        if (isinstance(request_timeout, bool) or not isinstance(request_timeout, (int, float))
                or not math.isfinite(request_timeout) or request_timeout <= 0):
            raise ValueError('request_timeout must be a positive finite number')
        self.decoder = decoder
        self.continuation_decoder = continuation_decoder
        self.model_id = model_id
        self.continuation_model_id = continuation_model_id
        self.request_timeout = request_timeout
        self.executor = ThreadPoolExecutor(max_workers=8, thread_name_prefix='nes-grpc')
        self._generation_executor = ThreadPoolExecutor(
            max_workers=2, thread_name_prefix='nes-generation')
        self._shutdown = threading.Event()

    def register(self, grpc_server: grpc.Server) -> None:
        completion_pb2_grpc.add_CompletionServiceServicer_to_server(self, grpc_server)

    def shutdown(self) -> None:
        self._shutdown.set()
        self._generation_executor.shutdown(wait=True, cancel_futures=True)
        self.executor.shutdown(wait=True, cancel_futures=True)

    def Health(self, request: completion_pb2.HealthRequest,
               context: grpc.ServicerContext) -> completion_pb2.HealthResponse:
        del request
        ready = self.decoder is not None and self.continuation_decoder is not None
        return completion_pb2.HealthResponse(
            ready=ready,
            models=[self.model_id, self.continuation_model_id] if ready else [])

    def Complete(self, request: completion_pb2.CompletionRequest,
                 context: grpc.ServicerContext) -> Generator[completion_pb2.CompletionEvent, None, None]:
        parent = observability.extract_metadata(context.invocation_metadata())
        span = observability.start_span(
            'nesweep.CompletionService/Complete', context=parent, kind=SpanKind.SERVER,
            attributes={'rpc.system': 'grpc', 'rpc.service': 'nesweep.CompletionService',
                        'rpc.method': 'Complete'})
        iterator = self._complete(request, context)
        try:
            while True:
                # Never leave an active span attached while yielding to gRPC.
                with trace.use_span(span, end_on_exit=False, record_exception=False,
                                    set_status_on_exception=False):
                    try:
                        event = next(iterator)
                    except StopIteration:
                        span.set_attribute('nesweep.outcome', 'success')
                        return
                yield event
        except GeneratorExit:
            span.set_attribute('nesweep.outcome', 'cancelled')
            raise
        except BaseException as error:
            # gRPC's concrete synchronous context exposes code(), but its public
            # ServicerContext annotation omits this accessor.
            code_method = cast(Callable[[], grpc.StatusCode | None] | None,
                               getattr(context, 'code', None))
            code = code_method() if callable(code_method) else None
            if code in (grpc.StatusCode.CANCELLED, grpc.StatusCode.DEADLINE_EXCEEDED):
                span.set_attribute('nesweep.outcome', 'cancelled')
            elif self._shutdown.is_set():
                span.set_attribute('nesweep.outcome', 'shutdown')
            else:
                observability.mark_error(span, error)
            if code is not None:
                span.set_attribute('rpc.grpc.status_code', code.value[0])
            raise
        finally:
            try:
                iterator.close()
            finally:
                span.end()

    def _complete(self, request: completion_pb2.CompletionRequest,
                  context: grpc.ServicerContext) -> Generator[completion_pb2.CompletionEvent, None, None]:
        if self.decoder is None or self.continuation_decoder is None:
            context.abort(grpc.StatusCode.UNAVAILABLE, 'Local decoders are not ready')
        if request.model not in (self.model_id, self.continuation_model_id):
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, 'Unsupported model for the local decoders')
        if not request.prompt:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, 'prompt must be a nonempty string')
        if request.temperature != 0:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT,
                          'Only temperature-zero decoding is supported')

        decoder = self.decoder
        continuation_decoder = self.continuation_decoder
        is_continuation = request.model == self.continuation_model_id
        expected_repeat_penalty = 1.1 if is_continuation else 1.0
        repeat_penalty = (request.repeat_penalty if request.HasField('repeat_penalty')
                          else expected_repeat_penalty)
        if repeat_penalty != expected_repeat_penalty:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT,
                          'Unsupported repeat_penalty for the local decoder')
        max_tokens = (request.max_tokens if request.HasField('max_tokens')
                      else (192 if is_continuation else 2048))
        if max_tokens < 0:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, 'max_tokens must not be negative')
        stop = list(request.stop)
        if any(not value for value in stop):
            context.abort(grpc.StatusCode.INVALID_ARGUMENT,
                          'stop tokens must be nonempty strings')

        events: queue.Queue[tuple[Literal["event"], completion_pb2.CompletionEvent]
                            | tuple[Literal["result"], GenerationResult]
                            | tuple[Literal["error"], BaseException]] = queue.Queue()
        cancelled = threading.Event()
        notification_lock = threading.Lock()
        notifications_sent: set[str] = set()
        started = time.monotonic()
        # A request without a deadline returns None in the synchronous runtime.
        remaining = cast(float | None, context.time_remaining())
        timeout = self.request_timeout if remaining is None else min(self.request_timeout, remaining)
        deadline = started + max(0, timeout)
        context.add_callback(cancelled.set)

        def is_cancelled() -> bool:
            return (cancelled.is_set() or self._shutdown.is_set() or not context.is_active()
                    or time.monotonic() >= deadline)

        def notify_first_token() -> None:
            with notification_lock:
                if 'first_token' in notifications_sent:
                    return
                notifications_sent.add('first_token')
                events.put(('event', completion_pb2.CompletionEvent(
                    first_token=completion_pb2.FirstToken())))

        def notify_no_edit_impossible() -> None:
            with notification_lock:
                if 'no_edit_impossible' in notifications_sent:
                    return
                notifications_sent.add('no_edit_impossible')
                events.put(('event', completion_pb2.CompletionEvent(
                    no_edit_impossible=completion_pb2.NoEditImpossible())))

        generation_span = observability.start_span(
            'completion.generate', context=trace.set_span_in_context(trace.get_current_span()))

        def generate() -> None:
            with trace.use_span(generation_span, end_on_exit=True, record_exception=False,
                                set_status_on_exception=False):
                generate_in_context()

        def generate_in_context() -> None:
            try:
                if is_cancelled():
                    raise GenerationCancelled('Request cancelled')
                if is_continuation:
                    result = continuation_decoder.generate(
                        request.prompt, max_tokens=max_tokens, stop=stop, cancelled=is_cancelled)
                else:
                    notifications: dict[str, Callable[[], None]] = {}
                    if request.notify_first_token:
                        notifications['on_first_token'] = notify_first_token
                    if request.notify_no_edit_impossible:
                        notifications['on_no_edit_impossible'] = notify_no_edit_impossible
                    result = decoder.generate(
                        request.prompt, max_tokens=max_tokens, stop=stop, mode='source',
                        draft_size=96, cancelled=is_cancelled, **notifications)
                observability.record_result(generation_span, result)
                generation_span.set_attribute('nesweep.outcome', 'success')
                events.put(('result', result))
            except BaseException as error:
                if isinstance(error, GenerationCancelled):
                    generation_span.set_attribute(
                        'nesweep.outcome', 'shutdown' if self._shutdown.is_set() else 'cancelled')
                else:
                    observability.mark_error(generation_span, error)
                events.put(('error', error))

        try:
            future = self._generation_executor.submit(generate)
        except BaseException as error:
            observability.mark_error(generation_span, error)
            generation_span.end()
            raise

        def generation_done(completed: Future[None]) -> None:
            if completed.cancelled():
                generation_span.set_attribute(
                    'nesweep.outcome', 'shutdown' if self._shutdown.is_set() else 'cancelled')
                generation_span.end()

        future.add_done_callback(generation_done)

        def cancel_and_abort() -> NoReturn:
            future.cancel()
            self._abort_cancelled(context, deadline)

        try:
            while True:
                try:
                    event = events.get(timeout=0.05)
                except queue.Empty:
                    if self._shutdown.is_set():
                        future.cancel()
                        context.abort(grpc.StatusCode.UNAVAILABLE, 'Local decoder is shutting down')
                    if is_cancelled():
                        cancel_and_abort()
                    if future.done():
                        try:
                            future.result()
                        except CancelledError:
                            context.abort(grpc.StatusCode.UNAVAILABLE,
                                          'Local decoder is shutting down')
                        continue
                    continue

                if event[0] == 'event':
                    payload = event[1]
                    if is_cancelled():
                        cancel_and_abort()
                    yield payload
                    continue
                if event[0] == 'error':
                    payload = event[1]
                    if isinstance(payload, (ValueError, TypeError)):
                        context.abort(grpc.StatusCode.INVALID_ARGUMENT, str(payload))
                    if isinstance(payload, GenerationCancelled):
                        cancel_and_abort()
                    if is_cancelled():
                        cancel_and_abort()
                    logging.getLogger(__name__).error(
                        'local decoder failed',
                        exc_info=(type(payload), payload, payload.__traceback__))
                    context.abort(grpc.StatusCode.INTERNAL, 'Local decoder failed; see server log')
                if is_cancelled():
                    cancel_and_abort()
                payload = event[1]
                usage = payload.get('usage') or {}
                final_result = completion_pb2.CompletionResult(
                    text=payload['text'], finish_reason=payload['finish_reason'])
                if 'prompt_tokens' in usage:
                    final_result.prompt_eval_count = int(usage['prompt_tokens'])
                if 'completion_tokens' in usage:
                    final_result.eval_count = int(usage['completion_tokens'])
                yield completion_pb2.CompletionEvent(final_result=final_result)
                return

        finally:
            cancelled.set()
            future.cancel()

    @staticmethod
    def _abort_cancelled(context: grpc.ServicerContext, deadline: float) -> NoReturn:
        if time.monotonic() >= deadline and context.is_active():
            context.abort(grpc.StatusCode.DEADLINE_EXCEEDED, 'Completion request timed out')
        context.abort(grpc.StatusCode.CANCELLED, 'Completion request cancelled')


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', default='NexVeridian/zeta-2.1-4bit')
    parser.add_argument('--qwen-model', default='mlx-community/Qwen2.5-Coder-7B-Instruct-4bit')
    parser.add_argument('--qwen-model-id', default='qwen2.5-coder-7b-instruct')
    parser.add_argument('--model-id', default='zeta-2.1')
    parser.add_argument('--socket-path', type=validate_socket_path, required=True,
                        help='Private absolute Unix socket path (at most 103 encoded bytes)')
    parser.add_argument('--request-timeout', type=float, default=30)
    parser.add_argument('--context-length', type=int)
    parser.add_argument('--cache-limit-mb', type=nonnegative_int, default=256)
    parser.add_argument('--status-file', help='Private atomic JSON setup status destination')
    parser.add_argument('--setup-id', help='Setup UUID associated with --status-file')
    args = parser.parse_args()
    if bool(args.status_file) != bool(args.setup_id):
        parser.error('--status-file and --setup-id must be supplied together')
    if args.setup_id:
        try:
            if str(uuid.UUID(args.setup_id)) != args.setup_id.lower():
                raise ValueError('Noncanonical UUID')
        except ValueError:
            parser.error('--setup-id must be a UUID')
    if args.model_id == args.qwen_model_id:
        parser.error('--model-id and --qwen-model-id must differ')
    observability.configure_tracing()
    progress = SetupProgress(args.status_file, args.setup_id)
    server = None
    socket_owner = None
    previous_sigterm = signal.getsignal(signal.SIGTERM)

    def terminate(signum: int, frame: FrameType | None) -> NoReturn:
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, terminate)
    try:
        progress.stage('resolving', 'Zeta', 1)
        allocator = MLXAllocator(args.cache_limit_mb)
        socket_owner = PrivateUnixSocket(args.socket_path)
        model_path = resolve_model(args.model, progress)
        progress.stage('loading', 'Zeta', 1)
        decoder = Decoder(model_path, context_length=args.context_length,
                          cache_limit_mb=args.cache_limit_mb, allocator=allocator)
        progress.stage('resolving', 'Qwen', 2)
        qwen_path = resolve_model(args.qwen_model, progress)
        progress.stage('loading', 'Qwen', 2)
        continuation_decoder = ContinuationDecoder(
            qwen_path, context_length=args.context_length,
            cache_limit_mb=args.cache_limit_mb, allocator=allocator)
        allocator.configure_residency(os.environ['MLX_METAL_RESIDENCY_REFRESH_INTERVAL_MS'])
        service = CompletionService(decoder, continuation_decoder,
                                    model_id=args.model_id,
                                    continuation_model_id=args.qwen_model_id,
                                    request_timeout=args.request_timeout)
        server = create_server(args.socket_path, service, socket_owner=socket_owner)
        socket_owner = None
        server.start()
        print(json.dumps({
            'pid': os.getpid(), 'ppid': os.getppid(), 'socket_path': args.socket_path,
            'model': args.model_id, 'models': [args.model_id, args.qwen_model_id], 'ready': True,
            'memory': decoder.memory_snapshot(),
            'continuation_memory': continuation_decoder.memory_snapshot()}), flush=True)
        progress.stage('ready')
        progress.close()
        server.wait_for_termination()
    except Exception as error:
        progress.error(error)
        raise
    finally:
        signal.signal(signal.SIGTERM, previous_sigterm)
        progress.close()
        try:
            if server is not None:
                server.stop(grace=0)
            elif socket_owner is not None:
                socket_owner.close()
        finally:
            observability.shutdown_tracing()


if __name__ == '__main__':
    main()
