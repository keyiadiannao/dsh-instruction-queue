/**
 * Schema firewall tests: LLM output validation (P0-3).
 */

import { describe, expect, it } from 'vitest'
import type { CompileOutput } from '../src/compile.ts'
import type { ReconcileOutput } from '../src/reconcile.ts'
import { validateCompileOutput, validateReconcileOutput } from '../src/iq/schema.ts'
import type { RunState, Task } from '../src/iq/types.ts'

const SID = 'sess-test'

function state(): RunState {
  return {
    run_id: 'R1', session_id: SID, phase: 'awaiting_approval', enabled: true,
    inputs: [
      { input_id: 'IN1', content: 'use SQLite', queued_at: 't', queue_sequence: 1, last_visible_event_id: null, session_id: SID },
      { input_id: 'IN2', content: 'switch to Postgres', queued_at: 't', queue_sequence: 2, last_visible_event_id: null, session_id: SID },
    ],
    tasks: [], active_task_id: null, last_seen_event_id: null,
    conflicts: [], dependency_cycles: [], ambiguities: [], event_count: 0,
    paused_note: null, recovery_note: null, completed_at: null, aborted_at: null,
  }
}

function validCompile(): CompileOutput {
  return {
    tasks: [{
      task_id: 'T1',
      source_input_ids: ['IN1'],
      task: 'migrate the store to Postgres',
      intent_type: 'modify',
      targets: ['db'],
      acceptance_criteria: [{ criterion_id: 'AC1', text: 'migration runs clean' }],
      side_effect_class: 'write',
      hard_dependencies: [],
      soft_affinities: [],
    }],
    conflicts: [{ kind: 'supersedes', from_input_id: 'IN1', to_input_id: 'IN2', note: 'later wins' }],
    dependency_cycles: [],
    ambiguities: [],
  }
}

describe('validateCompileOutput', () => {
  it('accepts a valid compile output', () => {
    expect(validateCompileOutput(validCompile(), state())).toEqual([])
  })

  it('rejects duplicate task ids', () => {
    const out = validCompile()
    out.tasks.push({ ...out.tasks[0]!, task_id: 'T1' })
    expect(validateCompileOutput(out, state())).toContain('compile: duplicate task_id "T1"')
  })

  it('rejects unknown source input ids', () => {
    const out = validCompile()
    out.tasks[0]!.source_input_ids = ['IN99']
    expect(validateCompileOutput(out, state())).toContain('compile: task T1 references unknown input "IN99"')
  })

  it('rejects illegal enum values', () => {
    const out = validCompile()
    out.tasks[0]!.intent_type = 'explode' as never
    out.tasks[0]!.side_effect_class = 'maybe' as never
    const errs = validateCompileOutput(out, state())
    expect(errs.some((e) => /illegal intent_type/.test(e))).toBe(true)
    expect(errs.some((e) => /illegal side_effect_class/.test(e))).toBe(true)
  })

  it('rejects missing / duplicate acceptance criteria', () => {
    const out = validCompile()
    out.tasks[0]!.acceptance_criteria = []
    expect(validateCompileOutput(out, state())).toContain('compile: task T1 must have acceptance criteria')
    out.tasks[0]!.acceptance_criteria = [
      { criterion_id: 'AC1', text: 'a' },
      { criterion_id: 'AC1', text: 'b' },
    ]
    expect(validateCompileOutput(out, state())).toContain('compile: task T1 duplicate criterion_id "AC1"')
  })

  it('rejects hard dependencies that do not exist', () => {
    const out = validCompile()
    out.tasks[0]!.hard_dependencies = ['T99']
    expect(validateCompileOutput(out, state())).toContain('compile: task T1 hard_dependency "T99" does not exist')
  })

  it('rejects unknown conflict input refs and illegal kinds', () => {
    const out = validCompile()
    out.conflicts = [{ kind: 'maybe' as never, from_input_id: 'IN1', to_input_id: 'IN99', note: 'x' }]
    const errs = validateCompileOutput(out, state())
    expect(errs.some((e) => /conflict kind/.test(e))).toBe(true)
    expect(errs.some((e) => /unknown to_input/.test(e))).toBe(true)
  })
})

function task(): Task {
  return {
    task_id: 'T1', approval_status: 'approved', origin: 'approved', parent_task_id: null,
    derived_from_criteria: [], source_input_ids: ['IN1'], task: 'migrate store', intent_type: 'modify',
    targets: ['db'], execution_status: 'running', resolution_status: 'open', attempts: [],
    acceptance_criteria: [{ criterion_id: 'AC1', text: 'migration runs clean' }],
    side_effect_class: 'write', hard_dependencies: [], soft_affinities: [], evidence: [],
    coverage: { satisfied_by: [], criteria_met: [] }, revision: 1,
    approved_task_revision: 1,
    approved_acceptance_criteria: [{ criterion_id: 'AC1', text: 'migration runs clean' }],
  }
}

function validReconcile(): ReconcileOutput {
  return {
    attempt_status: 'finished',
    task_execution_status: 'finished',
    criteria_met: [{ criterion_id: 'AC1', evidence_refs: ['E1'] }],
    resolution_status: 'satisfied',
    note: 'done',
    proposals: [],
    audit_issues: [],
  }
}

describe('validateReconcileOutput', () => {
  const evidence = [{ id: 'E1' }, { id: 'E2' }]

  it('accepts a valid reconcile output', () => {
    expect(validateReconcileOutput(validReconcile(), task(), evidence)).toEqual([])
  })

  it('rejects criterion not in approved ACs', () => {
    const out = validReconcile()
    out.criteria_met = [{ criterion_id: 'AC99', evidence_refs: ['E1'] }]
    expect(validateReconcileOutput(out, task(), evidence)).toContain('reconcile: criterion "AC99" not in task\'s approved ACs')
  })

  it('rejects evidence refs that were not captured', () => {
    const out = validReconcile()
    out.criteria_met = [{ criterion_id: 'AC1', evidence_refs: ['E99'] }]
    expect(validateReconcileOutput(out, task(), evidence)).toContain('reconcile: criterion AC1 references unknown evidence "E99"')
  })

  it('rejects illegal resolution status', () => {
    const out = validReconcile()
    out.resolution_status = 'done' as never
    expect(validateReconcileOutput(out, task(), evidence)).toContain('reconcile: illegal resolution_status "done"')
  })

  it('residual must derive from parent approved ACs', () => {
    const out = validReconcile()
    out.proposals = [{
      task: {
        task_id: 'T1.R1', source_input_ids: [], task: 'finish docs', intent_type: 'modify',
        targets: [], acceptance_criteria: [{ criterion_id: 'AC1', text: 'docs done' }],
        side_effect_class: 'write', hard_dependencies: [], soft_affinities: [],
      },
      parent_task_id: 'T1',
      derived_from_criteria: ['AC99'], // NOT a parent AC
      origin: 'residual',
    }]
    expect(validateReconcileOutput(out, task(), evidence)).toContain('reconcile: residual T1.R1 derives from non-parent-AC "AC99"')
  })

  it('expansion cannot masquerade as residual (must not claim derived ACs)', () => {
    const out = validReconcile()
    out.proposals = [{
      task: {
        task_id: 'T1.X1', source_input_ids: [], task: 'refactor ast', intent_type: 'modify',
        targets: [], acceptance_criteria: [{ criterion_id: 'AC1', text: 'refactor done' }],
        side_effect_class: 'write', hard_dependencies: [], soft_affinities: [],
      },
      parent_task_id: 'T1',
      derived_from_criteria: ['AC1'], // expansion claiming parentage = masquerade
      origin: 'proposed_expansion',
    }]
    expect(validateReconcileOutput(out, task(), evidence)).toContain('reconcile: expansion T1.X1 must not claim derived_from_criteria (masquerade)')
  })
})
