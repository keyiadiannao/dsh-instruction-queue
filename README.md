# dsh-instruction-queue

Persistent instruction queue for [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness).

> **The agent executes. You keep thinking. The plan stays synchronized.**

Collect the user's multi-segment instructions into a collaborative plan, compile
them into **approved obligations**, execute them segment-by-segment through the
main agent session, and **reconcile the plan after each segment** against user
intent, agent discoveries, and workspace evidence.

This is an **event-sourced obligation orchestrator**, not "a queue plugin that
calls an LLM": the append-only ledger is the single source of truth, the pure
reducer projects it to run state (System Invariant #9), and the LLM only
performs semantic judgment inside compile/reconcile — it never owns state truth.

## The three V1 differentiators

1. **Compile before execute.** Buffered inputs never run. `iq_compile` extracts
   atomic intents, detects supersessions ("input 7 replaces input 2") vs
   contradictions, builds the dependency graph, and proposes an obligation queue
   with concrete **acceptance criteria** — nothing executes until `iq_approve`.
2. **Approval preserves intent.** Approval locks each task's semantics AND its
   acceptance criteria at `approved_task_revision`. Later semantic changes must
   go through a NEW proposal, never a silent rewrite (Invariant #2).
3. **Reconcile after execute.** After each segment, `iq_reconcile` captures the
   result (advisory summary + structured evidence), judges every acceptance
   criterion against the evidence (an agent conclusion alone never satisfies a
   criterion — Invariant #6), and revises the remaining graph: **residual** work
   auto-enters, **scope-expanding** work is proposed and requires new approval
   (Invariant #4).

## Status

**V1 — competitive-validation MVP** (host-only, tool-driven loop). No client
UI yet; the queue is driven through the six `iq_*` tools.

## Install

Add to your profile's `package.json` bundles + dependencies
(`~/.dsh/profiles/<profile>/`):

```jsonc
// dependencies
"dsh-instruction-queue": "link:D:/cursor_try/VLLM/plugins/dsh-instruction-queue",
// dsh.profile.bundles
"dsh-instruction-queue"
```

Restart the harness. The plugin registers six tools: `iq_enable`, `iq_collect`,
`iq_compile`, `iq_approve`, `iq_execute_next`, `iq_reconcile`, `iq_status`.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `dataDir` | `~/.dsh/storages/instruction-queue` | Directory holding one `<session>.ndjson` ledger per run |
| `llmProvider` / `llmModel` | `''` (session default) | Provider/model for compile + reconcile semantic calls |
| `allowPartialApproval` | `true` | Allow approving a subset of the compiled queue |
| `maxCompiledTasks` | `12` | Compiler warning threshold |

## Usage (tool loop)

1. **`iq_enable`** — start a run for the session.
2. **`iq_collect`** — buffer instruction segments (any number; each recorded
   verbatim with its queue position).
3. **`iq_compile`** — LLM compiles the buffer into a PROPOSED queue with
   acceptance criteria, conflicts, cycles, ambiguities.
4. **`iq_approve`** — user approves (whole or partial) + acknowledges
   supersessions. Approval locks semantics + criteria at this revision.
5. **`iq_execute_next`** — dispatch the next obligation; returns the execution
   envelope (task + criteria + constraints). Execute ONLY this segment.
6. **`iq_reconcile`** — report the result (summary + evidence + per-criterion
   judgement). The plugin judges criteria, auto-enters residual work, proposes
   expansions, and completes the run when every approved obligation resolves.

`iq_status` is read-only — check phase, buffered inputs, obligations, next task.

## Design

The design is frozen in
[`docs/dev/DSH_PROMPT_SEQUENCE_DESIGN_2026-08-20.md`](../../docs/dev/DSH_PROMPT_SEQUENCE_DESIGN_2026-08-20.md)
(6 rounds of review; state machine, dual status enums, reconcile boundary,
immutable revision boundary, at-most-once retry, coverage judgment, crash
recovery matrix, 9 System Invariants).

Architecture: `src/iq/{types,events,reducer,recovery,invariants,ledger}.ts` —
pure protocol layer, no LLM/IO; `src/compile.ts` + `src/reconcile.ts` — lazy
LLM semantic judgment; `src/index.ts` — the tool loop.

## License

MIT
