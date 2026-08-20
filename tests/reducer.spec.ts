/**
 * Reducer tests: ledger → RunState projection (pure, no LLM/IO).
 */

import { describe, expect, it } from 'vitest'
import type { IQEvent } from '../src/iq/events.ts'
import {
  allApprovedResolved,
  approvedObligations,
  initialRunState,
  latestAttempt,
  nextDispatchable,
  reduce,
  reduceAll,
} from '../src/iq/reducer.ts'
import type { RunState } from '../src/iq/types.ts'

const SID = 'sess-test'

function base(): IQEvent {
  return { kind: 'IQ_ENABLED', seq: 0, run_id: 'R1', ts: '2026-08-20T00:00:00.000Z', session_id: SID }
}

function input(seq: number, content: string, inputId = `IN${seq}`): IQEvent {
  return {
    kind: 'INPUT_BUFFERED', seq, run_id: 'R1', ts: '2026-08-20T00:00:00.000Z',
    input_id: inputId, content, queue_sequence: seq, last_visible_event_id: null, session_id: SID,
  }
}

function compiled(seq: number, taskIds: string[] = ['T1']): IQEvent {
  return {
    kind: 'QUEUE_COMPILED', seq, run_id: 'R1', ts: '2026-08-20T00:00:00.000Z',
    tasks: taskIds.map((id, i) => ({
      task_id: id,
      source_input_ids: [`IN${i + 1}`],
      task: `task ${id}`,
      intent_type: 'modify',
      targets: ['x.ts'],
      acceptance_criteria: [{ criterion_id: 'AC1', text: 'criterion' }],
      side_effect_class: 'write',
      hard_dependencies: [],
      soft_affinities: [],
    })),
    conflicts: [],
    dependency_cycles: [],
    ambiguities: [],
  }
}

function approved(seq: number, taskIds: string[] = ['T1']): IQEvent {
  return {
    kind: 'QUEUE_APPROVED', seq, run_id: 'R1', ts: '2026-08-20T00:00:00.000Z',
    approved_task_ids: taskIds,
    supersessions: [],
    rejected_task_ids: [],
    approved_revision: 1,
  }
}

describe('reducer basics', () => {
  it('enable → collecting with empty inputs', () => {
    const s = reduce(initialRunState('R1', SID), base())
    expect(s.enabled).toBe(true)
    expect(s.phase).toBe('collecting')
    expect(s.inputs).toHaveLength(0)
  })

  it('buffered inputs are immutable records with monotonic sequence', () => {
    let s = reduce(initialRunState('R1', SID), base())
    s = reduce(s, input(1, 'first'))
    s = reduce(s, input(2, 'second'))
    expect(s.inputs).toHaveLength(2)
    expect(s.inputs[0]!.content).toBe('first')
    expect(s.inputs[1]!.queue_sequence).toBe(2)
  })

  it('replay is deterministic: reduceAll over same ledger equals stepwise', () => {
    const ledger = [base(), input(1, 'a'), input(2, 'b'), compiled(3), approved(4)]
    const a = reduceAll(ledger)
    let b = initialRunState('R1', SID)
    for (const e of ledger) b = reduce(b, e)
    expect(a).toEqual(b)
  })
})

describe('compile → approve lifecycle', () => {
  it('QUEUE_COMPILED replaces the proposed slate, keeps approved tasks', () => {
    let s = reduce(initialRunState('R1', SID), base())
    s = reduce(s, input(1, 'a'))
    s = reduce(s, compiled(2, ['T1', 'T2']))
    expect(s.phase).toBe('awaiting_approval')
    expect(s.tasks).toHaveLength(2)
    s = reduce(s, approved(3, ['T1']))
    expect(s.tasks[0]!.approval_status).toBe('approved')
    expect(s.tasks[0]!.approved_task_revision).toBe(1)
    expect(s.tasks[1]!.approval_status).toBe('proposed')
    // Recompile: approved T1 survives, T2 is replaced by the new proposal.
    s = reduce(s, compiled(4, ['T3']))
    expect(s.tasks.map((t) => t.task_id).sort()).toEqual(['T1', 'T3'])
    expect(s.tasks.find((t) => t.task_id === 'T1')!.approval_status).toBe('approved')
  })

  it('approved task locks approved_acceptance_criteria', () => {
    let s = reduce(initialRunState('R1', SID), base())
    s = reduce(s, input(1, 'a'))
    s = reduce(s, compiled(2))
    s = reduce(s, approved(3))
    const t = s.tasks[0]!
    expect(t.approved_task_revision).toBe(1)
    expect(t.approved_acceptance_criteria).toEqual([{ criterion_id: 'AC1', text: 'criterion' }])
  })
})

describe('execution lifecycle', () => {
  function runWithOneTask(): RunState {
    let s = reduce(initialRunState('R1', SID), base())
    s = reduce(s, input(1, 'a'))
    s = reduce(s, compiled(2))
    s = reduce(s, approved(3))
    return s
  }

  it('dispatch sets active task and running status', () => {
    const s0 = runWithOneTask()
    const s1 = reduce(s0, { kind: 'TASK_DISPATCHED', seq: 4, run_id: 'R1', ts: 't', task_id: 'T1', attempt_id: 'A1' })
    const s2 = reduce(s1, { kind: 'ATTEMPT_STARTED', seq: 5, run_id: 'R1', ts: 't', task_id: 'T1', attempt_id: 'A1' })
    expect(s2.active_task_id).toBe('T1')
    expect(s2.tasks[0]!.execution_status).toBe('running')
    expect(latestAttempt(s2.tasks[0]!)!.status).toBe('running')
    // Invariant #7: no next dispatch while active.
    expect(nextDispatchable(s2)).toBeNull()
  })

  it('result capture + commit clears active and sets execution status', () => {
    const s0 = runWithOneTask()
    const s1 = reduce(s0, { kind: 'TASK_DISPATCHED', seq: 4, run_id: 'R1', ts: 't', task_id: 'T1', attempt_id: 'A1' })
    const s2 = reduce(s1, { kind: 'ATTEMPT_RESULT_CAPTURED', seq: 5, run_id: 'R1', ts: 't', task_id: 'T1', attempt_id: 'A1', result_summary: 'done', evidence: [{ id: 'E1', type: 'file_change', path: 'x.ts', observed_at: 't', authority: 'tool' }] })
    const s3 = reduce(s2, { kind: 'ATTEMPT_COMMITTED', seq: 6, run_id: 'R1', ts: 't', task_id: 'T1', attempt_id: 'A1', attempt_status: 'finished', task_execution_status: 'finished' })
    expect(s3.active_task_id).toBeNull()
    expect(s3.tasks[0]!.execution_status).toBe('finished')
  })

  it('criterion satisfied + covered resolve the task', () => {
    let s = runWithOneTask()
    s = reduce(s, { kind: 'TASK_DISPATCHED', seq: 4, run_id: 'R1', ts: 't', task_id: 'T1', attempt_id: 'A1' })
    s = reduce(s, { kind: 'ATTEMPT_RESULT_CAPTURED', seq: 5, run_id: 'R1', ts: 't', task_id: 'T1', attempt_id: 'A1', result_summary: 'done', evidence: [{ id: 'E1', type: 'file_change', path: 'x.ts', observed_at: 't', authority: 'tool' }] })
    s = reduce(s, { kind: 'ATTEMPT_COMMITTED', seq: 6, run_id: 'R1', ts: 't', task_id: 'T1', attempt_id: 'A1', attempt_status: 'finished', task_execution_status: 'finished' })
    s = reduce(s, { kind: 'TASK_CRITERION_SATISFIED', seq: 7, run_id: 'R1', ts: 't', task_id: 'T1', criterion_id: 'AC1', evidence_refs: ['E1'] })
    s = reduce(s, { kind: 'TASK_COVERED', seq: 8, run_id: 'R1', ts: 't', task_id: 'T1', resolution_status: 'satisfied', note: null })
    expect(s.tasks[0]!.resolution_status).toBe('satisfied')
    expect(s.tasks[0]!.coverage.criteria_met[0]!.evidence_refs).toEqual(['E1'])
    expect(allApprovedResolved(s)).toBe(true)
  })

  it('completion gate: unresolved obligation blocks completion (invariant #8)', () => {
    const s0 = runWithOneTask()
    // No resolution events yet.
    expect(allApprovedResolved(s0)).toBe(false)
    expect(() => reduce(s0, { kind: 'RUN_COMPLETED', seq: 4, run_id: 'R1', ts: 't', summary: [{ task_id: 'T1', resolution_status: 'open' }] }))
      .toThrow(/invariant #8/)
  })

  it('partial approval: unapproved tasks are not obligations', () => {
    let s = reduce(initialRunState('R1', SID), base())
    s = reduce(s, input(1, 'a'))
    s = reduce(s, compiled(2, ['T1', 'T2']))
    s = reduce(s, approved(3, ['T1']))
    expect(approvedObligations(s).map((t) => t.task_id)).toEqual(['T1'])
    expect(s.tasks.find((t) => t.task_id === 'T2')!.approval_status).toBe('proposed')
  })
})
