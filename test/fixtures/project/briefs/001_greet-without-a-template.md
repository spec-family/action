---
status: active
date: 2026-11-11
type: chore
affectedFiles: [src/greet.js]
protectedFiles: [docs/**]
---

# 001 — Greet without a template

## Intent

`greet` builds its sentence by concatenation, so no reader of `src/` has to
wonder whether a string is ever run as code.

## Negative Scope

- No change to what `greet` returns.

## Invariants

- [ ] no code in `src/` calls `eval`

<!-- @assert-absence target="src" glob="*.js" symbol="eval" reason="no code is built from a string" -->
