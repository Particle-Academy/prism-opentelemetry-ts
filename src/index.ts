/**
 * OpenTelemetry GenAI semantic-convention attribute and value keys.
 *
 * Held HERE rather than pulled from a semconv package, so churn in the
 * still-evolving GenAI conventions is a release of this package and not a hard
 * dependency bump. Same decision as the reference, same reason.
 *
 * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */
export const GenAi = {
  SYSTEM: 'gen_ai.system',
  OPERATION_NAME: 'gen_ai.operation.name',
  REQUEST_MODEL: 'gen_ai.request.model',
  RESPONSE_FINISH_REASONS: 'gen_ai.response.finish_reasons',
  USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  TOOL_NAME: 'gen_ai.tool.name',
  TOOL_CALL_ID: 'gen_ai.tool.call.id',
  // Prism-specific, namespaced so they cannot collide with semconv.
  USAGE_COST: 'gen_ai.usage.cost',
  STEP_INDEX: 'prism.step.index',
  TOOL_INDEX: 'prism.tool.index',
  OPERATION_EXECUTE_TOOL: 'execute_tool',

  /**
   * Provider rate limits — quota headroom, beside the latency.
   *
   * THE SEMANTIC CONVENTIONS DEFINE NOTHING FOR THIS. Checked 2026-09-05
   * against the gen_ai and http attribute registries: `gen_ai.*` has usage,
   * request and response namespaces and no quota anywhere in them, and the
   * closest thing in all of semconv is the generic, opt-in
   * `http.response.header.<key>` capture — which records a header verbatim and
   * knows nothing about which bucket it describes. `gen_ai.error.type` has a
   * `rate_limit` member, but that names a failure, not a headroom.
   *
   * So these are CUSTOM names, under `prism.` beside `STEP_INDEX` rather than
   * inside `gen_ai.`. Squatting in a standard namespace is worse than being
   * outside it: when a real `gen_ai.rate_limit.*` arrives, a backend must not
   * find two spellings of it meaning subtly different things. (`USAGE_COST`
   * above is the counter-example already in this file: it claims to be
   * namespaced away from semconv while sitting directly inside
   * `gen_ai.usage.`.)
   *
   * A rate limit is a LIST of buckets — requests, tokens, input-tokens — and a
   * span attribute is flat, so the list is flattened BY BUCKET NAME:
   *
   *     prism.rate_limit.buckets                  ["requests","tokens"]
   *     prism.rate_limit.requests.limit           1000
   *     prism.rate_limit.requests.remaining       999
   *     prism.rate_limit.requests.resets_at_unix  1788611696
   *
   * Name-keyed rather than index-keyed (`…rate_limit.0.limit`) or serialised
   * into one JSON blob, because the whole point is that a backend can FILTER on
   * it: `prism.rate_limit.tokens.remaining < 1000` is a numeric predicate a
   * dashboard can express, and it does not depend on which position the
   * provider happened to list the bucket in. A JSON blob is unfilterable, and
   * an index is a stable key for an unstable thing.
   *
   * The cost of name-keying is that the ATTRIBUTE KEY SPACE becomes
   * provider-controlled, which is a real hazard — backends index keys, and
   * unbounded keys are how an observability bill becomes an incident. Hence the
   * alphabet and the bucket cap below.
   */
  RATE_LIMIT_PREFIX: 'prism.rate_limit.',
  RATE_LIMIT_BUCKETS: 'prism.rate_limit.buckets',
  RATE_LIMIT_FIELD_LIMIT: 'limit',
  RATE_LIMIT_FIELD_REMAINING: 'remaining',

  /**
   * An INTEGER Unix epoch in SECONDS, floored — never a formatted date.
   *
   * Date formatting is precisely where three languages produce three strings
   * from one instant: an ISO-8601 rendering differs on the offset spelling
   * (`+00:00` vs `Z`), on whether fractional seconds appear, and on how many
   * digits of them. None of that errors; the two services simply stop matching.
   * An integer has one spelling in all three languages.
   *
   * The `_unix` suffix is not decoration. The reference's `ProviderRateLimit`
   * serialises `resets_at` as an ISO-8601 STRING, and a reader who saw the same
   * key here would reasonably expect the same value.
   */
  RATE_LIMIT_FIELD_RESETS_AT: 'resets_at_unix',

  /**
   * The only characters a bucket name may contain, spelled out.
   *
   * Not a regex, not `toLowerCase()` — an explicit codepoint set, spelled
   * identically in PHP, TypeScript and Python. This ecosystem has been bitten
   * by the alternative: a single trailing space defeated a tool-name
   * reservation in all three languages at once, and closing it with each
   * language's own `trim()` would have shut the ASCII hole and opened three new
   * Unicode ones.
   *
   * A bucket whose name contains anything else is DROPPED, not repaired.
   * Repairing means normalising, and normalising means two distinct names can
   * collapse onto one key — so a bucket called `tokens\u200B` could overwrite
   * the real `tokens`. Dropping cannot collide with anything.
   *
   * Every accepted character is one byte, so the length limit measures the same
   * thing whether counted in bytes (PHP), UTF-16 code units (JavaScript) or
   * codepoints (Python). That is why the alphabet is checked FIRST and the
   * length second.
   */
  RATE_LIMIT_NAME_ALPHABET: 'abcdefghijklmnopqrstuvwxyz0123456789-_',
  RATE_LIMIT_MAX_NAME_LENGTH: 64,

  /**
   * At most this many buckets reach a span, in the order the provider gave.
   *
   * The alphabet gate bounds what a key may LOOK like; it does not bound how
   * many there are. A provider (or anything sitting between us and one) that
   * returned ten thousand well-formed bucket names would otherwise put ten
   * thousand distinct attribute keys on every span.
   */
  RATE_LIMIT_MAX_BUCKETS: 16,
} as const;

/** OpenInference keys, which is what Phoenix and Arize read. */
export const OpenInference = {
  SPAN_KIND: 'openinference.span.kind',
  KIND_LLM: 'LLM',
  KIND_CHAIN: 'CHAIN',
  KIND_TOOL: 'TOOL',
  KIND_AGENT: 'AGENT',
  KIND_EMBEDDING: 'EMBEDDING',
  LLM_MODEL_NAME: 'llm.model_name',
  LLM_PROVIDER: 'llm.provider',
  LLM_SYSTEM: 'llm.system',
  TOKEN_COUNT_PROMPT: 'llm.token_count.prompt',
  TOKEN_COUNT_COMPLETION: 'llm.token_count.completion',
  TOKEN_COUNT_TOTAL: 'llm.token_count.total',
  INPUT_VALUE: 'input.value',
  INPUT_MIME_TYPE: 'input.mime_type',
  OUTPUT_VALUE: 'output.value',
  OUTPUT_MIME_TYPE: 'output.mime_type',
  TOOL_NAME: 'tool.name',
  TOOL_CALL_ID: 'tool.id',
  TOOL_PARAMETERS: 'tool.parameters',
  SESSION_ID: 'session.id',
  USER_ID: 'user.id',
  MIME_JSON: 'application/json',
  MIME_TEXT: 'text/plain',
} as const;

export type AttributeValue = string | number | boolean | readonly string[];

/**
 * The slice of an OpenTelemetry span this package uses.
 *
 * STRUCTURAL, not an import. `@opentelemetry/api`'s `Span` satisfies it, and so
 * does a fake — which keeps this package at zero dependencies and makes every
 * test below run without an SDK, an exporter or a collector.
 */
export interface Span {
  setAttribute(key: string, value: AttributeValue): unknown;
  setStatus(status: { code: 'ok' | 'error'; message?: string }): unknown;
  recordException(error: unknown): unknown;
  end(endTimeNanos?: number): unknown;
}

export interface StartSpanOptions {
  kind?: 'internal' | 'client';
  startTimeNanos?: number;
  /** The parent span, or null for a root. */
  parent?: Span | null;
}

export interface Tracer {
  startSpan(name: string, options?: StartSpanOptions): Span;
}

// -- the store ---------------------------------------------------------------

export interface PendingTool {
  name: string;
  callId: string | null;
  stepIndex: number | null;
  parameters: unknown;
  result: unknown;
  startNanos: number;
  endNanos: number;
  failed: boolean;
  error: unknown;
}

/**
 * Everything in flight for one generation, keyed by TRACE ID.
 *
 * Keyed by trace id and NOT by ambient context, which is the load-bearing
 * decision in this package. Prism's tool loop is recursive and re-entrant;
 * ambient scope does not survive it, so a child span parented off "whatever is
 * current" attaches to the wrong parent — or to nothing — as soon as a run has
 * more than one step. The root context is stored and looked up explicitly.
 */
export class SpanStore {
  readonly #roots = new Map<string, { span: Span; startNanos: number }>();

  readonly #boundaries = new Map<string, number>();

  readonly #stepSpans = new Map<string, Map<number, Span>>();

  readonly #tools = new Map<string, PendingTool[]>();

  start(traceId: string, span: Span, startNanos: number): void {
    this.#roots.set(traceId, { span, startNanos });
    this.#boundaries.set(traceId, startNanos);
  }

  has(traceId: string): boolean {
    return this.#roots.has(traceId);
  }

  span(traceId: string): Span | null {
    return this.#roots.get(traceId)?.span ?? null;
  }

  /**
   * Where the last child span ended.
   *
   * A step span has no start time of its own — Prism reports a step when it
   * COMPLETES — so its start is taken as the moment the previous one finished.
   * Without this every step would render as starting at the root, and the
   * waterfall would show parallel work that was strictly sequential.
   */
  boundaryNanos(traceId: string): number | null {
    return this.#boundaries.get(traceId) ?? null;
  }

  setBoundaryNanos(traceId: string, nanos: number): void {
    this.#boundaries.set(traceId, nanos);
  }

  recordStepSpan(traceId: string, stepIndex: number, span: Span): void {
    const steps = this.#stepSpans.get(traceId) ?? new Map<number, Span>();
    steps.set(stepIndex, span);
    this.#stepSpans.set(traceId, steps);
  }

  stepSpan(traceId: string, stepIndex: number): Span | null {
    return this.#stepSpans.get(traceId)?.get(stepIndex) ?? null;
  }

  /**
   * Hold a tool call until the step it belongs to arrives.
   *
   * Tools are reported as they are invoked, and the step that contains them
   * only afterwards. Emitting a tool span immediately would leave it parented
   * to the root rather than to its step.
   */
  bufferTool(traceId: string, tool: PendingTool): void {
    const buffered = this.#tools.get(traceId) ?? [];
    buffered.push(tool);
    this.#tools.set(traceId, buffered);
  }

  /** The buffered tools for a step, removed from the buffer. */
  takeToolsForStep(traceId: string, stepIndex: number): PendingTool[] {
    const buffered = this.#tools.get(traceId) ?? [];
    const taken: PendingTool[] = [];
    const kept: PendingTool[] = [];

    for (const tool of buffered) {
      // A tool with no step index belongs to the step being closed now: it was
      // invoked before the step reported itself, which is the ordinary case.
      if (tool.stepIndex === null || tool.stepIndex === stepIndex) taken.push(tool);
      else kept.push(tool);
    }

    this.#tools.set(traceId, kept);

    return taken;
  }

  /**
   * Whatever is left when the generation ends.
   *
   * A run that failed mid-step leaves tools buffered against a step that will
   * never be reported. Dropping them would lose the record of the call that was
   * in flight when it broke — which is the one a reader most wants.
   */
  takeRemainingTools(traceId: string): PendingTool[] {
    const buffered = this.#tools.get(traceId) ?? [];
    this.#tools.delete(traceId);

    return buffered;
  }

  forget(traceId: string): void {
    this.#roots.delete(traceId);
    this.#boundaries.delete(traceId);
    this.#stepSpans.delete(traceId);
    this.#tools.delete(traceId);
  }

  /** How many generations are still open. For a leak check, not for logic. */
  get size(): number {
    return this.#roots.size;
  }
}

// -- the subscriber ----------------------------------------------------------

export interface GenerationContext {
  traceId: string;
  operation: string;
  provider: string;
  model: string;
  sessionId?: string | null;
  userId?: string | null;
}

export interface Usage {
  promptTokens?: number | null;
  completionTokens?: number | null;
  cost?: number | null;
}

/**
 * One quota bucket the provider reported — `requests`, `tokens`, and so on.
 *
 * `resetsAt` is a `Date` and NOT a number, so there is no chance of a caller
 * handing over seconds where the code expected milliseconds; the conversion to
 * the exported epoch happens in exactly one place.
 *
 * The field names are `prism-ts`'s own rather than a translation of them: its
 * `ProviderRateLimit` carries exactly `name`, `limit`, `remaining` and
 * `resetsAt`, so one satisfies this interface structurally and can be handed
 * over directly. A shape invented here would have needed an adapter forever.
 */
export interface RateLimit {
  name: string;
  limit?: number | null;
  remaining?: number | null;
  resetsAt?: Date | null;
}

export interface TelemetryOptions {
  recordExceptions?: boolean;
  /**
   * Cap the length of any single captured-content attribute.
   *
   * A hostile or simply high-volume payload must not be able to bloat a span or
   * the OTLP export. 0 disables the cap.
   */
  maxContentLength?: number;
  /**
   * Capture prompts, completions and tool arguments at all. OFF BY DEFAULT.
   *
   * This is the one setting in the package with a privacy consequence: those
   * values are user content, and a span export leaves the application. The
   * reference gates the same values; here it is a single explicit switch so
   * nobody has to infer from three config keys whether content is leaving.
   */
  captureContent?: boolean;
  now?: () => number;
}

/**
 * Builds GenAI-convention spans from Prism's telemetry events.
 *
 * One root span per generation; child spans per step and per tool call,
 * parented deterministically off the STORED root — never ambient scope, which
 * does not survive Prism's recursive tool loop.
 */
export class TelemetrySubscriber {
  readonly #tracer: Tracer;

  readonly #store: SpanStore;

  readonly #recordExceptions: boolean;

  readonly #maxContentLength: number;

  readonly #captureContent: boolean;

  readonly #now: () => number;

  constructor(tracer: Tracer, store: SpanStore = new SpanStore(), options: TelemetryOptions = {}) {
    this.#tracer = tracer;
    this.#store = store;
    this.#recordExceptions = options.recordExceptions ?? true;
    this.#maxContentLength = options.maxContentLength ?? 65_536;
    this.#captureContent = options.captureContent ?? false;
    this.#now = options.now ?? (() => Date.now() * 1_000_000);
  }

  get store(): SpanStore {
    return this.#store;
  }

  onGenerationStarted(context: GenerationContext, input?: unknown): void {
    const startNanos = this.#now();
    const span = this.#tracer.startSpan(`${context.operation} ${context.model}`, {
      startTimeNanos: startNanos,
      parent: null,
    });

    span.setAttribute(GenAi.OPERATION_NAME, context.operation);
    span.setAttribute(GenAi.SYSTEM, context.provider);
    span.setAttribute(GenAi.REQUEST_MODEL, context.model);
    span.setAttribute(OpenInference.SPAN_KIND, this.#rootKind(context.operation));
    span.setAttribute(OpenInference.LLM_MODEL_NAME, context.model);
    span.setAttribute(OpenInference.LLM_PROVIDER, context.provider);
    span.setAttribute(OpenInference.LLM_SYSTEM, context.provider);

    if (typeof context.sessionId === 'string') {
      span.setAttribute(OpenInference.SESSION_ID, context.sessionId);
    }

    if (typeof context.userId === 'string') {
      span.setAttribute(OpenInference.USER_ID, context.userId);
    }

    this.#capture(span, OpenInference.INPUT_VALUE, input, OpenInference.INPUT_MIME_TYPE);
    this.#store.start(context.traceId, span, startNanos);
  }

  onStepCompleted(traceId: string, stepIndex: number, model: string, provider: string, usage?: Usage): void {
    const root = this.#store.span(traceId);
    if (root === null) return;

    const start = this.#store.boundaryNanos(traceId) ?? this.#now();
    const end = this.#now();

    const span = this.#tracer.startSpan(`step ${stepIndex}`, {
      startTimeNanos: start,
      parent: root,
    });

    span.setAttribute(OpenInference.SPAN_KIND, OpenInference.KIND_LLM);
    span.setAttribute(GenAi.STEP_INDEX, stepIndex);
    span.setAttribute(OpenInference.LLM_MODEL_NAME, model);
    span.setAttribute(OpenInference.LLM_PROVIDER, provider);
    this.#applyUsage(span, usage);

    this.#store.recordStepSpan(traceId, stepIndex, span);

    // The tools invoked during this step, emitted as its children now that
    // there is a step to parent them to.
    for (const [index, tool] of this.#store.takeToolsForStep(traceId, stepIndex).entries()) {
      this.#emitTool(tool, span, index);
    }

    span.end(end);
    this.#store.setBoundaryNanos(traceId, end);
  }

  onToolInvoked(traceId: string, tool: Omit<PendingTool, 'startNanos' | 'endNanos'> & Partial<Pick<PendingTool, 'startNanos' | 'endNanos'>>): void {
    if (!this.#store.has(traceId)) return;

    const now = this.#now();

    this.#store.bufferTool(traceId, {
      ...tool,
      startNanos: tool.startNanos ?? now,
      endNanos: tool.endNanos ?? now,
    });
  }

  onGenerationCompleted(
    traceId: string,
    result: {
      finishReason?: string | null;
      usage?: Usage;
      output?: unknown;
      rateLimits?: readonly RateLimit[] | null;
    } = {},
  ): void {
    const span = this.#store.span(traceId);
    if (span === null) return;

    // Anything still buffered belonged to a step that never reported. Parented
    // to the ROOT rather than dropped: losing the call in flight when a run
    // ended is losing the record a reader most wants.
    for (const [index, tool] of this.#store.takeRemainingTools(traceId).entries()) {
      this.#emitTool(tool, span, index);
    }

    if (typeof result.finishReason === 'string') {
      span.setAttribute(GenAi.RESPONSE_FINISH_REASONS, [result.finishReason]);
    }

    this.#applyUsage(span, result.usage);
    this.#applyRateLimits(span, result.rateLimits);
    this.#capture(span, OpenInference.OUTPUT_VALUE, result.output, OpenInference.OUTPUT_MIME_TYPE);

    span.setStatus({ code: 'ok' });
    span.end(this.#now());
    this.#store.forget(traceId);
  }

  onGenerationFailed(traceId: string, error: unknown): void {
    const span = this.#store.span(traceId);
    if (span === null) return;

    for (const [index, tool] of this.#store.takeRemainingTools(traceId).entries()) {
      this.#emitTool(tool, span, index);
    }

    // The 429 is the moment an operator most wants the quota numbers, and it is
    // the one moment they are guaranteed to be reachable: a rate limited
    // generation has no response for them to travel on, so they travel on the
    // error instead.
    if (typeof error === 'object' && error !== null && 'rateLimits' in error) {
      this.#applyRateLimits(span, (error as { rateLimits?: unknown }).rateLimits);
    }

    if (this.#recordExceptions) span.recordException(error);

    span.setStatus({
      code: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
    span.end(this.#now());
    this.#store.forget(traceId);
  }

  #emitTool(tool: PendingTool, parent: Span, index: number): void {
    const span = this.#tracer.startSpan(`${GenAi.OPERATION_EXECUTE_TOOL} ${tool.name}`, {
      startTimeNanos: tool.startNanos,
      parent,
    });

    span.setAttribute(GenAi.OPERATION_NAME, GenAi.OPERATION_EXECUTE_TOOL);
    span.setAttribute(GenAi.TOOL_NAME, tool.name);
    span.setAttribute(GenAi.TOOL_INDEX, index);
    span.setAttribute(OpenInference.SPAN_KIND, OpenInference.KIND_TOOL);
    span.setAttribute(OpenInference.TOOL_NAME, tool.name);

    if (typeof tool.callId === 'string') {
      span.setAttribute(GenAi.TOOL_CALL_ID, tool.callId);
      span.setAttribute(OpenInference.TOOL_CALL_ID, tool.callId);
    }

    this.#capture(span, OpenInference.TOOL_PARAMETERS, tool.parameters, null);
    this.#capture(span, OpenInference.INPUT_VALUE, tool.parameters, OpenInference.INPUT_MIME_TYPE);
    this.#capture(span, OpenInference.OUTPUT_VALUE, tool.result, OpenInference.OUTPUT_MIME_TYPE);

    if (tool.failed) {
      if (this.#recordExceptions) span.recordException(tool.error);
      span.setStatus({ code: 'error' });
    } else {
      span.setStatus({ code: 'ok' });
    }

    span.end(tool.endNanos);
  }

  #applyUsage(span: Span, usage?: Usage): void {
    if (usage === undefined) return;

    const prompt = usage.promptTokens ?? null;
    const completion = usage.completionTokens ?? null;

    if (prompt !== null) {
      span.setAttribute(GenAi.USAGE_INPUT_TOKENS, prompt);
      span.setAttribute(OpenInference.TOKEN_COUNT_PROMPT, prompt);
    }

    if (completion !== null) {
      span.setAttribute(GenAi.USAGE_OUTPUT_TOKENS, completion);
      span.setAttribute(OpenInference.TOKEN_COUNT_COMPLETION, completion);
    }

    if (prompt !== null && completion !== null) {
      span.setAttribute(OpenInference.TOKEN_COUNT_TOTAL, prompt + completion);
    }

    // NULL IS NOT ZERO. Not every provider reports a cost, and writing 0 would
    // make a span that spent money indistinguishable from one that did not.
    if (typeof usage.cost === 'number') {
      span.setAttribute(GenAi.USAGE_COST, usage.cost);
    }
  }

  /**
   * Flatten the provider's rate-limit buckets onto the span.
   *
   * Present-and-empty and absent are different values to a backend, so a
   * provider that reported no rate limits writes NOTHING here. That is the
   * ORDINARY case rather than an edge one: several providers report no quota
   * headers at all. An empty `prism.rate_limit.buckets` would claim we asked
   * and were told nothing, which is not the same as never having been told.
   *
   * The same rule one level down: a bucket contributes a key only for the
   * fields the provider actually sent, and a bucket that sent no field at all
   * does not appear in `buckets` either. See `GenAi` for why the flattening is
   * by name, and what bounds the key space.
   *
   * Takes `unknown` rather than `RateLimit[]`: the failure path is handed an
   * arbitrary thrown value, and a type annotation is not a runtime check.
   */
  #applyRateLimits(span: Span, rateLimits: unknown): void {
    if (!Array.isArray(rateLimits)) return;

    const exported: string[] = [];

    for (const entry of rateLimits as readonly unknown[]) {
      if (exported.length >= GenAi.RATE_LIMIT_MAX_BUCKETS) break;
      if (typeof entry !== 'object' || entry === null) continue;

      const limit = entry as Partial<RateLimit>;
      const name = typeof limit.name === 'string' ? this.#rateLimitBucketName(limit.name) : null;

      // FIRST bucket of a name wins. A later duplicate — which only a
      // hand-built list or a hostile provider produces — must not be able to
      // overwrite the numbers already on the span.
      if (name === null || exported.includes(name)) continue;

      const fields: [string, number][] = [];

      if (Number.isInteger(limit.limit)) {
        fields.push([GenAi.RATE_LIMIT_FIELD_LIMIT, limit.limit as number]);
      }

      if (Number.isInteger(limit.remaining)) {
        fields.push([GenAi.RATE_LIMIT_FIELD_REMAINING, limit.remaining as number]);
      }

      // Seconds, FLOORED — the same direction as PHP's
      // DateTimeInterface::getTimestamp() and Python's math.floor.
      if (limit.resetsAt instanceof Date && Number.isFinite(limit.resetsAt.getTime())) {
        fields.push([GenAi.RATE_LIMIT_FIELD_RESETS_AT, Math.floor(limit.resetsAt.getTime() / 1000)]);
      }

      if (fields.length === 0) continue;

      for (const [field, value] of fields) {
        span.setAttribute(`${GenAi.RATE_LIMIT_PREFIX}${name}.${field}`, value);
      }

      exported.push(name);
    }

    if (exported.length > 0) span.setAttribute(GenAi.RATE_LIMIT_BUCKETS, exported);
  }

  /**
   * A bucket name that is safe to make part of an attribute KEY, or null.
   *
   * Alphabet first, length second — see `GenAi.RATE_LIMIT_NAME_ALPHABET`.
   */
  #rateLimitBucketName(name: string): string | null {
    if (name === '') return null;

    for (const character of name) {
      if (!GenAi.RATE_LIMIT_NAME_ALPHABET.includes(character)) return null;
    }

    return name.length > GenAi.RATE_LIMIT_MAX_NAME_LENGTH ? null : name;
  }

  /**
   * Write a captured-content attribute — or do not.
   *
   * Gated and bounded in one place, because the two are the same decision: what
   * leaves the application, and how much of it.
   */
  #capture(span: Span, key: string, value: unknown, mimeKey: string | null): void {
    if (!this.#captureContent || value === undefined || value === null) return;

    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text === undefined) return;

    span.setAttribute(key, this.#bounded(text));

    if (mimeKey !== null) {
      span.setAttribute(
        mimeKey,
        typeof value === 'string' ? OpenInference.MIME_TEXT : OpenInference.MIME_JSON,
      );
    }
  }

  #bounded(value: string): string {
    if (this.#maxContentLength <= 0 || value.length <= this.#maxContentLength) return value;

    return `${value.slice(0, this.#maxContentLength)}…[truncated]`;
  }

  #rootKind(operation: string): string {
    if (operation === 'embeddings') return OpenInference.KIND_EMBEDDING;
    if (operation === 'text' || operation === 'structured') return OpenInference.KIND_CHAIN;

    return OpenInference.KIND_LLM;
  }
}
