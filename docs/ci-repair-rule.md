# CI repair rule

For each failing CI job: capture the concrete failing step/log, map it to the violated requirement, identify the earliest invalidated R7 phase, repair the smallest coherent surface, rerun the reproducer and dependent gates, and preserve the failure in the R7 ledger. Do not disable or weaken the failing assertion to obtain green.
