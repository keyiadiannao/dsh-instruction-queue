/**
 * Live-intake delta tests: inputs added while executing that are not yet
 * consumed by any task become the Pending Delta at the reconciliation barrier.
 */

import { describe, expect, it } from 'vitest'
import type { IQEvent } from '../src/iq/events.ts'
import { initialRunState, reduce } from '../src/iq/reducer.ts'
import { pendingDeltaInputs, sanitizeModelEvidence } from '../src/index.ts'
import type { RunState } from '../src/iq/types.ts'

const SID = 'sess-test'

function base(): IQEvent {
  return { kind: 'IQ_ENABLED', seq: 0, run_id: 'R1', ts: 't', session_id: SID }
}

function input(seq: number, id: string): IQEvent {
  return { kind: 'INPUT_BUFFERED', seq, run_id: 'R1', ts: 't', input_id: id, content: `c${seq}`, queue_sequence: seq, last_visible_event_id: null, session_id: SID }
}

describe('pendingDeltaInputs (live intake)', () => {
  it('returns ALL inputs when no task has consumed any', () => {
    let s = reduce(initialRunState('R1', SID), base())
    s = reduce(s, input(1, 'IN1'))
    s = reduce(s, input(2, 'IN2'))
    const pending = pendingDeltaInputs(s)
    expect(pending.map((i) => i.input_id)).toEqual(['IN1', 'IN2'])
  })

  it('excludes inputs already referenced by an approved task', () => {
    let s = reduce(initialRunState('R1', SID), base())
    s = reduce(s, input(1, 'IN1'))
    s = reduce(s, input(2, 'IN2')) // live intake during execution — not yet consumed
    // Add an approved task whose source is IN1.
    s = reduce(s, {
      kind: 'QUEUE_COMPILED', seq: 5, run_id: 'R1', ts: 't',
      tasks: [{
        task_id: 'T1', source_input_ids: ['IN1'], task: 'x', intent_type: 'modify', targets: [],
        acceptance_criteria: [{ criterion_id: 'AC1', text: 'c' }], side_effect_class: 'write',
        hard_dependencies: [], soft_affinities: [],
      }],
      conflicts: [], dependency_cycles: [], ambiguities: [],
    })
    s = reduce(s, { kind: 'QUEUE_APPROVED', seq: 6, run_id: 'R1', ts: 't', approved_task_ids: ['T1'], supersessions: [], rejected_task_ids: [], approved_revision: 1 })
    const pending = pendingDeltaInputs(s)
    // IN1 consumed by T1; IN2 (added during execution) is the pending delta.
    expect(pending.map((i) => i.input_id)).toEqual(['IN2'])
  })

  it('returns empty when every input is consumed', () => {
    let s = reduce(initialRunState('R1', SID), base())
    s = reduce(s, input(1, 'IN1'))
    s = reduce(s, {
      kind: 'QUEUE_COMPILED', seq: 5, run_id: 'R1', ts: 't',
      tasks: [{
        task_id: 'T1', source_input_ids: ['IN1'], task: 'x', intent_type: 'modify', targets: [],
        acceptance_criteria: [{ criterion_id: 'AC1', text: 'c' }], side_effect_class: 'read',
        hard_dependencies: [], soft_affinities: [],
      }],
      conflicts: [], dependency_cycles: [], ambiguities: [],
    })
    expect(pendingDeltaInputs(s)).toEqual([])
  })
})

describe('sanitizeModelEvidence (P0#2 evidence authority firewall)', () => {
  it('downgrades every model authority claim to agent_conclusion/agent', () => {
    const out = sanitizeModelEvidence([
      { id: 'E1', type: 'file_change', path: 'x.ts', authority: 'tool' },
      { id: 'E2', type: 'command_result', command: 'npm test', exit_code: 0, authority: 'tool' },
      { id: 'E3', type: 'agent_conclusion', authority: 'agent', note: 'i verified it' },
    ])
    expect(out).toHaveLength(3)
    for (const e of out) {
      expect(e.type).toBe('agent_conclusion')
      expect(e.authority).toBe('agent')
    }
    // model can never mint tool/workspace authority (every entry is 'agent')
    expect(out.every((e) => e.authority === 'agent')).toBe(true)
    // note preserved for the agent-conclusion
    expect(out.find((e) => e.id === 'E3')?.note).toBe('i verified it')
  })

  it('assigns an id when the model omitted none', () => {
    const out = sanitizeModelEvidence([{ id: '', type: 'file_change', authority: 'workspace' }])
    expect(out[0]!.id).toMatch(/^model-ev-\d+$/)
    expect(out[0]!.authority).toBe('agent')
  })
})
