# V1 limitations

AgentForge V1 is an engineering runtime, not a finished hosted SaaS platform.

It does not provide an end-user visual workflow editor, public-internet authentication, tenant isolation, a secrets vault, untrusted-code sandboxing, multi-region failover/consensus, a marketplace, billing, generalized message-broker semantics, RAG/vector storage, browser automation, or a large catalog of integrations.

The provided deterministic and reference PostgreSQL paths demonstrate runtime semantics. Production readiness additionally depends on deployment-specific capacity, backups/recovery objectives, operational ownership, network/auth boundaries and production observation; those are not silently inferred from local/CI green checks.
