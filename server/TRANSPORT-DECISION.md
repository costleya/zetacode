# Completion transport decision — October 2026

Selected gRPC over the private Unix socket for the shared typed schema, generated TypeScript/Python clients, streaming milestones, deadlines, and cancellation.

A one-time comparison used 12 real source-edit scenarios with local Zeta inference, one warmup and five measured repetitions per case. Warm median latency was 340.248 ms for gRPC versus its paired HTTP baseline of 340.545 ms; JSON-RPC measured 338.060 ms versus 337.402 ms for its paired HTTP baseline. Neither alternative demonstrated a meaningful latency advantage. These measurements exclude live editor debounce, context collection, rendering, and Qwen fallback.

Outputs matched across transports. Eight of twelve cases matched the expected source exactly; two were valid alternatives, one made an unnecessary edit, and one incorrectly renamed a public property. These were model-quality findings, not transport differences.

Production integration subsequently passed 433 TypeScript tests, 100 Python tests, build and package checks, and cross-language integration. Real-model verification reproduced all 12 previous HTTP outputs, exercised Qwen completion, and passed cancellation/recovery. Live VS Code interaction was not verified in that run.

The one-time harnesses, fixtures, and raw results were removed after the decision. Production protocol generation and regression tests remain.
