# Package boundaries

The intended dependency direction is:

```text
contracts
   ↑
core ← workflows
   ↑
runtime ← tools / providers
   ↑
queue / persistence / events adapters
   ↑
apps/api + apps/worker
   ↑
sdk / examples
```

Package manifests declare direct internal imports, and public packages expose intentional root exports. The build produces declarations and JavaScript under each package's `dist`. `pnpm consumer:check` imports a built package through normal package resolution rather than a source-path alias.

The TypeScript source build uses explicit path mappings only as a compile-time development aid; examples and external-style smoke paths import package names, not private implementation files.
