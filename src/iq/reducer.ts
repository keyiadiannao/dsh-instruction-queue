/**
 * dsh-instruction-queue — pure reducer (ledger → RunState).
 *
 * `reduce(state, event)` is a pure function: no LLM, no IO, no tools. Every
 * RunState field is derived here; nothing is cached outside the projection
 * (System Invariant #9: derived state reconstructible from the ledger).
 *
 * The reducer enforces the invariant checks as it goes (see invariants.ts),
 * so a ledger that violates a constitutional invariant throws on replay.
 *
 * @module dsh-instruction-queue/iq/reducer
 */

import type { IQEvent } from './events.ts'
import { assertInvariants } from './invariants.ts'
import type {
  AcceptanceCriterion,
  Attempt,
  AttemptStatus,
  Evidence,
  EvidenceAuthority,
  RunState,
  Task,
  TaskExecutionStatus,
  TaskResolutionStatus,
} from './types.ts'

/** Initial state for a session's queue (before IQ_ENABLED). */
export function initialRunState(run_id: string, session_id: string): RunState {
  return {
    run_id,
    session_id,
    phase: 'idle',
    enabled: false,
    inputs: [],
    tasks: [],
    active_task_id: null,
    last_seen_event_id: null,
    conflicts: [],
    dependency_cycles: [],
    ambiguities: [],
    event_count: 0,
    paused_note: null,
    recovery_note: null,
    completed_at: null,
    aborted_at: null,
  }
}

/** Replay a full ledger onto the initial state (idempotent, pure). */
export function reduceAll(events: readonly IQEvent[]): RunState {
  let state = initialRunState(events[0]?.run_id ?? '', events[0] && 'session_id' in events[0] ? events[0].session_id : '')
  for (const e of events) {
    state = reduce(state, e)
  }
  return state
}

/** Apply one event. Assumes events arrive in seq order (caller's duty). */
export function reduce(state: RunState, event: IQEvent): RunState {
  // Every event is a fact; the reducer only mutates its own projection.
  const next = applyEvent(state, event)
  const validated = assertInvariants(next)
  return { ...next, event_count: state.event_count + 1 }
}

function applyEvent(state: RunState, event: IQEvent): RunState {
  switch (event.kind) {
    case 'IQ_ENABLED':
      return {
        ...state,
        enabled: true,
        phase: 'collecting',
        last_seen_event_id: event.seq === 0 ? null : `evt-${event.seq - 1}`,
      }

    case 'INPUT_BUFFERED':
      return {
        ...state,
        inputs: [
          ...state.inputs,
          {
            input_id: event.input_id,
            content: event.content,
            queued_at: event.ts,
            queue_sequence: event.queue_sequence,
            last_visible_event_id: event.last_visible_event_id,
            session_id: event.session_id,
          },
        ],
        phase: state.phase === 'idle' ? 'collecting' : state.phase,
      }

    case 'COMPILE_REQUESTED':
      return { ...state, phase: 'compiling' }

    case 'QUEUE_COMPILED': {
      const tasks: Task[] = event.tasks.map((t) => ({
        task_id: t.task_id,
        approval_status: 'proposed',
        origin: 'approved', // origin decided at approval; pre-approval it's the proposed slate
        parent_task_id: null,
        derived_from_criteria: [],
        source_input_ids: t.source_input_ids,
        task: t.task,
        intent_type: t.intent_type as Task['intent_type'],
        targets: t.targets,
        execution_status: 'pending',
        resolution_status: 'open',
        attempts: [],
        acceptance_criteria: t.acceptance_criteria,
        side_effect_class: t.side_effect_class as Task['side_effect_class'],
        hard_dependencies: t.hard_dependencies,
        soft_affinities: t.soft_affinities,
        evidence: [],
        coverage: { satisfied_by: [], criteria_met: [] },
        revision: 1,
        approved_task_revision: null,
        approved_acceptance_criteria: [],
      }))
      // Replace the proposed slate (a recompile supersedes the previous
      // proposal entirely — pre-approval there is nothing immutable yet).
      const keep = state.tasks.filter((t) => t.approval_status === 'approved')
      return {
        ...state,
        tasks: [...keep, ...tasks],
        conflicts: event.conflicts,
        dependency_cycles: event.dependency_cycles,
        ambiguities: event.ambiguities,
        phase: 'awaiting_approval',
      }
    }

    case 'QUEUE_APPROVED': {
      const approvedIds = new Set(event.approved_task_ids)
      const rejectedIds = new Set(event.rejected_task_ids)
      const tasks = state.tasks.map((t) => {
        if (approvedIds.has(t.task_id)) {
          return {
            ...t,
            approval_status: 'approved' as const,
            origin: 'approved' as const,
            revision: event.approved_revision,
            approved_task_revision: event.approved_revision,
            approved_acceptance_criteria: [...t.acceptance_criteria],
          }
        }
        if (rejectedIds.has(t.task_id)) {
          return { ...t, approval_status: 'rejected' as const }
        }
        return t
      })
      return {
        ...state,
        tasks,
        phase: approvedIds.size > 0 ? 'ready' : 'awaiting_approval',
      }
    }

    case 'TASK_DISPATCHED': {
      const task = state.tasks.find((t) => t.task_id === event.task_id)
      if (!task) return state
      const attempt: Attempt = {
        attempt_id: event.attempt_id,
        status: 'dispatched',
        dispatched_at: event.ts,
        started_at: null,
        finished_at: null,
        side_effect_observed: false,
        result_summary: null,
        evidence_ids: [],
      }
      const tasks = state.tasks.map((t) =>
        t.task_id === event.task_id
          ? { ...t, attempts: [...t.attempts, attempt], execution_status: 'running' as TaskExecutionStatus }
          : t,
      )
      return {
        ...state,
        tasks,
        active_task_id: event.task_id,
        phase: 'executing',
      }
    }

    case 'ATTEMPT_STARTED': {
      const tasks = state.tasks.map((t) => {
        if (t.task_id !== event.task_id) return t
        const attempts = t.attempts.map((a) =>
          a.attempt_id === event.attempt_id
            ? { ...a, status: 'running' as AttemptStatus, started_at: event.ts }
            : a,
        )
        return { ...t, attempts }
      })
      return { ...state, tasks }
    }

    case 'SIDE_EFFECT_OBSERVED': {
      const tasks = state.tasks.map((t) => {
        if (t.task_id !== event.task_id) return t
        const attempts = t.attempts.map((a) =>
          a.attempt_id === event.attempt_id ? { ...a, side_effect_observed: true } : a,
        )
        return { ...t, attempts }
      })
      return { ...state, tasks }
    }

    case 'ATTEMPT_RESULT_CAPTURED': {
      const evidence: Evidence[] = event.evidence.map((e) => ({
        id: e.id,
        type: e.type as Evidence['type'],
        ...(e.path !== undefined ? { path: e.path } : {}),
        ...(e.command !== undefined ? { command: e.command } : {}),
        ...(e.exit_code !== undefined ? { exit_code: e.exit_code } : {}),
        observed_at: e.observed_at,
        authority: e.authority as EvidenceAuthority,
        ...(e.artifact_version !== undefined ? { artifact_version: e.artifact_version } : {}),
        ...(e.note !== undefined ? { note: e.note } : {}),
      }))
      const tasks = state.tasks.map((t) => {
        if (t.task_id !== event.task_id) return t
        const attempts = t.attempts.map((a) =>
          a.attempt_id === event.attempt_id
            ? { ...a, result_summary: event.result_summary, evidence_ids: evidence.map((e) => e.id) }
            : a,
        )
        return { ...t, attempts, evidence: [...t.evidence, ...evidence] }
      })
      return { ...state, tasks, phase: 'reconciling' }
    }

    case 'ATTEMPT_COMMITTED': {
      const tasks = state.tasks.map((t) => {
        if (t.task_id !== event.task_id) return t
        const attempts = t.attempts.map((a) =>
          a.attempt_id === event.attempt_id
            ? { ...a, status: event.attempt_status as AttemptStatus, finished_at: event.ts }
            : a,
        )
        const execution: TaskExecutionStatus = event.task_execution_status as TaskExecutionStatus
        return { ...t, attempts, execution_status: execution }
      })
      const active = state.active_task_id === event.task_id ? null : state.active_task_id
      return { ...state, tasks, active_task_id: active }
    }

    case 'TASK_CRITERION_SATISFIED': {
      const tasks = state.tasks.map((t) => {
        if (t.task_id !== event.task_id) return t
        const criteria_met = [
          ...t.coverage.criteria_met.filter((c) => c.criterion_id !== event.criterion_id),
          { criterion_id: event.criterion_id, evidence_refs: event.evidence_refs },
        ]
        const satisfied_by = Array.from(new Set([...t.coverage.satisfied_by, event.task_id]))
        return { ...t, coverage: { satisfied_by, criteria_met } }
      })
      return { ...state, tasks }
    }

    case 'TASK_COVERED': {
      const tasks = state.tasks.map((t) =>
        t.task_id === event.task_id
          ? { ...t, resolution_status: event.resolution_status as TaskResolutionStatus }
          : t,
      )
      return { ...state, tasks }
    }

    case 'QUEUE_PAUSED':
      return { ...state, phase: 'paused', paused_note: event.note }

    case 'QUEUE_RESUMED':
      return { ...state, phase: 'ready', paused_note: null }

    case 'TASK_PROPOSED': {
      // Residual inherits authority from its parent approved obligation:
      // approval_status = not_required (executable carrier, NOT a new
      // obligation, never enters the completion denominator). A scope-
      // expanding proposal needs user approval (Invariant #4).
      const isResidual = event.origin === 'residual'
      const approvalStatus = isResidual ? 'not_required' as const : 'proposed' as const
      const task: Task = {
        task_id: event.task.task_id,
        approval_status: approvalStatus,
        origin: event.origin,
        parent_task_id: event.parent_task_id,
        derived_from_criteria: event.derived_from_criteria,
        source_input_ids: event.task.source_input_ids,
        task: event.task.task,
        intent_type: event.task.intent_type as Task['intent_type'],
        targets: event.task.targets,
        execution_status: 'pending',
        resolution_status: 'open',
        attempts: [],
        acceptance_criteria: event.task.acceptance_criteria,
        side_effect_class: event.task.side_effect_class as Task['side_effect_class'],
        hard_dependencies: event.task.hard_dependencies,
        soft_affinities: event.task.soft_affinities,
        evidence: [],
        coverage: { satisfied_by: [], criteria_met: [] },
        revision: 1,
        approved_task_revision: null,
        approved_acceptance_criteria: [],
      }
      // Residual auto-enters the executable graph (still ready); expansion
      // lands in awaiting_approval until the user decides.
      return {
        ...state,
        tasks: [...state.tasks, task],
        phase: isResidual ? (state.phase === 'ready' ? 'ready' : 'executing') : 'awaiting_approval',
      }
    }

    case 'TASK_PROPOSAL_APPROVED': {
      const tasks = state.tasks.map((t) =>
        t.task_id === event.task_id
          ? {
              ...t,
              approval_status: 'approved' as const,
              revision: event.approved_revision,
              approved_task_revision: event.approved_revision,
              approved_acceptance_criteria: [...t.acceptance_criteria],
            }
          : t,
      )
      return { ...state, tasks, phase: 'ready' }
    }

    case 'TASK_PROPOSAL_REJECTED': {
      const tasks = state.tasks.map((t) =>
        t.task_id === event.task_id ? { ...t, approval_status: 'rejected' as const } : t,
      )
      return { ...state, tasks }
    }

    case 'RECOVERY_REQUIRED':
      return { ...state, phase: 'recovery_required', recovery_note: event.note }

    case 'QUEUE_BLOCKED':
      return { ...state, phase: 'blocked', recovery_note: event.note }

    case 'RUN_COMPLETED': {
      const tasks = state.tasks.map((t) => {
        const s = event.summary.find((x) => x.task_id === t.task_id)
        return s ? { ...t, resolution_status: s.resolution_status as TaskResolutionStatus } : t
      })
      return {
        ...state,
        tasks,
        phase: 'completed',
        completed_at: event.ts,
        active_task_id: null,
      }
    }

    case 'RUN_ABORTED':
      return { ...state, phase: 'aborted', aborted_at: event.ts, active_task_id: null }

    default:
      // Exhaustiveness: unreachable with a well-typed IQEvent.
      return state
  }
}

/** Convenience: a task's current (latest) attempt. */
export function latestAttempt(task: Task): Attempt | undefined {
  return task.attempts[task.attempts.length - 1]
}

/** All approved obligations (approval_status === 'approved'). */
export function approvedObligations(state: RunState): Task[] {
  return state.tasks.filter((t) => t.approval_status === 'approved')
}

/**
 * All executable tasks: approved obligations PLUS residual carriers.
 * Residuals inherit authority from their parent approved obligation
 * (approval_status = not_required) and are execution carriers, but they are
 * NOT obligations — they never enter the completion denominator.
 */
export function executableTasks(state: RunState): Task[] {
  return state.tasks.filter((t) =>
    t.approval_status === 'approved'
    || (t.origin === 'residual' && t.approval_status === 'not_required'),
  )
}

/** True when every approved obligation is resolved (completion gate). */
export function allApprovedResolved(state: RunState): boolean {
  const approved = approvedObligations(state)
  if (approved.length === 0) return false
  return approved.every((t) =>
    t.resolution_status === 'satisfied'
    || t.resolution_status === 'covered'
    || t.resolution_status === 'skipped',
  )
}

/**
 * Find the next dispatchable task (topological, dependency-aware).
 *
 * RESIDUAL PRIORITY: when an approved task is partial/open and has residual
 * carriers (origin 'residual' bounds the remaining work of its parent), we
 * dispatch the RESIDUAL first — NOT re-run the parent. This keeps the design
 * invariant that residuals are the execution carriers for the remaining part
 * of an approved obligation, and prevents the bug where the parent (which sits
 * earlier in `state.tasks`) is re-selected before its residual.
 */
export function nextDispatchable(state: RunState): Task | null {
  if (state.active_task_id !== null) return null // invariant #7
  const candidates = executableTasks(state).filter((t) =>
    (t.execution_status === 'pending' || t.execution_status === 'failed')
    || (t.execution_status === 'finished' && (t.resolution_status === 'open' || t.resolution_status === 'partial')),
  )
  const resolvedIds = new Set(
    executableTasks(state)
      .filter((t) => t.resolution_status === 'satisfied' || t.resolution_status === 'covered')
      .map((t) => t.task_id),
  )
  // 1) Residual carriers (pending/failed) rank before their parents: they are
  //    the remaining-work carriers, so dispatch them first.
  const parentsWithOpenResidual = new Set(
    candidates.filter((t) => t.execution_status === 'pending' && t.origin === 'residual').map((t) => t.parent_task_id),
  )
  const ordered = [
    ...candidates.filter((t) => t.origin === 'residual' && t.execution_status === 'pending'),
    // Parents whose still-open remaining work is fully delegated to a residual
    // are NOT re-dispatched (the residual owns it); parents with no residual
    // keep working directly.
    ...candidates.filter((t) => t.origin !== 'residual' && !(t.execution_status === 'finished'
      && (t.resolution_status === 'partial' || t.resolution_status === 'open')
      && parentsWithOpenResidual.has(t.task_id))),
  ]
  for (const t of ordered) {
    const depsMet = t.hard_dependencies.every((d) => resolvedIds.has(d))
    if (depsMet) return t
  }
  return null
}
