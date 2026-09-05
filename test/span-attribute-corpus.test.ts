import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GenAi,
  SpanStore,
  TelemetrySubscriber,
  type RateLimit,
  type Span,
  type Tracer,
} from '../src/index.js';

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

interface CorpusRateLimit {
  name: string;
  limit: number | null;
  remaining: number | null;
  resets_at: string | null;
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
    rate_limits: CorpusRateLimit[] | null;
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
    rateLimits: g.rate_limits === null ? undefined : g.rate_limits.map(rateLimit),
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

/**
 * A corpus bucket as this port's bridge takes one.
 *
 * `resets_at` is parsed HERE and not in the bridge: the bridge is handed an
 * instant, so nothing in this comparison depends on three languages agreeing
 * about how to render or re-render a date.
 */
function rateLimit(entry: CorpusRateLimit): RateLimit {
  return {
    name: entry.name,
    limit: entry.limit,
    remaining: entry.remaining,
    resetsAt: entry.resets_at === null ? null : new Date(entry.resets_at),
  };
}

const caseOf = (id: string): CorpusCase => corpus.cases.find((entry) => entry.id === id)!;

/** Just the rate-limit attributes of an attribute map. */
function rateLimitAttributesOf(attributes: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(attributes).filter(([key]) => key.startsWith(GenAi.RATE_LIMIT_PREFIX)),
  );
}

describe('the cross-language span-attribute corpus', () => {
  it('is the whole suite, not a subset someone trimmed to green', () => {
    expect(corpus.cases).toHaveLength(18);
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

  it('exports the provider rate limits, which no semantic convention names', () => {
    // The OpenTelemetry GenAI conventions define NOTHING for rate limits or
    // quota — checked 2026-09-05 against the gen_ai and http attribute
    // registries. `gen_ai.error.type` has a `rate_limit` member, but that names
    // a failure rather than a headroom, and the nearest mechanism in all of
    // semconv is the generic opt-in `http.response.header.<key>` capture, which
    // records a header verbatim and knows nothing about the bucket it belongs
    // to. So these keys are OURS, and they live under `prism.` rather than
    // inside `gen_ai.` so a real convention can arrive later without two
    // spellings meaning subtly different things.
    expect(record(caseOf('otel-0014')).attributes).toMatchObject({
      'prism.rate_limit.buckets': ['requests'],
      'prism.rate_limit.requests.limit': 1000,
      'prism.rate_limit.requests.remaining': 999,
      'prism.rate_limit.requests.resets_at_unix': 1788611696,
    });
  });

  it('writes a key only for the fields the provider actually sent', () => {
    // A quota of zero and a quota nobody reported are different facts, and 0
    // says the first when the truth is the second. The cost precedent, one
    // level down.
    const attributes = record(caseOf('otel-0015')).attributes;

    expect(attributes).toHaveProperty('prism.rate_limit.input-tokens.limit');
    expect(attributes).not.toHaveProperty('prism.rate_limit.input-tokens.resets_at_unix');
    expect(attributes).not.toHaveProperty('prism.rate_limit.output-tokens.limit');
  });

  it('writes NOTHING when the provider reported no rate limits at all', () => {
    // Present-and-empty and absent are different values to a backend, and this
    // is the COMMON case rather than an edge one: several providers report no
    // quota headers at all, in every language. An empty `buckets` array would
    // put "we asked, there is no quota" on every span they touch.
    expect(rateLimitAttributesOf(record(caseOf('otel-0016')).attributes)).toEqual({});
  });

  it('refuses every hostile spelling of a bucket name, and keeps the real one', () => {
    // A bucket name is chosen by the PROVIDER and becomes part of an attribute
    // KEY — the G-36 shape, one layer out. Seven hostile spellings of `tokens`
    // (trailing space, trailing newline, case fold, Cyrillic homoglyph, an
    // embedded dot that would forge a nested key, an empty name, and a
    // duplicate appended after the real bucket) and one real one.
    //
    // Dropped rather than normalised: normalising means two distinct names can
    // collapse onto one key, at which point the hostile bucket overwrites the
    // real bucket's numbers instead of being ignored. The duplicate carried 8,
    // so FIRST winning is what keeps 7 on the span.
    expect(rateLimitAttributesOf(record(caseOf('otel-0017')).attributes)).toEqual({
      'prism.rate_limit.buckets': ['tokens'],
      'prism.rate_limit.tokens.limit': 7,
      'prism.rate_limit.tokens.remaining': 7,
    });
  });

  it('caps how many buckets a span can carry, however well-formed they are', () => {
    // The alphabet gate bounds what a key may LOOK like and not how many there
    // are, and backends index keys.
    const attributes = record(caseOf('otel-0018')).attributes;
    const buckets = attributes['prism.rate_limit.buckets'] as string[];

    expect(buckets).toHaveLength(GenAi.RATE_LIMIT_MAX_BUCKETS);
    expect(buckets[0]).toBe('b00');
    expect(attributes).not.toHaveProperty('prism.rate_limit.b16.limit');
  });

  it('exports the SAME rate-limit attributes as the reference and the other port', () => {
    // The one thing in this suite that AGREES. Every other row is pinned
    // against its own language's recorded span, which is exactly the assertion
    // that cannot see a cross-language divergence — so the rate-limit keys are
    // compared here across the three recorded maps directly.
    let compared = 0;

    for (const entry of corpus.cases) {
      const php = rateLimitAttributesOf(entry.spans.php.attributes);

      expect(php).toEqual(rateLimitAttributesOf(entry.spans.ts.attributes));
      expect(php).toEqual(rateLimitAttributesOf(entry.spans.py.attributes));

      compared += Object.keys(php).length;
    }

    // Vacuity guard: three empty maps agree about nothing.
    expect(compared).toBe(48);
  });

  it('exports the rate limits a rate-limited generation FAILED with', () => {
    // The 429 is the moment an operator most wants these numbers, and the one
    // moment they cannot arrive on a response — there is no response.
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

    const subscriber = new TelemetrySubscriber(tracer, new SpanStore(), { now: () => 0 });
    subscriber.onGenerationStarted({
      traceId: 'rate-limited',
      operation: 'text',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    const error = Object.assign(new Error('rate limited'), {
      rateLimits: [
        {
          name: 'requests',
          limit: 50,
          remaining: 0,
          resetsAt: new Date(1788611696 * 1000),
        },
      ],
    });

    subscriber.onGenerationFailed('rate-limited', error);

    expect(spans[0]!.attributes).toMatchObject({
      'prism.rate_limit.buckets': ['requests'],
      'prism.rate_limit.requests.limit': 50,
      'prism.rate_limit.requests.remaining': 0,
      'prism.rate_limit.requests.resets_at_unix': 1788611696,
    });
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
