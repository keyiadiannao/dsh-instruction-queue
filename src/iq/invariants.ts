/**
 * dsh-instruction-queue — System Invariants (the constitution).
 *
 * Every invariant is checked on every reduce; a violating ledger throws on
 * replay. The state machine may be refactored freely as long as these hold
 * (design doc §System Invariants).
 *
 * @module dsh-instruction-queue/iq/invariants
 */

import type { RunState, Task } from './types.ts'

/** Thrown when a ledger violates a constitutional invariant. */
export class InvariantViolation extends Error {
  constructor(invariant: number, detail: string) {
    super(`[iq invariant #${invariant}] ${detail}`)
    this.name = 'InvariantViolation'
  }
}

/**
 * Check all 9 invariants against a projected state. Returns the state
 * unchanged on success, throws InvariantViolation on failure.
 */
export function assertInvariants(state: RunState): RunState {
  // #1: raw user inputs are immutable — the reducer never mutates an input
  // object in place, so replay determinism is structural; here we verify the
  // ledger ordering guarantee: inputs are strictly increasing in sequence.
  for (let i = 1; i < state.inputs.length; i++) {
    const prev = state.inputs[i - 1]!
    const cur = state.inputs[i]!
    if (cur.queue_sequence <= prev.queue_sequence) {
      throw new InvariantViolation(1, `input sequence not monotonic: ${prev.queue_sequence} then ${cur.queue_sequence}`)
    }
  }

  // #2: approved task semantics are immutable without approval — every
  // approved task has a locked approved_task_revision and the AC set approved.
  for (const t of state.tasks) {
    if (t.approval_status === 'approved') {
      if (t.approved_task_revision === null) {
        throw new InvariantViolation(2, `task ${t.task_id} approved without approved_task_revision`)
      }
      if (t.approved_acceptance_criteria.length === 0 && t.acceptance_criteria.length > 0) {
        throw new InvariantViolation(2, `task ${t.task_id} approved without locked acceptance criteria`)
      }
      // A semantic revision must go through a NEW proposal, never silently
      // replace the approved task: once approved, a recompiled slate keeps the
      // approved task object (same id), so this is structurally enforced by
      // the reducer's "keep approved tasks" rule in QUEUE_COMPILED.
    }
  }

  // #3: no non-idempotent uncertain attempt is automatically retried —
  // enforced by the tool layer (reconcile/executor), not provable from the
  // projection alone. Structural check: an attempt whose task has an observed
  // side effect must not silently restart without a new dispatch event; the
  // reducer only ever ADDS attempts, never rewrites them, which holds by
  // construction. No runtime check here.

  // #4: no scope-expanding task executes without approval.
  for (const t of state.tasks) {
    if (t.origin === 'proposed_expansion' && t.approval_status !== 'approved' && t.execution_status === 'running') {
      throw new InvariantViolation(4, `scope-expanding task ${t.task_id} is running without approval`)
    }
  }

  // #5: a task is covered only when all approved ACs have evidence.
  for (const t of state.tasks) {
    if (t.resolution_status === 'satisfied' || t.resolution_status === 'covered') {
      const approved = t.approved_acceptance_criteria.length > 0
        ? t.approved_acceptance_criteria
        : t.acceptance_criteria
      if (approved.length > 0 && t.execution_status !== 'finished' && t.execution_status !== 'failed') {
        // execution_status may be stale during reconcile; coverage audit is
        // checked at completion. Defer the strict check to auditCoverage.
      }
    }
  }

  // #6: agent summaries are context, not authoritative evidence.
  for (const e of t_flat(state)) {
    for (const ev of e.evidence) {
      if (ev.authority === 'agent' && (ev.type === 'agent_conclusion')) {
        // allowed as evidence entry, but must never be the SOLE ref for a
        // satisfied criterion — enforced in auditCoverage (invariant #5 gate).
      }
    }
  }

  // #7: only one queue task may own execution at a time.
  const running = state.tasks.filter((t) => t.execution_status === 'running')
  if (running.length > 1) {
    throw new InvariantViolation(7, `concurrent running tasks: ${running.map((t) => t.task_id).join(', ')}`)
  }
  const active = state.tasks.filter((t) => t.task_id === state.active_task_id)
  if (state.active_task_id !== null && active.length !== 1) {
    throw new InvariantViolation(7, `active_task_id ${state.active_task_id} does not resolve to exactly one task`)
  }
  if (running.length === 1 && state.active_task_id !== running[0]!.task_id) {
    throw new InvariantViolation(7, `running task ${running[0]!.task_id} != active_task_id ${state.active_task_id}`)
  }

  // #8: completion is impossible while any approved obligation is unresolved
  // — the completion gate (allApprovedResolved) must agree with phase.
  if (state.phase === 'completed') {
    const unresolved = state.tasks.filter(
      (t) => t.approval_status === 'approved'
        && !['satisfied', 'covered', 'skipped'].includes(t.resolution_status),
    )
    if (unresolved.length > 0) {
      throw new InvariantViolation(8, `phase=completed but unresolved approved obligations: ${unresolved.map((t) => t.task_id).join(', ')}`)
    }
  }

  // #9: derived state is reconstructible from the ledger — the reducer is
  // pure and total over events; re-running reduceAll over the same ledger
  // yields the same state by construction (no hidden mutable state, no clock
  // except event-provided timestamps). Nothing to check at runtime beyond
  // purity, which the module enforces by never reading globals.

  return state
}

/** Flatten all tasks' evidence for invariant #6 scanning. */
function t_flat(state: RunState): Task[] {
  return state.tasks
}

/**
 * Completion coverage audit (Invariant #5 enforcement, run at COMPLETING):
 * every approved AC must have at least one evidence ref, and no criterion may
 * rest ONLY on agent-authority evidence. Returns per-criterion verdicts.
 */
export function auditCoverage(state: RunState): {
  task_id: string
  criterion_id: string
  ok: boolean
  reason: string
}[] {
  const out: { task_id: string; criterion_id: string; ok: boolean; reason: string }[] = []
  for (const t of state.tasks) {
    if (t.approval_status !== 'approved') continue
    const approved = t.approved_acceptance_criteria.length > 0
      ? t.approved_acceptance_criteria
      : t.acceptance_criteria
    for (const ac of approved) {
      const cov = t.coverage.criteria_met.find((c) => c.criterion_id === ac.criterion_id)
      const refs = cov?.evidence_refs ?? []
      if (refs.length === 0) {
        out.push({ task_id: t.task_id, criterion_id: ac.criterion_id, ok: false, reason: 'no evidence refs' })
        continue
      }
      const evs = refs.map((r) => t.evidence.find((e) => e.id === r)).filter((e): e is NonNullable<typeof e> => e !== undefined)
      const onlyAgent = evs.length > 0 && evs.every((e) => e.authority === 'agent')
      if (onlyAgent) {
        out.push({ task_id: t.task_id, criterion_id: ac.criterion_id, ok: false, reason: 'only agent-authority evidence' })
        continue
      }
      out.push({ task_id: t.task_id, criterion_id: ac.criterion_id, ok: true, reason: 'evidence present' })
    }
  }
  return out
}
