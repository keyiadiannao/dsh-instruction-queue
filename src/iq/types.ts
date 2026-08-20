/**
 * dsh-instruction-queue — domain types.
 *
 * The event-sourced obligation orchestrator's vocabulary.
 *
 * Conventions:
 *  - Ledger (events.ndjson) is the single source of truth. RunState is a
 *    pure projection of it (System Invariant #9) — nothing here is a cache.
 *  - Every task carries BOTH execution status (what the agent did) and
 *    resolution status (what the obligation means for completion).
 *  - Attempt status is separate from task status: a cancelled attempt never
 *    permanently cancels its task.
 *
 * @module dsh-instruction-queue/iq/types
 */

/** A queue run — one collection/compile/execute/reconcile cycle. */
export type RunId = string

/** Monotonic ledger event sequence number. */
export type EventSeq = number

/** Queue phase (the state machine in the design doc). */
export type QueuePhase =
  | 'idle' // no active run
  | 'collecting' // inputs buffer, nothing executes
  | 'compiling' // LLM reads buffer → intent extraction → task queue JSON
  | 'awaiting_approval' // user reviews the compiled queue
  | 'ready' // approved queue exists, next task dispatchable
  | 'executing' // exactly one task owns the main agent
  | 'reconciling' // absorb result + revise remaining graph
  | 'completing' // final coverage audit
  | 'completed' // all approved obligations resolved
  | 'paused' // explicit stop between/in segments
  | 'blocked' // needs user / agent plan / tool to proceed
  | 'aborted' // user terminated the run
  | 'recovery_required' // crash with uncertain execution state

/** Attempt lifecycle (per attempt of a task). */
export type AttemptStatus =
  | 'dispatched'
  | 'running'
  | 'finished'
  | 'failed'
  | 'cancelled'
  | 'uncertain'

/** Task execution status (what the agent did with this task). */
export type TaskExecutionStatus =
  | 'pending'
  | 'running'
  | 'finished'
  | 'failed'
  | 'uncertain'

/** Task resolution status (what the obligation means for completion). */
export type TaskResolutionStatus =
  | 'open'
  | 'satisfied'
  | 'partial'
  | 'covered'
  | 'skipped'
  | 'blocked'

/** Approval status — the obligation test: approved ⇒ obligation. */
export type ApprovalStatus = 'not_required' | 'proposed' | 'approved' | 'rejected'

/** Task origin — residual vs scope-expansion decide auto-enter vs approval. */
export type TaskOrigin = 'approved' | 'residual' | 'proposed_expansion'

/** Intent kinds the compiler may assign. */
export type IntentType = 'inspect' | 'modify' | 'decide' | 'verify' | 'explain'

/** Side-effect class — drives at-most-once retry policy. */
export type SideEffectClass = 'read' | 'write' | 'external' | 'irreversible'

/** Evidence authority — agent conclusions are weakest, never standalone. */
export type EvidenceAuthority = 'tool' | 'workspace' | 'agent'

/** A raw user input, captured at collect time, never mutated (Invariant #1). */
export interface RawInput {
  input_id: string
  content: string
  queued_at: string // ISO timestamp
  queue_sequence: number
  /** The last assistant/agent event the user could have seen when typing. */
  last_visible_event_id: string | null
  session_id: string
}

/** One attempt of one task — immutable execution envelope per attempt. */
export interface Attempt {
  attempt_id: string
  status: AttemptStatus
  dispatched_at: string | null
  started_at: string | null
  finished_at: string | null
  /** Set when a write/external/irreversible side effect was observed. */
  side_effect_observed: boolean
  /** Result captured by reconcile — advisory summary, not evidence. */
  result_summary: string | null
  /** Evidence refs captured for this attempt. */
  evidence_ids: string[]
}

/**
 * An acceptance criterion. The stable primary key is
 * `${run_id}/${task_id}@rev${approved_revision}/${criterion_id}` — a revision
 * bumps the identity so evidence is never ambiguous across revisions.
 */
export interface AcceptanceCriterion {
  criterion_id: string
  text: string
}

/** Structured evidence — the only thing that can satisfy an AC. */
export interface Evidence {
  id: string
  type: 'file_change' | 'command_result' | 'workspace_state' | 'agent_conclusion' | 'external'
  path?: string
  command?: string
  exit_code?: number
  observed_at: string
  authority: EvidenceAuthority
  /** freshness: e.g. git blob hash / artifact version the evidence describes */
  artifact_version?: string
  note?: string
}

/** Coverage bookkeeping — a task is covered per-criterion with evidence refs. */
export interface CriterionCoverage {
  criterion_id: string
  evidence_refs: string[]
}

export interface Coverage {
  /** Tasks whose execution contributed to satisfying this task. */
  satisfied_by: string[]
  criteria_met: CriterionCoverage[]
}

/** A queue task (obligation carrier). */
export interface Task {
  task_id: string
  approval_status: ApprovalStatus
  origin: TaskOrigin
  /** residual lineage: the approved task this residual derives from */
  parent_task_id: string | null
  /** which ACs this residual was derived from (anti double-count audit) */
  derived_from_criteria: string[]
  /** provenance: maps back to raw inputs */
  source_input_ids: string[]
  task: string
  intent_type: IntentType
  targets: string[]
  execution_status: TaskExecutionStatus
  resolution_status: TaskResolutionStatus
  attempts: Attempt[]
  acceptance_criteria: AcceptanceCriterion[]
  side_effect_class: SideEffectClass
  hard_dependencies: string[]
  soft_affinities: string[]
  evidence: Evidence[]
  coverage: Coverage
  /** current revision */
  revision: number
  /** revision locked at approval (the immutable boundary, Invariant #2) */
  approved_task_revision: number | null
  /** the AC set that was actually approved (locked semantics) */
  approved_acceptance_criteria: AcceptanceCriterion[]
}

/** Projection of the ledger (derived state — reconstructible, Invariant #9). */
export interface RunState {
  run_id: RunId
  session_id: string
  phase: QueuePhase
  enabled: boolean
  /** inputs in queue order; immutable once buffered */
  inputs: RawInput[]
  tasks: Task[]
  /** which task currently owns execution (Invariant #7: at most one) */
  active_task_id: string | null
  /** the one event id the collection cursor has seen (supersession context) */
  last_seen_event_id: string | null
  /** compile diagnostics from the last compile */
  conflicts: CompileConflict[]
  dependency_cycles: string[][]
  ambiguities: CompileAmbiguity[]
  /** events replayed (for recovery/debug); derived, not authoritative */
  event_count: number
  paused_note: string | null
  recovery_note: string | null
  completed_at: string | null
  aborted_at: string | null
}

/** A supersession / contradiction found at compile time. */
export interface CompileConflict {
  /** e.g. "input 7 replaces input 2" */
  kind: 'supersedes' | 'contradicts'
  from_input_id: string
  to_input_id: string
  note: string
}

/** An ambiguity the compiler could not resolve silently. */
export interface CompileAmbiguity {
  input_ids: string[]
  note: string
}

/** Result of compiling raw inputs into a proposed queue (pre-approval). */
export interface CompiledQueue {
  tasks: Task[]
  conflicts: CompileConflict[]
  dependency_cycles: string[][]
  ambiguities: CompileAmbiguity[]
  /** inputs consumed by this compile (their queue_sequences) */
  consumed_input_sequences: number[]
}
