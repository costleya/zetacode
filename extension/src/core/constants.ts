// Sweep model tokens
export const SWEEP_FILE_SEP_TOKEN = "<|file_sep|>";
export const STOP_TOKENS = ["<|file_sep|>", "</s>"];

// Default configuration
export const DEFAULT_MAX_CONTEXT_FILES = 5;
// Bound prompt history by size as well as count: a single bulk edit can be large.
export const DEFAULT_MAX_RECENT_CHANGES_CHARS = 12_000;
// Existing prompt policy, independent of how many edit records the tracker retains.
export const DEFAULT_MAX_PROMPT_HISTORY_EVENTS = 6;

// Surround each recorded edit with a small amount of unchanged source context.
export const DEFAULT_DIFF_CONTEXT_LINES = 2;
// Per-record diff text budget in JavaScript string units, not model tokens.
// Oversized bodies are truncated while preserving headers.
export const DEFAULT_MAX_DIFF_CHARS = 20_000;

// Estimated token budgets for the editable excerpt and surrounding source context.
export const DEFAULT_EDITABLE_TOKEN_BUDGET = 350;
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 150;
// Include diagnostics within this many lines of the cursor; zero disables filtering.
export const DEFAULT_DIAGNOSTIC_RADIUS_LINES = 12;
// Limit rendered related chunks independently of the number of tracked context files.
export const DEFAULT_RELATED_CHUNK_LIMIT = 5;

// Bound the number of completed identical-prompt responses retained in memory.
export const COMPLETION_CACHE_MAX_ENTRIES = 32;

// Treat the cursor as far away when it is more than this many lines outside the edit range.
// This is an editor presentation heuristic, not a model requirement.
export const EDIT_RANGE_PADDING_ROWS = 2;

// Editor request and context heuristics; these values are not model requirements.
// Delay requests that arrive less than this interval after the previous request.
export const INLINE_REQUEST_DEBOUNCE_MS = 50;
// Cap each source excerpt collected from an editor buffer.
export const MAX_FILE_CHUNK_LINES = 60;
// Suppress suggestions while a sufficiently large edit is still recent.
export const BULK_CHANGE_LOOKBACK_MS = 1_500;
export const BULK_CHANGE_CHAR_THRESHOLD = 200;
export const BULK_CHANGE_LINE_THRESHOLD = 8;
// Suppress suggestions for this long after a multi-line selection.
export const SELECTION_LOOKBACK_MS = 5_000;

// Model parameters
export const MODEL_NAME = "zeta-2.1";
export const CONTINUATION_MODEL_NAME = "qwen2.5-coder-7b-instruct";
// Required in runtime health checks; also used to keep telemetry model labels bounded.
export const LOCAL_MODEL_NAMES: readonly string[] = [MODEL_NAME, CONTINUATION_MODEL_NAME];
export const MAX_TOKENS = 2048;
export const TEMPERATURE = 0.0;

// FIM generation limits, preserved from the existing completion policy.
// This caps generated tokens; stop tokens can end a completion earlier.
export const CONTINUATION_MAX_TOKENS = 192;
// Must match the fixed repetition penalty enforced by the Python Qwen decoder.
export const CONTINUATION_REPEAT_PENALTY = 1.1;
// Also bounded by the remaining overall request deadline.
export const CONTINUATION_MAX_TIMEOUT_MS = 3_000;

// File size guards (match JetBrains defaults)
export const AUTOCOMPLETE_MAX_FILE_SIZE = 10_000_000;
export const AUTOCOMPLETE_MAX_LINES = 50_000;
export const AUTOCOMPLETE_AVG_LINE_LENGTH_THRESHOLD = 240;
