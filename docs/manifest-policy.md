# Manifest and evidence policy

The R7 completion report must distinguish generated artifacts from observed evidence.

- Repository file hashes are taken from actual Git/GitHub object data or a checked-out byte stream; guessed hashes are forbidden.
- CI is `VERIFIED` only after the actual workflow run and jobs are inspected.
- PostgreSQL semantics are not promoted from deterministic-memory tests alone.
- Docker/Compose gates remain unverified until an actual container job succeeds.
- Benchmark results are reported with their environment/scope and never converted into superiority claims.
- Any failed critical gate keeps the overall verdict below `VERIFIED FOR DECLARED LOCAL TARGET` until repaired and independently rerun.

`docs/r7-requirements.md` is the requirement/assumption/failure/claim ledger. The final CI head SHA and check identifiers are added only after they exist.
