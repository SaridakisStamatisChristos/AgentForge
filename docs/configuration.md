# Configuration contract

AgentForge fails fast on invalid numeric worker/API configuration rather than coercing dangerous values.

- API port: integer `0..65535` (`0` is allowed for test/ephemeral listeners).
- worker concurrency: integer `1..1024`.
- claim batch: integer `1..concurrency`.
- lease duration: integer `100..3600000` ms.
- heartbeat: integer at least `10` ms and strictly less than the lease duration.
- poll interval: bounded positive interval.
- payload/checkpoint byte limits: bounded positive integers.

Secrets are supplied through environment variables and are never included in `.env.example`. Provider credentials are optional and absent from the core deterministic path.
