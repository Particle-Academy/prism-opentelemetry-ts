import { describe, expect, it } from 'vitest';
import { SpanStore, TelemetrySubscriber, type Span, type Tracer } from '../src/index.js';

/**
 * An exception message is content.
 *
 * A failed database write repeats the row it tried to insert, a provider error
 * can quote the prompt, a validation error quotes the input. With content
 * capture off, none of that may reach a span: not the status description, not
 * the exception handed to `recordException`, and not its stack, whose first
 * line repeats the message.
 */
const MARKER = 'CONTENT-MARKER-0f1e';

interface Recorded {
  name: string;
  attributes: Record<string, unknown>;
  status: { code: string; message?: string } | null;
  exceptions: unknown[];
}

function recorder(): { tracer: Tracer; spans: Recorded[] } {
  const spans: Recorded[] = [];

  const tracer: Tracer = {
    startSpan(name: string) {
      const record: Recorded = { name, attributes: {}, status: null, exceptions: [] };
      spans.push(record);

      const span: Span = {
        setAttribute: (key, value) => (record.attributes[key] = value),
        setStatus: (status) => (record.status = status),
        recordException: (error) => record.exceptions.push(error),
        end: () => undefined,
      };

      return span;
    },
  };

  return { tracer, spans };
}

/**
 * Everything a recorded span holds, as text, INCLUDING what an SDK would read
 * off an exception: `message`, `stack`, `code` and `cause`. `JSON.stringify`
 * of an Error drops all four, which would make this check pass vacuously.
 */
function exported(spans: Recorded[]): string {
  const exception = (value: unknown): unknown => {
    if (typeof value !== 'object' || value === null) return value;
    const { name, message, stack, code, cause } = value as Record<string, unknown>;
    return { name, message, stack, code, cause: exception(cause), own: { ...value } };
  };

  return JSON.stringify(spans.map((span) => ({ ...span, exceptions: span.exceptions.map(exception) })));
}

function failure(): Error {
  const cause = new Error(`previous: tool result ${MARKER}`);

  return new Error(
    `SQLSTATE[22001]: insert into tool_runs (arguments, result) values ('{"q":"${MARKER}"}')`,
    { cause },
  );
}

function run(captureContent: boolean | undefined, operation = 'text'): Recorded[] {
  const { tracer, spans } = recorder();
  const subscriber = new TelemetrySubscriber(
    tracer,
    new SpanStore(),
    captureContent === undefined ? { now: () => 0 } : { captureContent, now: () => 0 },
  );

  subscriber.onGenerationStarted({ traceId: 't', operation, provider: 'anthropic', model: 'claude-sonnet-5-5' });
  subscriber.onToolInvoked('t', {
    name: 'save_row',
    callId: 'call_1',
    stepIndex: null,
    parameters: null,
    result: null,
    failed: true,
    error: failure(),
  });
  subscriber.onGenerationFailed('t', failure());

  return spans;
}

describe('exception content', () => {
  it.each(['text', 'structured', 'embeddings', 'image', 'stream'])(
    'keeps the message off every span when capture is off (%s)',
    (operation) => {
      const spans = run(false, operation);

      expect(spans).toHaveLength(2);
      expect(exported(spans)).not.toContain(MARKER);

      const root = spans[0]!;
      expect(root.status).toEqual({ code: 'error', message: 'The generation failed.' });
      // The type survives, so a reader can still tell WHAT failed.
      expect(root.exceptions).toEqual([{ name: 'Error' }]);

      const tool = spans[1]!;
      expect(tool.status).toEqual({ code: 'error' });
      expect(tool.exceptions).toEqual([{ name: 'Error' }]);
    },
  );

  it('is off when the option is not given at all', () => {
    expect(exported(run(undefined))).not.toContain(MARKER);
  });

  it('records the exception itself when capture is on', () => {
    const spans = run(true);

    expect(spans[0]!.status?.message).toContain(MARKER);
    expect(spans[0]!.exceptions[0]).toBeInstanceOf(Error);
    expect((spans[0]!.exceptions[0] as Error).message).toContain(MARKER);
    expect((spans[1]!.exceptions[0] as Error).message).toContain(MARKER);
  });

  it('names a subclass by its class, and a thrown non-Error by its type', () => {
    class ProviderRefused extends Error {}

    for (const [thrown, expected] of [
      [new ProviderRefused(MARKER), 'ProviderRefused'],
      [new (class extends Error {})(MARKER), 'Error'],
      [MARKER, 'string'],
      [{ message: MARKER, name: MARKER }, 'object'],
      [null, 'null'],
    ] as const) {
      const { tracer, spans } = recorder();
      const subscriber = new TelemetrySubscriber(tracer, new SpanStore(), { now: () => 0 });
      subscriber.onGenerationStarted({ traceId: 't', operation: 'text', provider: 'p', model: 'm' });
      subscriber.onGenerationFailed('t', thrown);

      expect(spans[0]!.exceptions).toEqual([{ name: expected }]);
      expect(exported(spans)).not.toContain(MARKER);
    }
  });

  it('records nothing when recordExceptions is off, whatever capture says', () => {
    for (const captureContent of [false, true]) {
      const { tracer, spans } = recorder();
      const subscriber = new TelemetrySubscriber(tracer, new SpanStore(), {
        captureContent,
        recordExceptions: false,
        now: () => 0,
      });
      subscriber.onGenerationStarted({ traceId: 't', operation: 'text', provider: 'p', model: 'm' });
      subscriber.onGenerationFailed('t', failure());

      expect(spans[0]!.exceptions).toEqual([]);
      expect(spans[0]!.status?.code).toBe('error');
    }
  });
});
