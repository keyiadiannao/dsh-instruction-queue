/**
 * dsh-instruction-queue — crash recovery (the reconciliation barrier).
 *
 * Implements the design doc's crash recovery matrix: for every crash point
 * between dispatch and commit, decide from (ledger + authoritative external
 * state) alone what happened, and produce the next fact events. The golden
 * rule: an attempt whose outcome cannot be proven and that is not idempotent
 * is NEVER silently re-run — it goes to `uncertain` / RECOVERY_REQUIRED and
 * the user (or reconcile with fresh evidence) decides.
 *
 * @module dsh-instruction-queue/iq/recovery
 */

import type { IQEvent } from './events.ts'
import type { Attempt, RunState, Task } from './types.ts'

/** What recovery concluded, plus the events to append to the ledger. */
export interface RecoveryDecision {
  /** human-readable description of the conclusion */
  conclusion: string
  /** fact events to append (already seq-assigned by the caller) */
  events: IQEvent[]
  /** true when execution state remains uncertain and needs user input */
  requires_user: boolean
}

/** Authoritative external state the caller supplies (workspace/tool evidence). */
export interface ExternalState {
  /** set when the workspace shows the write actually landed (e.g. file changed) */
  write_landed: boolean
  /** set when a command/action result is provably observed */
  outcome_observed: boolean
  /** set when the attempt's side effect class is read-only */
  idempotent_read: boolean
}

/**
 * Decide recovery for the given task's latest attempt.
 *
 * Matrix (design doc §Crash recovery matrix):
 *   dispatch-before            → safe to dispatch fresh
 *   dispatched, no start       → reconcile (may or may not have begun)
 *   started, no side effect    → uncertain unless outcome observed
 *   read-only result observed  → recoverable, policy decides
 *   write side effect observed → never silently retry
 *   external request, no receipt → uncertain, no auto retry
 *   result captured, pre-commit → recover from evidence
 *   committed, next task pending → continue
 */
export function decideRecovery(
  state: RunState,
  task: Task,
  attempt: Attempt | undefined,
  external: ExternalState,
): RecoveryDecision {
  const events: IQEvent[] = []
  const ts = new Date().toISOString()

  if (attempt === undefined) {
    // Nothing dispatched for this task — safe to dispatch fresh.
    return {
      conclusion: `task ${task.task_id} was never dispatched; safe to dispatch fresh`,
      events,
      requires_user: false,
    }
  }

  switch (attempt.status) {
    case 'dispatched':
      // TASK_DISPATCHED landed but ATTEMPT_STARTED did not: the executor may
      // or may not have begun. If the outcome is observed, it ran; otherwise
      // we cannot distinguish "never started" from "started then crashed".
      if (external.outcome_observed) {
        events.push({
          kind: 'ATTEMPT_STARTED',
          seq: -1, // caller renumbers
          run_id: state.run_id,
          ts,
          task_id: task.task_id,
          attempt_id: attempt.attempt_id,
        })
        events.push(commitEvent(state, task, attempt, 'finished', 'finished', ts))
        return {
          conclusion: `attempt ${attempt.attempt_id} dispatched and outcome observed — treating as finished`,
          events,
          requires_user: false,
        }
      }
      events.push(recoveryRequired(state, task, attempt, ts, 'dispatched but start unproven'))
      return {
        conclusion: `attempt ${attempt.attempt_id} dispatched with no proven start — uncertain`,
        events,
        requires_user: true,
      }

    case 'running': {
      if (external.outcome_observed) {
        // Result is provable → commit it.
        events.push(commitEvent(state, task, attempt, 'finished', 'finished', ts))
        return {
          conclusion: `attempt ${attempt.attempt_id} outcome observed — committing as finished`,
          events,
          requires_user: false,
        }
      }
      if (external.idempotent_read || task.side_effect_class === 'read') {
        // Read-only: a fresh attempt cannot create a duplicate side effect.
        events.push(recoveryRequired(state, task, attempt, ts, 'running with no observed outcome (read-only, safe to re-dispatch)'))
        return {
          conclusion: `attempt ${attempt.attempt_id} running, outcome unproven, read-only — re-dispatch is safe but state is uncertain`,
          events,
          requires_user: false, // policy may re-dispatch; user may also decide
        }
      }
      // Write/external/irreversible: never silently retry.
      events.push(recoveryRequired(state, task, attempt, ts, 'running with unproven non-idempotent outcome — auto retry forbidden'))
      return {
        conclusion: `attempt ${attempt.attempt_id} running with unproven non-idempotent outcome — RECOVERY_REQUIRED, no auto retry`,
        events,
        requires_user: true,
      }
    }

    case 'finished':
      // Committed — nothing to recover.
      return {
        conclusion: `attempt ${attempt.attempt_id} already finished`,
        events,
        requires_user: false,
      }

    case 'failed':
      // Failed attempts may be retried (a failure is a proven outcome).
      return {
        conclusion: `attempt ${attempt.attempt_id} failed (proven) — retry is permitted`,
        events,
        requires_user: false,
      }

    case 'cancelled':
      return {
        conclusion: `attempt ${attempt.attempt_id} cancelled — re-dispatch allowed`,
        events,
        requires_user: false,
      }

    case 'uncertain':
      return {
        conclusion: `attempt ${attempt.attempt_id} already uncertain — awaits user decision`,
        events,
        requires_user: true,
      }

    default:
      return {
        conclusion: `attempt ${attempt.attempt_id} unknown status ${attempt.status}`,
        events,
        requires_user: true,
      }
  }
}

/** Build a RECOVERY_REQUIRED event for the attempt. */
function recoveryRequired(
  state: RunState,
  task: Task,
  attempt: Attempt,
  ts: string,
  detail: string,
): IQEvent {
  return {
    kind: 'RECOVERY_REQUIRED',
    seq: -1,
    run_id: state.run_id,
    ts,
    note: `task ${task.task_id} attempt ${attempt.attempt_id}: ${detail}`,
  }
}

/** Build the commit event pair for an attempt (criterion satisfaction optional). */
function commitEvent(
  state: RunState,
  task: Task,
  attempt: Attempt,
  attemptStatus: Attempt['status'],
  taskStatus: Task['execution_status'],
  ts: string,
): IQEvent {
  return {
    kind: 'ATTEMPT_COMMITTED',
    seq: -1,
    run_id: state.run_id,
    ts,
    task_id: task.task_id,
    attempt_id: attempt.attempt_id,
    attempt_status: attemptStatus,
    task_execution_status: taskStatus,
  }
}
