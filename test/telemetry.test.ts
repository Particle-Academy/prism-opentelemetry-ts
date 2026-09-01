import { describe, expect, it } from 'vitest';
import {
  GenAi,
  OpenInference,
  SpanStore,
  TelemetrySubscriber,
  type Span,
  type StartSpanOptions,
  type Tracer,
} from '../src/index.js';

interface Recorded {
  name: string;
  parent: Recorded | null;
  attributes: Record<string, unknown>;
  status: { code: string; message?: string } | null;
  exceptions: unknown[];
  startNanos: number | undefined;
  endNanos: number | undefined;
}

/** A tracer that records rather than exports. No SDK, no collector, no network. */
function recorder(): { tracer: Tracer; spans: Recorded[] } {
  const spans: Recorded[] = [];
  const byRef = new Map<Span, Recorded>();

  const tracer: Tracer = {
    startSpan(name: string, options: StartSpanOptions = {}) {
      const recordedParent = options.parent ? (byRef.get(options.parent) ?? null) : null;
      const record: Recorded = {
        name,
        parent: recordedParent,
        attributes: {},
        status: null,
        exceptions: [],
        startNanos: options.startTimeNanos,
        endNanos: undefined,
      };

      const span: Span = {
        setAttribute: (key, value) => (record.attributes[key] = value),
        setStatus: (status) => (record.status = status),
        recordException: (error) => record.exceptions.push(error),
        end: (endTimeNanos) => (record.endNanos = endTimeNanos),
      };

      byRef.set(span, record);
      spans.push(record);

      return span;
    },
  };

  return { tracer, spans };
}

function clock(): () => number {
  let nanos = 1_000;

  return () => (nanos += 1_000);
}

const context = {
  traceId: 'trace-1',
  operation: 'text',
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
};

describe('the root span', () => {
  it('carries both attribute conventions', () => {
    const { tracer, spans } = recorder();
    const subscriber = new TelemetrySubscriber(tracer, new SpanStore(), { now: clock() });

    subscriber.onGenerationStarted(context);

    expect(spans[0]?.name).toBe('text claude-sonnet-4-5');
    expect(spans[0]?.attributes).toMatchObject({
      [GenAi.OPERATION_NAME]: 'text',
      [GenAi.SYSTEM]: 'anthropic',
      [GenAi.REQUEST_MODEL]: 'claude-sonnet-4-5',
      [OpenInference.LLM_MODEL_NAME]: 'claude-sonnet-4-5',
      [OpenInference.SPAN_KIND]: OpenInference.KIND_CHAIN,
    });
  });

  it('marks an embeddings run as an EMBEDDING span, not an LLM one', () => {
    const { tracer, spans } = recorder();
    new TelemetrySubscriber(tracer, new SpanStore(), { now: clock() }).onGenerationStarted({
      ...context,
      operation: 'embeddings',
    });

    expect(spans[0]?.attributes[OpenInference.SPAN_KIND]).toBe(OpenInference.KIND_EMBEDDING);
  });

  it('records session and user only when they are given', () => {
    const { tracer, spans } = recorder();
    const subscriber = new TelemetrySubscriber(tracer, new SpanStore(), { now: clock() });

    subscriber.onGenerationStarted({ ...context, sessionId: 's-1' });

    expect(spans[0]?.attributes[OpenInference.SESSION_ID]).toBe('s-1');
    expect(spans[0]?.attributes).not.toHaveProperty(OpenInference.USER_ID);
  });

  it('ends ok and forgets the trace', () => {
    const { tracer, spans } = recorder();
    const store = new SpanStore();
    const subscriber = new TelemetrySubscriber(tracer, store, { now: clock() });

    subscriber.onGenerationStarted(context);
    subscriber.onGenerationCompleted('trace-1', { finishReason: 'stop' });

    expect(spans[0]?.status).toEqual({ code: 'ok' });
    expect(spans[0]?.attributes[GenAi.RESPONSE_FINISH_REASONS]).toEqual(['stop']);
    // No leak: a store that keeps every trace is a memory leak in a long process.
    expect(store.size).toBe(0);
  });

  it('records the exception on failure, and can be told not to', () => {
    const failure = new Error('provider is down');

    const withRecording = recorder();
    const one = new TelemetrySubscriber(withRecording.tracer, new SpanStore(), { now: clock() });
    one.onGenerationStarted(context);
    one.onGenerationFailed('trace-1', failure);

    expect(withRecording.spans[0]?.exceptions).toEqual([failure]);
    expect(withRecording.spans[0]?.status).toMatchObject({ code: 'error', message: 'provider is down' });

    const without = recorder();
    const two = new TelemetrySubscriber(without.tracer, new SpanStore(), {
      now: clock(),
      recordExceptions: false,
    });
    two.onGenerationStarted(context);
    two.onGenerationFailed('trace-1', failure);

    expect(without.spans[0]?.exceptions).toEqual([]);
    // The status still says it failed — suppressing the exception must not
    // suppress the fact that it happened.
    expect(without.spans[0]?.status?.code).toBe('error');
  });

  it('ignores an event for a trace it never saw start', () => {
    const { tracer, spans } = recorder();
    const subscriber = new TelemetrySubscriber(tracer, new SpanStore(), { now: clock() });

    subscriber.onStepCompleted('unknown', 0, 'm', 'p');
    subscriber.onGenerationCompleted('unknown');
    subscriber.onGenerationFailed('unknown', new Error('x'));

    expect(spans).toEqual([]);
  });
});

describe('steps and tools', () => {
  it('parents a step off the STORED root, not ambient scope', () => {
    // The load-bearing decision. Prism's tool loop is recursive; ambient scope
    // does not survive it, so a span parented to "whatever is current" attaches
    // to the wrong parent as soon as a run has more than one step.
    const { tracer, spans } = recorder();
    const subscriber = new TelemetrySubscriber(tracer, new SpanStore(), { now: clock() });

    subscriber.onGenerationStarted(context);
    subscriber.onStepCompleted('trace-1', 0, 'm', 'p');
    subscriber.onStepCompleted('trace-1', 1, 'm', 'p');

    expect(spans[1]?.parent).toBe(spans[0]);
    expect(spans[2]?.parent).toBe(spans[0]);
  });

  it('starts each step where the previous one ended', () => {
    // Prism reports a step when it COMPLETES, so a step has no start of its
    // own. Without the boundary every step would render as starting at the
    // root, showing parallel work that was strictly sequential.
    const { tracer, spans } = recorder();
    const subscriber = new TelemetrySubscriber(tracer, new SpanStore(), { now: clock() });

    subscriber.onGenerationStarted(context);
    subscriber.onStepCompleted('trace-1', 0, 'm', 'p');
    subscriber.onStepCompleted('trace-1', 1, 'm', 'p');

    expect(spans[2]?.startNanos).toBe(spans[1]?.endNanos);
  });

  it('BUFFERS a tool until its step arrives, then parents it there', () => {
    // Tools are reported as they are invoked and the step only afterwards.
    // Emitting immediately would leave the tool parented to the root.
    const { tracer, spans } = recorder();
    const subscriber = new TelemetrySubscriber(tracer, new SpanStore(), { now: clock() });

    subscriber.onGenerationStarted(context);
    subscriber.onToolInvoked('trace-1', {
      name: 'search',
      callId: 'c1',
      stepIndex: 0,
      parameters: { q: 'x' },
      result: 'found',
      failed: false,
      error: null,
    });

    // Nothing yet: only the root exists.
    expect(spans).toHaveLength(1);

    subscriber.onStepCompleted('trace-1', 0, 'm', 'p');

    const tool = spans.find((span) => span.name.includes('search'));
    expect(tool?.parent?.name).toBe('step 0');
    expect(tool?.attributes[GenAi.TOOL_NAME]).toBe('search');
    expect(tool?.attributes[OpenInference.SPAN_KIND]).toBe(OpenInference.KIND_TOOL);
  });

  it('keeps a later step\'s tools buffered', () => {
    const { tracer, spans } = recorder();
    const subscriber = new TelemetrySubscriber(tracer, new SpanStore(), { now: clock() });

    subscriber.onGenerationStarted(context);
    subscriber.onToolInvoked('trace-1', {
      name: 'later',
      callId: null,
      stepIndex: 3,
      parameters: null,
      result: null,
      failed: false,
      error: null,
    });
    subscriber.onStepCompleted('trace-1', 0, 'm', 'p');

    expect(spans.some((span) => span.name.includes('later'))).toBe(false);
  });

  it('emits a tool left in flight when the run FAILS, parented to the root', () => {
    // A run that broke mid-step leaves tools buffered against a step that will
    // never be reported. Dropping them loses the record of the call that was
    // running when it broke — the one a reader most wants.
    const { tracer, spans } = recorder();
    const subscriber = new TelemetrySubscriber(tracer, new SpanStore(), { now: clock() });

    subscriber.onGenerationStarted(context);
    subscriber.onToolInvoked('trace-1', {
      name: 'in_flight',
      callId: null,
      stepIndex: null,
      parameters: null,
      result: null,
      failed: true,
      error: new Error('tool blew up'),
    });
    subscriber.onGenerationFailed('trace-1', new Error('run blew up'));

    const tool = spans.find((span) => span.name.includes('in_flight'));
    expect(tool).toBeDefined();
    expect(tool?.parent).toBe(spans[0]);
    expect(tool?.status?.code).toBe('error');
  });

  it('ignores a tool for a trace it never saw start', () => {
    const { tracer, spans } = recorder();
    const subscriber = new TelemetrySubscriber(tracer, new SpanStore(), { now: clock() });

    subscriber.onToolInvoked('ghost', {
      name: 'x',
      callId: null,
      stepIndex: null,
      parameters: null,
      result: null,
      failed: false,
      error: null,
    });

    expect(spans).toEqual([]);
  });
});

describe('usage', () => {
  it('writes both conventions and the total', () => {
    const { tracer, spans } = recorder();
    const subscriber = new TelemetrySubscriber(tracer, new SpanStore(), { now: clock() });

    subscriber.onGenerationStarted(context);
    subscriber.onGenerationCompleted('trace-1', {
      usage: { promptTokens: 10, completionTokens: 5, cost: 0.02 },
    });

    expect(spans[0]?.attributes).toMatchObject({
      [GenAi.USAGE_INPUT_TOKENS]: 10,
      [GenAi.USAGE_OUTPUT_TOKENS]: 5,
      [OpenInference.TOKEN_COUNT_TOTAL]: 15,
      [GenAi.USAGE_COST]: 0.02,
    });
  });

  it('does NOT write a cost of zero when the provider reported none', () => {
    // Writing 0 would make a span that spent money indistinguishable from one
    // that did not.
    const { tracer, spans } = recorder();
    const subscriber = new TelemetrySubscriber(tracer, new SpanStore(), { now: clock() });

    subscriber.onGenerationStarted(context);
    subscriber.onGenerationCompleted('trace-1', { usage: { promptTokens: 1, cost: null } });

    expect(spans[0]?.attributes).not.toHaveProperty(GenAi.USAGE_COST);
    // And no bogus total from one half of the pair.
    expect(spans[0]?.attributes).not.toHaveProperty(OpenInference.TOKEN_COUNT_TOTAL);
  });
});

describe('captured content', () => {
  it('is OFF by default', () => {
    // The one setting here with a privacy consequence: prompts and tool
    // arguments are user content, and a span export leaves the application.
    const { tracer, spans } = recorder();
    const subscriber = new TelemetrySubscriber(tracer, new SpanStore(), { now: clock() });

    subscriber.onGenerationStarted(context, 'a private prompt');
    subscriber.onGenerationCompleted('trace-1', { output: 'a private answer' });

    expect(JSON.stringify(spans)).not.toContain('private');
  });

  it('is written when it is turned on', () => {
    const { tracer, spans } = recorder();
    const subscriber = new TelemetrySubscriber(tracer, new SpanStore(), {
      now: clock(),
      captureContent: true,
    });

    subscriber.onGenerationStarted(context, 'the prompt');
    subscriber.onGenerationCompleted('trace-1', { output: 'the answer' });

    expect(spans[0]?.attributes[OpenInference.INPUT_VALUE]).toBe('the prompt');
    expect(spans[0]?.attributes[OpenInference.OUTPUT_VALUE]).toBe('the answer');
    expect(spans[0]?.attributes[OpenInference.INPUT_MIME_TYPE]).toBe(OpenInference.MIME_TEXT);
  });

  it('marks a structured value as JSON', () => {
    const { tracer, spans } = recorder();
    const subscriber = new TelemetrySubscriber(tracer, new SpanStore(), {
      now: clock(),
      captureContent: true,
    });

    subscriber.onGenerationStarted(context, { messages: [] });

    expect(spans[0]?.attributes[OpenInference.INPUT_MIME_TYPE]).toBe(OpenInference.MIME_JSON);
  });

  it('TRUNCATES a payload past the cap', () => {
    // A hostile or high-volume payload must not be able to bloat a span or the
    // OTLP export.
    const { tracer, spans } = recorder();
    const subscriber = new TelemetrySubscriber(tracer, new SpanStore(), {
      now: clock(),
      captureContent: true,
      maxContentLength: 10,
    });

    subscriber.onGenerationStarted(context, 'x'.repeat(500));

    const captured = spans[0]?.attributes[OpenInference.INPUT_VALUE] as string;
    expect(captured).toBe(`${'x'.repeat(10)}…[truncated]`);
  });

  it('lets the cap be disabled with 0', () => {
    const { tracer, spans } = recorder();
    const subscriber = new TelemetrySubscriber(tracer, new SpanStore(), {
      now: clock(),
      captureContent: true,
      maxContentLength: 0,
    });

    subscriber.onGenerationStarted(context, 'y'.repeat(500));

    expect((spans[0]?.attributes[OpenInference.INPUT_VALUE] as string).length).toBe(500);
  });

  it('never writes tool arguments while capture is off', () => {
    const { tracer, spans } = recorder();
    const subscriber = new TelemetrySubscriber(tracer, new SpanStore(), { now: clock() });

    subscriber.onGenerationStarted(context);
    subscriber.onToolInvoked('trace-1', {
      name: 'search',
      callId: 'c1',
      stepIndex: 0,
      parameters: { query: 'a secret' },
      result: 'a secret result',
      failed: false,
      error: null,
    });
    subscriber.onStepCompleted('trace-1', 0, 'm', 'p');

    // The NAME is recorded — that is what an operator audits a guardrail with,
    // and it is not user content. The arguments are not.
    expect(JSON.stringify(spans)).toContain('search');
    expect(JSON.stringify(spans)).not.toContain('secret');
  });
});
