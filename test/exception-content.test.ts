import { describe, expect, it } from 'vitest';
import { SpanStore, TelemetrySubscriber, exceptionType, type Span, type Tracer } from '../src/index.js';

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
  ended: boolean;
}

function recorder(): { tracer: Tracer; spans: Recorded[] } {
  const spans: Recorded[] = [];

  const tracer: Tracer = {
    startSpan(name: string) {
      const record: Recorded = { name, attributes: {}, status: null, exceptions: [], ended: false };
      spans.push(record);

      const span: Span = {
        setAttribute: (key, value) => (record.attributes[key] = value),
        setStatus: (status) => (record.status = status),
        recordException: (error) => record.exceptions.push(error),
        end: () => {
          record.ended = true;
        },
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
    expect(spans[0]!.exceptions[0]).toMatchObject({ name: 'Error' });
    expect((spans[0]!.exceptions[0] as Error).message).toContain(MARKER);
    expect((spans[0]!.exceptions[0] as Error).stack).toContain(MARKER);
    expect((spans[1]!.exceptions[0] as Error).message).toContain(MARKER);
  });

  it('cuts a captured message and stack to maxContentLength', () => {
    const { tracer, spans } = recorder();
    const subscriber = new TelemetrySubscriber(tracer, new SpanStore(), {
      captureContent: true,
      maxContentLength: 10,
      now: () => 0,
    });
    subscriber.onGenerationStarted({ traceId: 't', operation: 'text', provider: 'p', model: 'm' });
    const error = new Error('x'.repeat(5000));
    subscriber.onGenerationFailed('t', error);

    expect(spans[0]!.status?.message?.length).toBeLessThan(30);
    const recorded = spans[0]!.exceptions[0] as { message: string; stack: string };
    expect(recorded.message.length).toBeLessThan(30);
    expect(recorded.stack.length).toBeLessThan(30);
    // The application's own error is not changed.
    expect(error.message).toHaveLength(5000);
  });

  it('takes no class name from data the error carries', () => {
    const hostile = [
      // A response body merged onto an error can set `constructor` and `name`.
      Object.assign(new Error(MARKER), JSON.parse(`{"constructor":{"name":"${MARKER}"},"name":"${MARKER}"}`)),
      // A class named from data at runtime: not identifier-shaped, so refused.
      new ({ [`${MARKER} text`]: class extends Error {} }[`${MARKER} text`]!)(MARKER),
    ];

    for (const thrown of hostile) {
      const { tracer, spans } = recorder();
      const subscriber = new TelemetrySubscriber(tracer, new SpanStore(), { now: () => 0 });
      subscriber.onGenerationStarted({ traceId: 't', operation: 'text', provider: 'p', model: 'm' });
      subscriber.onGenerationFailed('t', thrown);

      expect(spans[0]!.exceptions).toEqual([{ name: 'Error' }]);
      expect(exported(spans)).not.toContain(MARKER);
    }
  });

  it('still ends the span when reading the error throws', () => {
    const error = new Error(MARKER);
    Object.defineProperty(error, 'constructor', {
      get() {
        throw new Error('boom');
      },
    });
    const proxy = new Proxy(new Error(MARKER), {
      getPrototypeOf() {
        throw new Error('boom');
      },
    });

    const hasTrap = new Proxy(new Error(MARKER), {
      has() {
        throw new Error('boom');
      },
    });
    const revocable = Proxy.revocable(new Error(MARKER), {});
    revocable.revoke();
    const rateLimitsGetter = new Error(MARKER);
    Object.defineProperty(rateLimitsGetter, 'rateLimits', {
      get() {
        throw new Error('boom');
      },
    });
    const bucketGetter = Object.assign(new Error(MARKER), {
      rateLimits: [
        {
          get name(): string {
            throw new Error('boom');
          },
        },
      ],
    });

    for (const thrown of [error, proxy, hasTrap, revocable.proxy, rateLimitsGetter, bucketGetter]) {
      const { tracer, spans } = recorder();
      const store = new SpanStore();
      const subscriber = new TelemetrySubscriber(tracer, store, { now: () => 0 });
      subscriber.onGenerationStarted({ traceId: 't', operation: 'text', provider: 'p', model: 'm' });

      expect(() => subscriber.onGenerationFailed('t', thrown)).not.toThrow();
      expect(store.size).toBe(0);
      expect(spans[0]!.ended).toBe(true);
      expect(exported(spans)).not.toContain(MARKER);
    }
  });

  it('ends every span when a tool value will not serialise or its error misbehaves', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const loud = new Error(MARKER);
    Object.defineProperty(loud, 'message', {
      get() {
        throw new Error('boom');
      },
    });

    for (const captureContent of [false, true]) {
      for (const parameters of [{ id: 1n }, circular]) {
        const { tracer, spans } = recorder();
        const store = new SpanStore();
        const subscriber = new TelemetrySubscriber(tracer, store, { captureContent, now: () => 0 });
        subscriber.onGenerationStarted({ traceId: 't', operation: 'text', provider: 'p', model: 'm' });
        subscriber.onToolInvoked('t', {
          name: 'x',
          callId: 'c',
          stepIndex: null,
          parameters,
          result: parameters,
          failed: true,
          error: loud,
        });

        expect(() => subscriber.onGenerationFailed('t', new Error('run failed'))).not.toThrow();
        expect(store.size).toBe(0);
        expect(spans.every((span) => span.ended)).toBe(true);
        expect(spans[0]!.status?.code).toBe('error');
      }
    }
  });

  it('sets the error status even when the span refuses the exception', () => {
    const spans: Recorded[] = [];
    const tracer: Tracer = {
      startSpan(name: string) {
        const record: Recorded = { name, attributes: {}, status: null, exceptions: [], ended: false };
        spans.push(record);
        return {
          setAttribute: (key, value) => (record.attributes[key] = value),
          setStatus: (status) => (record.status = status),
          recordException: () => {
            throw new Error('span refused');
          },
          end: () => {
            record.ended = true;
          },
        };
      },
    };
    const store = new SpanStore();
    const subscriber = new TelemetrySubscriber(tracer, store, { now: () => 0 });
    subscriber.onGenerationStarted({ traceId: 't', operation: 'text', provider: 'p', model: 'm' });

    expect(() => subscriber.onGenerationFailed('t', new Error(MARKER))).not.toThrow();
    expect(spans[0]!.status).toEqual({ code: 'error', message: 'The generation failed.' });
    expect(spans[0]!.ended).toBe(true);
    expect(store.size).toBe(0);
  });

  it('gives up on a prototype chain that never ends', () => {
    const endless = (): object =>
      new Proxy(
        {},
        {
          getPrototypeOf: () => endless(),
          getOwnPropertyDescriptor: () => undefined,
        },
      );
    const error = new Error(MARKER);
    Object.setPrototypeOf(error, endless());

    expect(exceptionType(error)).toMatch(/^(Error|object)$/);
  });

  it('records a non-string message under capture without throwing', () => {
    for (const message of [5, null, { a: 1 }, undefined]) {
      const { tracer, spans } = recorder();
      const store = new SpanStore();
      const subscriber = new TelemetrySubscriber(tracer, store, { captureContent: true, now: () => 0 });
      subscriber.onGenerationStarted({ traceId: 't', operation: 'text', provider: 'p', model: 'm' });

      expect(() => subscriber.onGenerationFailed('t', Object.assign(new Error('x'), { message }))).not.toThrow();
      expect(store.size).toBe(0);
      expect(spans[0]!.ended).toBe(true);
      expect(typeof spans[0]!.status?.message).toBe('string');
    }
  });

  it('cuts a captured name and code to maxContentLength', () => {
    const { tracer, spans } = recorder();
    const subscriber = new TelemetrySubscriber(tracer, new SpanStore(), {
      captureContent: true,
      maxContentLength: 10,
      now: () => 0,
    });
    subscriber.onGenerationStarted({ traceId: 't', operation: 'text', provider: 'p', model: 'm' });
    const error = Object.assign(new Error('x'), { name: 'N'.repeat(5000), code: 'C'.repeat(5000) });
    subscriber.onGenerationFailed('t', error);

    const recorded = spans[0]!.exceptions[0] as { name: string; code: string };
    expect(recorded.name.length).toBeLessThan(30);
    expect(recorded.code.length).toBeLessThan(30);
  });

  it('names an Error from another realm as an Error', async () => {
    const { runInNewContext } = await import('node:vm');
    const foreign = runInNewContext(`new TypeError(${JSON.stringify(MARKER)})`) as unknown;
    const { tracer, spans } = recorder();
    const subscriber = new TelemetrySubscriber(tracer, new SpanStore(), { now: () => 0 });
    subscriber.onGenerationStarted({ traceId: 't', operation: 'text', provider: 'p', model: 'm' });
    subscriber.onGenerationFailed('t', foreign);

    const name = (spans[0]!.exceptions[0] as { name: string }).name;
    // Error.isError (Node 24+) recognises it; older runtimes fall back to typeof.
    expect(['TypeError', 'object']).toContain(name);
    expect(exported(spans)).not.toContain(MARKER);
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
