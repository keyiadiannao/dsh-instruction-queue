/**
 * Recovery tests: the crash recovery matrix (decideRecovery).
 */

import { describe, expect, it } from 'vitest'
import { decideRecovery } from '../src/iq/recovery.ts'
import type { Attempt, RunState, Task } from '../src/iq/types.ts'

const SID = 'sess-test'

function task(id = 'T1', sideEffect: Task['side_effect_class'] = 'write'): Task {
  return {
    task_id: id, approval_status: 'approved', origin: 'approved', parent_task_id: null,
    derived_from_criteria: [], source_input_ids: ['IN1'], task: 'x', intent_type: 'modify',
    targets: [], execution_status: 'running', resolution_status: 'open', attempts: [],
    acceptance_criteria: [{ criterion_id: 'AC1', text: 'c' }], side_effect_class: sideEffect,
    hard_dependencies: [], soft_affinities: [], evidence: [],
    coverage: { satisfied_by: [], criteria_met: [] }, revision: 1,
    approved_task_revision: 1, approved_acceptance_criteria: [{ criterion_id: 'AC1', text: 'c' }],
  }
}

function state(t: Task): RunState {
  return {
    run_id: 'R1', session_id: SID, phase: 'recovery_required', enabled: true,
    inputs: [], tasks: [t], active_task_id: t.task_id, last_seen_event_id: null,
    conflicts: [], dependency_cycles: [], ambiguities: [], event_count: 5,
    paused_note: null, recovery_note: null, completed_at: null, aborted_at: null,
  }
}

function attempt(status: Attempt['status']): Attempt {
  return {
    attempt_id: 'A1', status, dispatched_at: 't', started_at: status === 'running' ? 't' : null,
    finished_at: null, side_effect_observed: false, result_summary: null, evidence_ids: [],
  }
}

describe('crash recovery matrix', () => {
  it('no attempt → safe to dispatch fresh', () => {
    const d = decideRecovery(state(task()), task(), undefined, {
      write_landed: false, outcome_observed: false, idempotent_read: false,
    })
    expect(d.requires_user).toBe(false)
    expect(d.conclusion).toMatch(/never dispatched/)
  })

  it('dispatched + outcome observed → commit as finished', () => {
    const d = decideRecovery(state(task()), task(), attempt('dispatched'), {
      write_landed: true, outcome_observed: true, idempotent_read: false,
    })
    expect(d.requires_user).toBe(false)
    expect(d.events.some((e) => e.kind === 'ATTEMPT_COMMITTED')).toBe(true)
  })

  it('dispatched + no outcome → uncertain (may or may not have begun)', () => {
    const d = decideRecovery(state(task()), task(), attempt('dispatched'), {
      write_landed: false, outcome_observed: false, idempotent_read: false,
    })
    expect(d.requires_user).toBe(true)
    expect(d.events.some((e) => e.kind === 'RECOVERY_REQUIRED')).toBe(true)
  })

  it('running + outcome observed → commit', () => {
    const d = decideRecovery(state(task()), task(), attempt('running'), {
      write_landed: true, outcome_observed: true, idempotent_read: false,
    })
    expect(d.requires_user).toBe(false)
    expect(d.events.some((e) => e.kind === 'ATTEMPT_COMMITTED')).toBe(true)
  })

  it('running write side-effect + no outcome → NEVER silently retry', () => {
    const d = decideRecovery(state(task('T1', 'write')), task('T1', 'write'), attempt('running'), {
      write_landed: false, outcome_observed: false, idempotent_read: false,
    })
    expect(d.requires_user).toBe(true)
    expect(d.conclusion).toMatch(/no auto retry|forbidden/i)
  })

  it('running read-only + no outcome → safe to re-dispatch (policy decides)', () => {
    const d = decideRecovery(state(task('T1', 'read')), task('T1', 'read'), attempt('running'), {
      write_landed: false, outcome_observed: false, idempotent_read: true,
    })
    expect(d.requires_user).toBe(false)
    expect(d.conclusion).toMatch(/read-only/)
  })

  it('finished → nothing to recover', () => {
    const d = decideRecovery(state(task()), task(), attempt('finished'), {
      write_landed: true, outcome_observed: true, idempotent_read: false,
    })
    expect(d.requires_user).toBe(false)
    expect(d.events).toHaveLength(0)
  })

  it('failed → proven outcome, retry permitted', () => {
    const d = decideRecovery(state(task()), task(), attempt('failed'), {
      write_landed: false, outcome_observed: true, idempotent_read: false,
    })
    expect(d.requires_user).toBe(false)
    expect(d.conclusion).toMatch(/retry is permitted/)
  })

  it('uncertain → awaits user decision', () => {
    const d = decideRecovery(state(task()), task(), attempt('uncertain'), {
      write_landed: false, outcome_observed: false, idempotent_read: false,
    })
    expect(d.requires_user).toBe(true)
  })
})
