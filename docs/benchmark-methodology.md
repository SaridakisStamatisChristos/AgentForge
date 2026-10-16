# Benchmark methodology

The benchmark harness is an internal engineering instrument, not a comparative product claim.

## Current harness

`benchmarks/runtime/benchmark.ts` measures deterministic in-memory scheduling overhead for many small linear DAGs across several worker counts. It records Node version, platform, architecture, run count, steps per run, duration, runs/second and logical steps/second.

The smoke mode used in CI is intentionally small:

```bash
pnpm benchmark:smoke
```

A longer local run uses the same harness without `--smoke`.

## Interpretation

These results can reveal gross regressions in scheduler overhead and scaling behavior. They **do not** measure PostgreSQL production throughput, network/provider latency, external tool performance, multi-host scaling, or user-facing latency under realistic workloads.

No comparison against n8n or another system is made because semantic equivalence, configuration equivalence and end-to-end accounting have not been established.

## Measurement discipline

- correctness tests and performance measurements are separate;
- every run reports environment metadata and input parameters;
- all worker counts run the same scenario;
- CI smoke numbers are not promoted to README performance headlines;
- any future PostgreSQL benchmark must include database preparation, event persistence and recovery/scheduling costs rather than cherry-picking queue claim time alone;
- any external comparison must define equivalent semantics before interpreting a throughput ratio.
