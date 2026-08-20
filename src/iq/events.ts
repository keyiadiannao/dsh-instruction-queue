/**
 * dsh-instruction-queue — event vocabulary.
 *
 * Ledger events describe FACTS that happened, never commands. Commands
 * (START_TASK / RETRY_TASK / PAUSE_QUEUE) are tool invocations and never
 * enter the ledger as events; the tool layer translates a command into the
 * fact events that resulted.
 *
 * Every event carries the ledger metadata: seq (monotonic), run_id, and ts.
 * The reducer is a pure function over these — no LLM, no IO (design doc §4).
 *
 * @module dsh-instruction-queue/iq/events
 */

import type { EventSeq, RunId } from './types.ts'

/** Ledger metadata attached to every event. */
export interface EventMeta {
  seq: EventSeq
  run_id: RunId
  ts: string // ISO timestamp
}

/** Run created (queue enabled for a session). */
export interface IQEnabled extends EventMeta {
  kind: 'IQ_ENABLED'
  session_id: string
}

/** A raw user input entered the buffer (facts only; content immutable). */
export interface InputBuffered extends EventMeta {
  kind: 'INPUT_BUFFERED'
  input_id: string
  content: string
  queue_sequence: number
  /** the last event id the user could have seen when typing (supersession) */
  last_visible_event_id: string | null
  session_id: string
}

/** The user asked to compile the buffer. */
export interface CompileRequested extends EventMeta {
  kind: 'COMPILE_REQUESTED'
  /** input sequences included in this compile request */
  input_sequences: number[]
}

/** The compiler produced a proposed queue (facts: the proposal). */
export interface QueueCompiled extends EventMeta {
  kind: 'QUEUE_COMPILED'
  /** the proposed tasks — approval_status: 'proposed' */
  tasks: ProposedTaskEvent[]
  conflicts: { kind: 'supersedes' | 'contradicts'; from_input_id: string; to_input_id: string; note: string }[]
  dependency_cycles: string[][]
  ambiguities: { input_ids: string[]; note: string }[]
}

/** A task as it appears inside QUEUE_COMPILED (approval_status implied). */
export interface ProposedTaskEvent {
  task_id: string
  source_input_ids: string[]
  task: string
  intent_type: string
  targets: string[]
  acceptance_criteria: { criterion_id: string; text: string }[]
  side_effect_class: string
  hard_dependencies: string[]
  soft_affinities: string[]
}

/** The user approved the compiled queue (whole or partial). */
export interface QueueApproved extends EventMeta {
  kind: 'QUEUE_APPROVED'
  /** task ids approved in this event (partial approval allowed) */
  approved_task_ids: string[]
  /** supersession acknowledgements the user confirmed */
  supersessions: { from_input_id: string; to_input_id: string }[]
  /** task ids the user rejected in the same pass */
  rejected_task_ids: string[]
  /** the revision that becomes the immutable approved revision */
  approved_revision: number
}

/** A task was dispatched to the executor (facts: dispatch happened). */
export interface TaskDispatched extends EventMeta {
  kind: 'TASK_DISPATCHED'
  task_id: string
  attempt_id: string
}

/** The executor started work on the attempt. */
export interface AttemptStarted extends EventMeta {
  kind: 'ATTEMPT_STARTED'
  task_id: string
  attempt_id: string
}

/** A side effect was observed (write/external/irreversible) — drives retry policy. */
export interface SideEffectObserved extends EventMeta {
  kind: 'SIDE_EFFECT_OBSERVED'
  task_id: string
  attempt_id: string
  effect_class: string
}

/** Reconcile captured the attempt's result (advisory summary — NOT evidence). */
export interface AttemptResultCaptured extends EventMeta {
  kind: 'ATTEMPT_RESULT_CAPTURED'
  task_id: string
  attempt_id: string
  result_summary: string | null
  /** ids of evidence objects recorded alongside */
  evidence: EvidenceEvent[]
}

/** The attempt outcome was committed to the ledger. */
export interface AttemptCommitted extends EventMeta {
  kind: 'ATTEMPT_COMMITTED'
  task_id: string
  attempt_id: string
  attempt_status: string
  task_execution_status: string
}

/** A criterion of a task was judged satisfied, with evidence refs. */
export interface TaskCriterionSatisfied extends EventMeta {
  kind: 'TASK_CRITERION_SATISFIED'
  task_id: string
  criterion_id: string
  evidence_refs: string[]
}

/** A task was marked covered (all approved criteria have evidence). */
export interface TaskCovered extends EventMeta {
  kind: 'TASK_COVERED'
  task_id: string
  resolution_status: string // 'satisfied' | 'covered' | 'partial' | 'skipped'
  note: string | null
}

/** The queue paused (explicit user interrupt). */
export interface QueuePaused extends EventMeta {
  kind: 'QUEUE_PAUSED'
  note: string
}

/** The queue resumed. */
export interface QueueResumed extends EventMeta {
  kind: 'QUEUE_RESUMED'
}

/** A residual/scope-expansion proposal was recorded (facts: the proposal). */
export interface TaskProposed extends EventMeta {
  kind: 'TASK_PROPOSED'
  task: ProposedTaskEvent
  parent_task_id: string | null
  derived_from_criteria: string[]
  origin: 'residual' | 'proposed_expansion'
}

/** A proposed task was approved by the user (delta approval). */
export interface TaskProposalApproved extends EventMeta {
  kind: 'TASK_PROPOSAL_APPROVED'
  task_id: string
  approved_revision: number
}

/** A proposed task was rejected. */
export interface TaskProposalRejected extends EventMeta {
  kind: 'TASK_PROPOSAL_REJECTED'
  task_id: string
}

/** Execution state became uncertain (crash window) — recovery required. */
export interface RecoveryRequired extends EventMeta {
  kind: 'RECOVERY_REQUIRED'
  note: string
}

/** The run completed: every approved obligation resolved. */
export interface RunCompleted extends EventMeta {
  kind: 'RUN_COMPLETED'
  /** per-task final resolution for the report */
  summary: { task_id: string; resolution_status: string }[]
}

/** The run was aborted by the user. */
export interface RunAborted extends EventMeta {
  kind: 'RUN_ABORTED'
  note: string | null
}

/** Evidence recorded at result capture (subset of the evidence model). */
export interface EvidenceEvent {
  id: string
  type: string
  path?: string
  command?: string
  exit_code?: number
  observed_at: string
  authority: string
  artifact_version?: string
  note?: string
}

/** Every ledger event discriminated by `kind`. */
export type IQEvent =
  | IQEnabled
  | InputBuffered
  | CompileRequested
  | QueueCompiled
  | QueueApproved
  | TaskDispatched
  | AttemptStarted
  | SideEffectObserved
  | AttemptResultCaptured
  | AttemptCommitted
  | TaskCriterionSatisfied
  | TaskCovered
  | QueuePaused
  | QueueResumed
  | TaskProposed
  | TaskProposalApproved
  | TaskProposalRejected
  | RecoveryRequired
  | RunCompleted
  | RunAborted
