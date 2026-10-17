# Development

## Toolchain

AgentForge targets Node.js 22 and pnpm 10.18.3. CI installs TypeScript 5.8.3 as the compiler used for `typecheck` and `build`.

```bash
corepack enable
corepack prepare pnpm@10.18.3 --activate
npm install --global typescript@5.8.3
pnpm install --frozen-lockfile
```

## Local infrastructure

Start PostgreSQL with Compose and apply migrations:

```bash
pnpm dev:infra
pnpm db:migrate
pnpm db:smoke
```

Run the API and worker together:

```bash
pnpm dev
```

Or run them separately:

```bash
pnpm dev:api
pnpm dev:worker
```

The default local API endpoint is `http://127.0.0.1:8787` unless `AGENTFORGE_API_PORT` is configured.

## Development commands

```bash
pnpm format
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:unit
DATABASE_URL=postgresql://agentforge:agentforge@localhost:5432/agentforge pnpm test:integration
pnpm build
pnpm consumer:check
pnpm check:placeholders
pnpm example:hello
pnpm example:agent
pnpm example:recovery
pnpm benchmark:smoke
```

`pnpm verify` runs the local non-PostgreSQL verification bundle: formatting, linting, typechecking, unit tests, build, public-export smoke and placeholder checks. Integration tests require an actual PostgreSQL database and are intentionally separate.

## Change discipline

Runtime behavior is defined by the existing package boundaries and state-machine semantics. Changes should preserve those authority boundaries unless the architecture itself is intentionally being changed.

Reliability-critical changes should include a reproducer or regression test at the narrowest layer that can establish the invariant. When a PostgreSQL-specific property is involved, a deterministic memory-store test is useful but is not a substitute for the PostgreSQL integration oracle.

Do not make a failing gate green by removing an assertion, marking a required step optional, or replacing execution with a file-presence check. Diagnose the concrete failing step, repair the smallest coherent surface, and rerun the affected verification path.

## Where to start when reviewing behavior

- `tests/runtime.test.ts` — deterministic execution semantics and adversarial cases.
- `integration/postgres.test.ts` — PostgreSQL claims, fencing, restart and race behavior.
- `integration/process-recovery.test.ts` — process-loss recovery.
- `examples/failure-recovery/src/index.ts` — executable lease-generation recovery demonstration.
- `packages/runtime/src/index.ts` — execution orchestration.
- `packages/persistence/src/index.ts` — durable transaction and fencing mechanics.
- `apps/api/src/index.ts` and `packages/sdk/src/index.ts` — control-plane boundary.
- `docs/failure-semantics.md` and `docs/idempotency.md` — precise reliability claims.

## Documentation expectations

Product-facing documentation describes current behavior rather than implementation chronology. Historical failures, prior branch names and completed implementation campaigns belong in Git history and pull-request discussions, not in the active product tree.

Documentation that defines durable architecture, security, operational or verification contracts should remain evergreen and should be updated alongside the behavior it describes.
