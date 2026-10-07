# Prism OpenTelemetry for TypeScript

GenAI-convention OpenTelemetry spans from Prism telemetry. The TypeScript port
of
[`particle-academy/prism-opentelemetry`](https://github.com/Particle-Academy/prism-opentelemetry).

Zero runtime dependencies. Node 22+.

```
npm install @particle-academy/prism-opentelemetry
```

No dependency on an OTel SDK either: you implement a one-method `Tracer`
(`startSpan`) against whatever you already export with, and the package never
reaches for a global.

## Usage

```ts
import { SpanStore, TelemetrySubscriber } from '@particle-academy/prism-opentelemetry';

const telemetry = new TelemetrySubscriber(myTracer);

telemetry.onGenerationStarted(
  {
    traceId: 'b7ad6b7169203331',
    operation: 'chat',
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
  },
  input,
  advertisedTools,
);
```

Span names follow the GenAI convention — `{operation} {model}` — and the
attribute keys are in `GenAi` and `OpenInference` so you are not retyping
string literals that have to match a collector's expectations exactly.

## Content capture is OFF by default

This is the one setting in the package with a privacy consequence, so it is a
single explicit switch rather than something to infer from three config keys:

```ts
new TelemetrySubscriber(myTracer, new SpanStore(), {
  captureContent: true,   // prompts, completions, tool arguments
  captureMedia: false,    // attachment BYTES — separate, and still off
  maxContentLength: 65_536,
});
```

| | |
|---|---|
| `captureContent` | **Off.** Prompts, completions and tool arguments are user content, and a span export leaves your application. |
| `captureMedia` | **Off, and meaningless unless `captureContent` is on.** A serialized message carries each attachment's bytes; `withoutMediaBytes()` keeps a media part's kind and mime type while dropping the payload, so a span can say an image was sent without shipping the image. |
| `maxContentLength` | 64 KiB. A hostile or merely high-volume payload must not be able to bloat a span or the OTLP export. `0` disables the cap. |
| `recordExceptions` | On. |

Two switches rather than one because the answers genuinely differ: a team that
wants to see prompts in traces very rarely wants megabytes of base64 alongside
them.

## Tool spans and digests

`advertisedToolDigest()` gives a stable digest of a tool as advertised to the
model. That is what lets a trace show that the tool set changed between two
runs, rather than only that a tool was called — the pinning idea from
`prism-mcp` applied to telemetry.

## Parity

Attribute names, span naming and the capture gates are compared against the PHP
reference and the Python port by prism-parity's opentelemetry corpus. Worth
knowing before you rely on cross-language trace shape: when that corpus was
written, **zero of its thirteen rows agreed** across the three languages. The
gaps are tracked as G-23 through G-28 in the envelope's port-gaps register; read
it before assuming a span from this port is byte-comparable with one from PHP.
