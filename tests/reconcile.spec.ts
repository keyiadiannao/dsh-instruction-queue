/**
 * Deterministic reconcile tests (no LLM — pure fallback path).
 */

import { describe, expect, it } from 'vitest'
import { reconcileDeterministic } from '../src/reconcile.ts'
import type { Attempt, Task } from '../src/iq/types.ts'

function task(): Task {
  return {
    task_id: 'T1', approval_status: 'approved', origin: 'approved', parent_task_id: null,
    derived_from_criteria: [], source_input_ids: ['IN1'], task: 'fix login test', intent_type: 'modify',
    targets: ['tests/login.spec.ts'], execution_status: 'running', resolution_status: 'open',
    attempts: [], acceptance_criteria: [
      { criterion_id: 'AC1', text: 'login test passes' },
      { criterion_id: 'AC2', text: 'no new flaky warnings' },
    ],
    side_effect_class: 'write', hard_dependencies: [], soft_affinities: [], evidence: [],
    coverage: { satisfied_by: [], criteria_met: [] }, revision: 1,
    approved_task_revision: 1, approved_acceptance_criteria: [
      { criterion_id: 'AC1', text: 'login test passes' },
      { criterion_id: 'AC2', text: 'no new flaky warnings' },
    ],
  }
}

const attempt: Attempt = {
  attempt_id: 'A1', status: 'running', dispatched_at: 't', started_at: 't',
  finished_at: null, side_effect_observed: true, result_summary: 'fixed', evidence_ids: [],
}

describe('deterministic reconcile', () => {
  it('tool evidence satisfies a criterion', () => {
    const out = reconcileDeterministic(task(), attempt, {
      summary: 'fixed the test',
      evidence: [
        { id: 'E1', type: 'command_result', command: 'npm test login', exit_code: 0, observed_at: 't', authority: 'tool' },
      ],
      criteria: [
        { criterion_id: 'AC1', satisfied: true, evidence_refs: ['E1'] },
        { criterion_id: 'AC2', satisfied: false, evidence_refs: [] },
      ],
    })
    expect(out.criteria_met).toEqual([{ criterion_id: 'AC1', evidence_refs: ['E1'] }])
    expect(out.resolution_status).toBe('partial')
    expect(out.attempt_status).toBe('finished')
  })

  it('agent-only evidence is demoted (Invariant #6)', () => {
    const out = reconcileDeterministic(task(), attempt, {
      summary: 'i believe it works',
      evidence: [
        { id: 'E1', type: 'agent_conclusion', observed_at: 't', authority: 'agent' },
      ],
      criteria: [
        { criterion_id: 'AC1', satisfied: true, evidence_refs: ['E1'] },
      ],
    })
    expect(out.criteria_met).toHaveLength(0)
    expect(out.audit_issues.some((s) => /agent-authority/.test(s))).toBe(true)
    expect(out.resolution_status).toBe('open')
  })

  it('claimed satisfied without refs is demoted', () => {
    const out = reconcileDeterministic(task(), attempt, {
      summary: 'done',
      evidence: [],
      criteria: [
        { criterion_id: 'AC1', satisfied: true, evidence_refs: [] },
      ],
    })
    expect(out.criteria_met).toHaveLength(0)
    expect(out.audit_issues.some((s) => /no evidence refs/.test(s))).toBe(true)
  })

  it('all criteria met with evidence → satisfied', () => {
    const out = reconcileDeterministic(task(), attempt, {
      summary: 'both done',
      evidence: [
        { id: 'E1', type: 'command_result', command: 'npm test login', exit_code: 0, observed_at: 't', authority: 'tool' },
        { id: 'E2', type: 'file_change', path: 'tests/login.spec.ts', observed_at: 't', authority: 'tool' },
      ],
      criteria: [
        { criterion_id: 'AC1', satisfied: true, evidence_refs: ['E1'] },
        { criterion_id: 'AC2', satisfied: true, evidence_refs: ['E2'] },
      ],
    })
    expect(out.resolution_status).toBe('satisfied')
  })
})
