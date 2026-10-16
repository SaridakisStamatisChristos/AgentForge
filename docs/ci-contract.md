# CI contract

The pull-request workflow is expected to execute the same critical commands the repository documents: frozen install, formatting/lint/typecheck, deterministic tests, clean migrations and database smoke, real PostgreSQL integration tests, build/export smoke, required examples, benchmark smoke and dependency audit. A separate job validates Compose, starts a fresh PostgreSQL container and builds the project container.

A job being present in YAML is not `VERIFIED`. The R7 run inspects the actual PR workflow run and job conclusions before closing Gate G.
