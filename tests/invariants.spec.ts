/**
 * Invariant tests: the constitution holds on every replay.
 */

import { describe, expect, it } from 'vitest'
import { InvariantViolation, assertInvariants, auditCoverage } from '../src/iq/invariants.ts'
import type { RunState } from '../src/iq/types.ts'

const SID = 'sess-test'

function state(): RunState {
  return {
    run_id: 'R1',
    session_id: SID,
    phase: 'ready',
    enabled: true,
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

describe('invariant #1 — raw inputs immutable & monotonic', () => {
  it('rejects non-monotonic input sequence', () => {
    const s = state()
    s.inputs = [
      { input_id: 'IN1', content: 'a', queued_at: 't', queue_sequence: 2, last_visible_event_id: null, session_id: SID },
      { input_id: 'IN2', content: 'b', queued_at: 't', queue_sequence: 1, last_visible_event_id: null, session_id: SID },
    ]
    expect(() => assertInvariants(s)).toThrow(InvariantViolation)
    expect(() => assertInvariants(s)).toThrow(/invariant #1/)
  })
})

describe('invariant #2 — approved semantics locked', () => {
  it('rejects approved task without approved_task_revision', () => {
    const s = state()
    s.tasks = [{
      task_id: 'T1', approval_status: 'approved', origin: 'approved', parent_task_id: null,
      derived_from_criteria: [], source_input_ids: ['IN1'], task: 'x', intent_type: 'modify',
      targets: [], execution_status: 'pending', resolution_status: 'open', attempts: [],
      acceptance_criteria: [{ criterion_id: 'AC1', text: 'c' }], side_effect_class: 'read',
      hard_dependencies: [], soft_affinities: [], evidence: [],
      coverage: { satisfied_by: [], criteria_met: [] }, revision: 1,
      approved_task_revision: null, approved_acceptance_criteria: [],
    }]
    expect(() => assertInvariants(s)).toThrow(/invariant #2/)
  })
})

describe('invariant #4 — no scope expansion without approval', () => {
  it('rejects a running proposed_expansion task', () => {
    const s = state()
    s.tasks = [{
      task_id: 'T1', approval_status: 'proposed', origin: 'proposed_expansion', parent_task_id: 'T0',
      derived_from_criteria: [], source_input_ids: [], task: 'x', intent_type: 'modify',
      targets: [], execution_status: 'running', resolution_status: 'open', attempts: [],
      acceptance_criteria: [{ criterion_id: 'AC1', text: 'c' }], side_effect_class: 'write',
      hard_dependencies: [], soft_affinities: [], evidence: [],
      coverage: { satisfied_by: [], criteria_met: [] }, revision: 1,
      approved_task_revision: null, approved_acceptance_criteria: [],
    }]
    s.active_task_id = 'T1'
    expect(() => assertInvariants(s)).toThrow(/invariant #4/)
  })
})

describe('invariant #7 — single execution owner', () => {
  it('rejects two running tasks', () => {
    const s = state()
    const mk = (id: string): RunState['tasks'][number] => ({
      task_id: id, approval_status: 'approved', origin: 'approved', parent_task_id: null,
      derived_from_criteria: [], source_input_ids: [], task: 'x', intent_type: 'modify',
      targets: [], execution_status: 'running', resolution_status: 'open', attempts: [],
      acceptance_criteria: [], side_effect_class: 'read', hard_dependencies: [],
      soft_affinities: [], evidence: [], coverage: { satisfied_by: [], criteria_met: [] },
      revision: 1, approved_task_revision: 1, approved_acceptance_criteria: [],
    })
    s.tasks = [mk('T1'), mk('T2')]
    s.active_task_id = 'T1'
    expect(() => assertInvariants(s)).toThrow(/invariant #7/)
  })
})

describe('invariant #8 — completion needs all resolved', () => {
  it('rejects completed phase with unresolved obligation', () => {
    const s = state()
    s.phase = 'completed'
    s.tasks = [{
      task_id: 'T1', approval_status: 'approved', origin: 'approved', parent_task_id: null,
      derived_from_criteria: [], source_input_ids: [], task: 'x', intent_type: 'modify',
      targets: [], execution_status: 'finished', resolution_status: 'open', attempts: [],
      acceptance_criteria: [], side_effect_class: 'read', hard_dependencies: [],
      soft_affinities: [], evidence: [], coverage: { satisfied_by: [], criteria_met: [] },
      revision: 1, approved_task_revision: 1, approved_acceptance_criteria: [],
    }]
    expect(() => assertInvariants(s)).toThrow(/invariant #8/)
  })
})

describe('auditCoverage — Invariant #5/#6 at completion', () => {
  it('agent-only evidence fails the audit; tool evidence passes', () => {
    const s = state()
    s.tasks = [{
      task_id: 'T1', approval_status: 'approved', origin: 'approved', parent_task_id: null,
      derived_from_criteria: [], source_input_ids: [], task: 'x', intent_type: 'modify',
      targets: [], execution_status: 'finished', resolution_status: 'satisfied', attempts: [],
      acceptance_criteria: [{ criterion_id: 'AC1', text: 'c' }], side_effect_class: 'write',
      hard_dependencies: [], soft_affinities: [],
      evidence: [
        { id: 'E1', type: 'agent_conclusion', observed_at: 't', authority: 'agent' },
        { id: 'E2', type: 'file_change', path: 'x.ts', observed_at: 't', authority: 'tool' },
      ],
      coverage: { satisfied_by: ['T1'], criteria_met: [{ criterion_id: 'AC1', evidence_refs: ['E1'] }] },
      revision: 1, approved_task_revision: 1,
      approved_acceptance_criteria: [{ criterion_id: 'AC1', text: 'c' }],
    }]
    const agentOnly = auditCoverage(s)[0]!
    expect(agentOnly.ok).toBe(false)
    expect(agentOnly.reason).toMatch(/only agent/)
    s.tasks[0]!.coverage.criteria_met = [{ criterion_id: 'AC1', evidence_refs: ['E2'] }]
    const toolEv = auditCoverage(s)[0]!
    expect(toolEv.ok).toBe(true)
  })

  it('dangling evidence refs fail the audit (not a false pass)', () => {
    const s = state()
    s.tasks = [{
      task_id: 'T1', approval_status: 'approved', origin: 'approved', parent_task_id: null,
      derived_from_criteria: [], source_input_ids: [], task: 'x', intent_type: 'modify',
      targets: [], execution_status: 'finished', resolution_status: 'satisfied', attempts: [],
      acceptance_criteria: [{ criterion_id: 'AC1', text: 'c' }], side_effect_class: 'write',
      hard_dependencies: [], soft_affinities: [],
      // criteria_met references E9 which does NOT exist in t.evidence (empty).
      evidence: [],
      coverage: { satisfied_by: ['T1'], criteria_met: [{ criterion_id: 'AC1', evidence_refs: ['E9'] }] },
      revision: 1, approved_task_revision: 1,
      approved_acceptance_criteria: [{ criterion_id: 'AC1', text: 'c' }],
    }]
    const res = auditCoverage(s)[0]!
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/dangling|unresolved/)
  })
})
