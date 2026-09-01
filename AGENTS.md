# AGENTS.md — prism-opentelemetry-ts

The TypeScript port of
[`particle-academy/prism-opentelemetry`](https://github.com/Particle-Academy/prism-opentelemetry).
Read the shared agent guide in `prism-parity/docs/AGENTS.md` first: the
boundary, the satellite map, the rules that bind, and the review skills.

## Gates — run them on EXIT CODES

```sh
npm run typecheck
npm run build
npx vitest run
```

Never pipe a gate into `head`/`tail`/`grep` and read `$?` — that is the
FILTER's exit code, not the gate's. Redirect to a file, echo `$?`, then look.

## What this package holds

The span builder: one root span per generation, child spans per step and per
tool call, parented off the STORED root context via the trace id. The GenAI and
OpenInference attribute keys are held here rather than pulled from a semconv
package, so churn in those still-evolving conventions is a release of this
package and not a dependency bump.

## The rule that binds every port here

**Faithful to the reference, or a DOCUMENTED divergence — never a quiet one.**
Where this port does something the reference does not, the reason is in the
code and in the envelope's port gaps register. A difference nobody wrote down
is drift, and drift is what this whole effort exists to prevent.
