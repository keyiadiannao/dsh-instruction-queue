/**
 * Residual authorization + blocked-phase reducer tests (P0-4 / P0-2).
 */

import { describe, expect, it } from 'vitest'
import type { IQEvent } from '../src/iq/events.ts'
import {
  allApprovedResolved,
  approvedObligations,
  executableTasks,
  initialRunState,
  nextDispatchable,
  reduce,
} from '../src/iq/reducer.ts'

const SID = 'sess-test'

function base(): IQEvent {
  return { kind: 'IQ_ENABLED', seq: 0, run_id: 'R1', ts: 't', session_id: SID }
}

function input(seq: number): IQEvent {
  return { kind: 'INPUT_BUFFERED', seq, run_id: 'R1', ts: 't', input_id: `IN${seq}`, content: 'x', queue_sequence: seq, last_visible_event_id: null, session_id: SID }
}

function compiled(seq: number, ids: string[] = ['T1']): IQEvent {
  return {
    kind: 'QUEUE_COMPILED', seq, run_id: 'R1', ts: 't',
    tasks: ids.map((id, i) => ({
      task_id: id, source_input_ids: [`IN${i + 1}`], task: `task ${id}`,
      intent_type: 'modify', targets: [], acceptance_criteria: [{ criterion_id: 'AC1', text: 'c' }],
      side_effect_class: 'write', hard_dependencies: [], soft_affinities: [],
    })),
    conflicts: [], dependency_cycles: [], ambiguities: [],
  }
}

function approved(seq: number, ids: string[] = ['T1']): IQEvent {
  return {
    kind: 'QUEUE_APPROVED', seq, run_id: 'R1', ts: 't',
    approved_task_ids: ids, supersessions: [], rejected_task_ids: [], approved_revision: 1,
  }
}

/** A residual proposal event (as reconcile emits for origin=residual). */
function residualProposal(seq: number, taskId = 'T1.R1'): IQEvent {
  return {
    kind: 'TASK_PROPOSED', seq, run_id: 'R1', ts: 't',
    task: {
      task_id: taskId, source_input_ids: [], task: 'residual work', intent_type: 'modify',
      targets: [], acceptance_criteria: [{ criterion_id: 'AC1', text: 'finish' }],
      side_effect_class: 'write', hard_dependencies: [], soft_affinities: [],
    },
    parent_task_id: 'T1',
    derived_from_criteria: ['AC1'],
    origin: 'residual',
  }
}

/** An expansion proposal event (origin=proposed_expansion). */
function expansionProposal(seq: number, taskId = 'T1.X1'): IQEvent {
  return {
    kind: 'TASK_PROPOSED', seq, run_id: 'R1', ts: 't',
    task: {
      task_id: taskId, source_input_ids: [], task: 'expand scope', intent_type: 'modify',
      targets: [], acceptance_criteria: [{ criterion_id: 'AC1', text: 'new scope' }],
      side_effect_class: 'write', hard_dependencies: [], soft_affinities: [],
    },
    parent_task_id: 'T1',
    derived_from_criteria: [],
    origin: 'proposed_expansion',
  }
}

describe('residual authorization (P0-4)', () => {
  it('residual proposal → approval_status=not_required, auto-enters graph', () => {
    let s = reduce(initialRunState('R1', SID), base())
    s = reduce(s, input(1))
    s = reduce(s, compiled(2))
    s = reduce(s, approved(3))
    expect(s.phase).toBe('ready')
    s = reduce(s, residualProposal(4))
    const residual = s.tasks.find((t) => t.task_id === 'T1.R1')!
    expect(residual.approval_status).toBe('not_required')
    expect(residual.origin).toBe('residual')
    expect(s.phase).toBe('ready') // residual does NOT park in awaiting_approval
  })

  it('residual is dispatchable (execution carrier)', () => {
    let s = reduce(initialRunState('R1', SID), base())
    s = reduce(s, input(1))
    s = reduce(s, compiled(2))
    s = reduce(s, approved(3))
    // T1 resolves; residual T1.R1 is the remaining work.
    s = reduce(s, residualProposal(4))
    s = reduce(s, { kind: 'TASK_DISPATCHED', seq: 5, run_id: 'R1', ts: 't', task_id: 'T1', attempt_id: 'A1' })
    s = reduce(s, { kind: 'ATTEMPT_RESULT_CAPTURED', seq: 6, run_id: 'R1', ts: 't', task_id: 'T1', attempt_id: 'A1', result_summary: null, evidence: [] })
    s = reduce(s, { kind: 'ATTEMPT_COMMITTED', seq: 7, run_id: 'R1', ts: 't', task_id: 'T1', attempt_id: 'A1', attempt_status: 'finished', task_execution_status: 'finished' })
    s = reduce(s, { kind: 'TASK_CRITERION_SATISFIED', seq: 8, run_id: 'R1', ts: 't', task_id: 'T1', criterion_id: 'AC1', evidence_refs: ['E1'] })
    s = reduce(s, { kind: 'TASK_COVERED', seq: 9, run_id: 'R1', ts: 't', task_id: 'T1', resolution_status: 'satisfied', note: null })
    const next = nextDispatchable(s)
    expect(next?.task_id).toBe('T1.R1')
  })

  it('residual is NOT an approved obligation (excluded from denominator)', () => {    let s = reduce(initialRunState('R1', SID), base())
    s = reduce(s, input(1))
    s = reduce(s, compiled(2))
    s = reduce(s, approved(3))
    s = reduce(s, residualProposal(4))
    expect(approvedObligations(s).map((t) => t.task_id)).toEqual(['T1'])
    expect(executableTasks(s).map((t) => t.task_id)).toContain('T1.R1')
    // T1 unresolved → completion still blocked even though residual exists.
    expect(allApprovedResolved(s)).toBe(false)
  })

  it('expansion proposal → approval_status=proposed, awaiting_approval', () => {
    let s = reduce(initialRunState('R1', SID), base())
    s = reduce(s, input(1))
    s = reduce(s, compiled(2))
    s = reduce(s, approved(3))
    s = reduce(s, expansionProposal(4))
    const exp = s.tasks.find((t) => t.task_id === 'T1.X1')!
    expect(exp.approval_status).toBe('proposed')
    expect(s.phase).toBe('awaiting_approval')
    // Expansion is not executable pre-approval (not in the executable set).
    expect(executableTasks(s).map((t) => t.task_id)).not.toContain('T1.X1')
  })

  it('father partial + pending residual → dispatches the residual, NOT the father again', () => {
    // GPT review P0#4: the parent sits earlier in state.tasks than its
    // residual, so nextDispatchable used to re-run the parent (finished+partial)
    // before the residual. Residual must win — it owns the remaining work.
    let s = reduce(initialRunState('R1', SID), base())
    s = reduce(s, input(1))
    s = reduce(s, compiled(2))
    s = reduce(s, approved(3))
    // T1 finishes PARTIAL (not all ACs met) → reconcile proposes residual T1.R1.
    s = reduce(s, residualProposal(4))
    // Mark T1 finished+partial (its remaining work is now owned by T1.R1).
    s = reduce(s, { kind: 'TASK_DISPATCHED', seq: 5, run_id: 'R1', ts: 't', task_id: 'T1', attempt_id: 'A1' })
    s = reduce(s, { kind: 'ATTEMPT_RESULT_CAPTURED', seq: 6, run_id: 'R1', ts: 't', task_id: 'T1', attempt_id: 'A1', result_summary: 'partial', evidence: [] })
    s = reduce(s, { kind: 'ATTEMPT_COMMITTED', seq: 7, run_id: 'R1', ts: 't', task_id: 'T1', attempt_id: 'A1', attempt_status: 'finished', task_execution_status: 'finished' })
    s = reduce(s, { kind: 'TASK_COVERED', seq: 8, run_id: 'R1', ts: 't', task_id: 'T1', resolution_status: 'partial', note: 'remaining owned by residual' })
    const next = nextDispatchable(s)
    // Parent T1 is finished+partial with an open residual → residual T1.R1 wins.
    expect(next?.task_id).toBe('T1.R1')
  })
})

describe('QUEUE_BLOCKED (P0-2)', () => {
  it('sets phase=blocked and records the audit note', () => {
    let s = reduce(initialRunState('R1', SID), base())
    s = reduce(s, { kind: 'QUEUE_BLOCKED', seq: 1, run_id: 'R1', ts: 't', note: 'final coverage audit failed' })
    expect(s.phase).toBe('blocked')
    expect(s.recovery_note).toMatch(/coverage audit failed/)
  })
})

describe('dispatch/start separation (P0-5)', () => {
  it('TASK_DISPATCHED alone leaves the attempt dispatched, not running', () => {
    let s = reduce(initialRunState('R1', SID), base())
    s = reduce(s, input(1))
    s = reduce(s, compiled(2))
    s = reduce(s, approved(3))
    s = reduce(s, { kind: 'TASK_DISPATCHED', seq: 4, run_id: 'R1', ts: 't', task_id: 'T1', attempt_id: 'A1' })
    const t = s.tasks.find((x) => x.task_id === 'T1')!
    expect(t.attempts[0]!.status).toBe('dispatched')
    expect(s.active_task_id).toBe('T1')
    // ATTEMPT_STARTED flips it to running.
    s = reduce(s, { kind: 'ATTEMPT_STARTED', seq: 5, run_id: 'R1', ts: 't', task_id: 'T1', attempt_id: 'A1' })
    expect(s.tasks.find((x) => x.task_id === 'T1')!.attempts[0]!.status).toBe('running')
  })
})
