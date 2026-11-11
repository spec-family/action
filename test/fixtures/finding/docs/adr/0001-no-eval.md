---
status: accepted
---

# ADR-0001: No eval

## Decision

No code in `src/` builds code from a string at run time.

<!-- @assert-absence target="src" glob="*.js" symbol="eval" reason="no code is built from a string" -->

## Consequences

Templates are compiled ahead of time, as [ADR-0002](0002-templates-ahead-of-time.md) records.
