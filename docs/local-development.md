# Local development commands

```bash
pnpm install --frozen-lockfile
pnpm format
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:unit
DATABASE_URL=postgresql://agentforge:agentforge@localhost:5432/agentforge pnpm test:integration
pnpm build
pnpm db:migrate
pnpm dev:infra
pnpm dev:api
pnpm dev:worker
pnpm example:hello
pnpm example:agent
pnpm example:recovery
pnpm benchmark:smoke
pnpm consumer:check
pnpm check:placeholders
```

TypeScript 5.8.3 is pinned in CI as a global tool because the project otherwise keeps the runtime/workspace dependency graph registry-free. A local developer should install the same compiler version before `typecheck`/`build`.
