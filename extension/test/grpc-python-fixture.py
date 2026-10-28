"""Model-free process fixture using the production Python gRPC service."""
import json
from pathlib import Path
import sys
import threading
import types

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'server/src'))
# Importing the service must not initialize MLX or load either model for wire tests.
decoder = types.ModuleType('decoder')
decoder.Decoder = object
decoder.MLXAllocator = object
decoder.nonnegative_int = int
decoder.GenerationCancelled = type('GenerationCancelled', (InterruptedError,), {})
sys.modules['decoder'] = decoder
continuation = types.ModuleType('continuation_decoder')
continuation.ContinuationDecoder = object
sys.modules['continuation_decoder'] = continuation
from server import CompletionService, create_server

class FakeDecoder:
    def __init__(self, qwen=False):
        self.qwen = qwen
    def generate(self, prompt, **options):
        if prompt == 'cancel-me':
            callback = options.get('on_first_token')
            if callback:
                callback()
            wait = threading.Event()
            while not options['cancelled']():
                wait.wait(.005)
            raise decoder.GenerationCancelled('cancelled')
        callback = options.get('on_first_token')
        if callback:
            callback()
        callback = options.get('on_no_edit_impossible')
        if callback:
            callback()
        observed = {'model': 'qwen' if self.qwen else 'zeta', 'prompt': prompt,
                    'maxTokens': options['max_tokens'], 'stop': options['stop']}
        return {'text': json.dumps(observed, ensure_ascii=False), 'finish_reason': 'stop',
                'usage': {'prompt_tokens': 17, 'completion_tokens': 3}}

service = CompletionService(FakeDecoder(), FakeDecoder(True))
server = create_server(sys.argv[1], service)
server.start()
print(json.dumps({'ready': True}), flush=True)
try:
    sys.stdin.readline()
finally:
    server.stop(0)
