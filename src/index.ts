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
    result: { finishReason?: string | null; usage?: Usage; output?: unknown } = {},
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
