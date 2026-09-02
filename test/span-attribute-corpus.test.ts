import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SpanStore, TelemetrySubscriber, type Span, type Tracer } from '../src/index.js';

/**
 * The cross-language span-attribute corpus from `prism-parity`.
 *
 * A span LEAVES the application and is read by a backend that has no idea which
 * language produced it. Phoenix groups by `session.id`, filters by
 * `gen_ai.operation.name` and `gen_ai.response.finish_reasons`, and dedupes on
 * `input.value`. Every one of those is a string comparison against spans from
 * other services, so a key or a value spelled differently here does not error —
 * this service and a PHP one simply stop appearing in the same result, and a
 * dashboard that looks complete is quietly missing half its traffic.
 *
 * That is the failure a per-language suite cannot see, because each one asserts
 * against the attribute map its own code produced.
 *
 * SIX of these rows disagree with the reference in ways that are pinned below
 * IN THE NEGATIVE. That is deliberate: each disagreement needs a decision that
 * spans three repositories, and a negative pin means whoever makes it gets a
 * red test here rather than a silent change of meaning.
 */
interface RecordedSpan {
  name: string;
  status: string;
  attributes: Record<string, unknown>;
}

interface CorpusCase {
  id: string;
  title: string;
  generation: {
    operation: string;
    provider: string;
    model: string;
    session_id: string | null;
    user_id: string | null;
    finish_reason: string | null;
    usage: { prompt_tokens: number; completion_tokens: number; cost: number | null } | null;
    input: Record<string, unknown> | null;
    output: Record<string, unknown> | null;
  };
  capture_content: boolean;
  max_content_length: number;
  spans: { php: RecordedSpan; ts: RecordedSpan; py: RecordedSpan };
  agrees: boolean;
  disagrees_on: string[];
  notes: string;
}

const corpus = JSON.parse(
  readFileSync(new URL('./fixtures/opentelemetry-span-attributes.json', import.meta.url), 'utf8'),
) as { cases: CorpusCase[] };

/** A tracer that records rather than exports — no SDK, no collector, no clock. */
function record(entry: CorpusCase): RecordedSpan {
  const spans: RecordedSpan[] = [];

  const tracer: Tracer = {
    startSpan(name: string): Span {
      const recorded: RecordedSpan = { name, status: 'unset', attributes: {} };
      spans.push(recorded);
      return {
        setAttribute(key, value) {
          recorded.attributes[key] = value;
        },
        setStatus(status) {
          recorded.status = status.code;
        },
        recordException() {},
        end() {},
      };
    },
  };

  const g = entry.generation;
  const subscriber = new TelemetrySubscriber(tracer, new SpanStore(), {
    maxContentLength: entry.max_content_length,
    captureContent: entry.capture_content,
    now: () => 0,
  });

  subscriber.onGenerationStarted(
    {
      traceId: entry.id,
      operation: g.operation,
      provider: g.provider,
      model: g.model,
      sessionId: g.session_id,
      userId: g.user_id,
    },
    g.input ?? undefined,
  );

  subscriber.onGenerationCompleted(entry.id, {
    finishReason: g.finish_reason,
    usage:
      g.usage === null
        ? undefined
        : {
            promptTokens: g.usage.prompt_tokens,
            completionTokens: g.usage.completion_tokens,
            cost: g.usage.cost,
          },
    output: g.output ?? undefined,
  });

  expect(spans).toHaveLength(1);

  const span = spans[0]!;

  return {
    name: span.name,
    status: span.status,
    attributes: Object.fromEntries(
      Object.entries(span.attributes).sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
  };
}

const caseOf = (id: string): CorpusCase => corpus.cases.find((entry) => entry.id === id)!;

describe('the cross-language span-attribute corpus', () => {
  it('is the whole suite, not a subset someone trimmed to green', () => {
    expect(corpus.cases).toHaveLength(13);
  });

  it.each(corpus.cases)('$id emits its recorded span ($title)', (entry) => {
    expect(record(entry)).toEqual(entry.spans.ts);
  });

  it('agrees with the reference on the attributes nobody has disputed', () => {
    // The rows disagree, but only on the keys the register names. Anything
    // outside that set drifting is a NEW divergence and should fail here rather
    // than disappear into a row that was already red.
    const known = new Set([
      'span name',
      'span status',
      'gen_ai.operation.name',
      'gen_ai.response.finish_reasons',
      'openinference.span.kind',
      'input.value',
      'input.mime_type',
    ]);

    const unexpected = corpus.cases.flatMap((entry) =>
      entry.disagrees_on.filter((field) => !known.has(field)).map((field) => `${entry.id}: ${field}`),
    );

    expect(unexpected).toEqual([]);
  });

  it('passes the operation through instead of naming it as the GenAI convention does', () => {
    // G-23. `gen_ai.operation.name` has a defined vocabulary — chat, embeddings
    // — and `text` is not in it. The reference maps onto that vocabulary; this
    // port forwards Prism's own internal operation string. Pinned in the
    // NEGATIVE: closing the gap turns this red, which is the point.
    const entry = caseOf('otel-0001');

    expect(record(entry).attributes['gen_ai.operation.name']).toBe('text');
    expect(record(entry).attributes['gen_ai.operation.name']).not.toBe(
      entry.spans.php.attributes['gen_ai.operation.name'],
    );
  });

  it('calls an image generation an LLM span where the reference calls it a chain', () => {
    // G-24. The root kind branch falls through to LLM for anything that is not
    // embeddings, text or structured; the reference folds everything but
    // embeddings into CHAIN.
    const entry = caseOf('otel-0003');

    expect(record(entry).attributes['openinference.span.kind']).toBe('LLM');
    expect(record(entry).attributes['openinference.span.kind']).not.toBe(
      entry.spans.php.attributes['openinference.span.kind'],
    );
  });

  it('marks a successful span ok where the reference leaves it unset', () => {
    // G-25. OpenTelemetry reserves `Ok` for a status a developer set
    // deliberately — instrumentation is meant to leave it Unset, so a backend
    // can tell "nothing went wrong" from "someone asserted it went right".
    const entry = caseOf('otel-0001');

    expect(record(entry).status).toBe('ok');
    expect(record(entry).status).not.toBe(entry.spans.php.status);
  });

  it('emits the neutral finish reason, which the reference does NOT', () => {
    // G-26, and the one divergence where this port is the correct side: the
    // reference exports the PHP enum's case name (`ToolCalls`), which is a
    // language artifact on a wire format. A dashboard filtering for
    // `tool-calls` matches these spans and misses every PHP one.
    const entry = caseOf('otel-0009');

    expect(record(entry).attributes['gen_ai.response.finish_reasons']).toEqual(['tool-calls']);
    expect(entry.spans.php.attributes['gen_ai.response.finish_reasons']).toEqual(['ToolCalls']);
  });

  it('cuts captured content by UTF-16 code unit, which is one of three rulers', () => {
    // G-27. The reference cuts bytes and Python cuts characters of the escaped
    // string. One input, three different strings, and not one of them raises.
    const entry = caseOf('otel-0012');
    const value = record(entry).attributes['input.value'];

    expect(value).toBe('{"prompt":"日本語のテ…[truncated]');
    expect(value).not.toBe(entry.spans.php.attributes['input.value']);
    expect(value).not.toBe(entry.spans.py.attributes['input.value']);
  });

  it('REFUSES content that reaches it with capture off, which the reference does not', () => {
    // G-28, and the row this suite is most worth having. The gate lives in the
    // BRIDGE here, so content arriving from a replayed event, a hand-built one
    // or a second emitter is still refused. The reference gates in core and
    // maps whatever it is handed, so the same input puts a card number on an
    // exported span.
    //
    // Asserted in the positive, because this is the property to keep.
    const entry = caseOf('otel-0013');

    expect(entry.capture_content).toBe(false);
    expect(record(entry).attributes).not.toHaveProperty('input.value');
    expect(entry.spans.php.attributes).toHaveProperty('input.value');
  });
});
