/**
 * dsh-instruction-queue — LLM output schema firewall.
 *
 * The system principle: the LLM never owns state truth. Between the LLM's
 * JSON output and the ledger there MUST be a strict validation gate, so a
 * malformed / hallucinated object can never indirectly pollute the fact
 * layer. Both compile.ts and reconcile.ts run their parsed output through
 * these validators and treat any failure as "LLM call failed" (fall back to
 * deterministic behavior / zero-loss).
 *
 * @module dsh-instruction-queue/iq/schema
 */

import type { CompileOutput } from '../compile.ts'
import type { ReconcileOutput } from '../reconcile.ts'
import type { RunState, Task } from './types.ts'

/** Collect every problem found; empty array = valid. */
export type SchemaErrors = string[]

const INTENT_TYPES = new Set(['inspect', 'modify', 'decide', 'verify', 'explain'])
const SIDE_EFFECT_CLASSES = new Set(['read', 'write', 'external', 'irreversible'])
const RESOLUTION_STATUSES = new Set(['satisfied', 'partial', 'covered', 'skipped', 'open'])
const ATTEMPT_STATUSES = new Set(['finished', 'failed', 'uncertain'])
const ORIGINS = new Set(['residual', 'proposed_expansion'])

/**
 * Validate a compile output against the run state.
 * Verifies: task id uniqueness; source input ids exist; dependency ids exist;
 * AC non-empty and id-unique; enums legal; conflict/ambiguity input refs exist.
 */
export function validateCompileOutput(out: CompileOutput, state: RunState): SchemaErrors {
  const errors: SchemaErrors = []
  if (!Array.isArray(out.tasks) || out.tasks.length === 0) {
    return ['compile: tasks must be a non-empty array']
  }
  const inputIds = new Set(state.inputs.map((i) => i.input_id))
  const taskIds = new Set<string>()

  for (const t of out.tasks) {
    if (typeof t.task_id !== 'string' || t.task_id.length === 0) {
      errors.push('compile: task missing task_id'); continue
    }
    if (taskIds.has(t.task_id)) errors.push(`compile: duplicate task_id "${t.task_id}"`)
    taskIds.add(t.task_id)

    if (!Array.isArray(t.source_input_ids)) {
      errors.push(`compile: task ${t.task_id} source_input_ids must be an array`)
    } else if (t.source_input_ids.length === 0) {
      errors.push(`compile: task ${t.task_id} has no source_input_ids`)
    } else {
      for (const sid of t.source_input_ids) {
        if (!inputIds.has(sid)) errors.push(`compile: task ${t.task_id} references unknown input "${sid}"`)
      }
    }

    if (!INTENT_TYPES.has(t.intent_type)) errors.push(`compile: task ${t.task_id} illegal intent_type "${String(t.intent_type)}"`)
    if (!SIDE_EFFECT_CLASSES.has(t.side_effect_class)) errors.push(`compile: task ${t.task_id} illegal side_effect_class "${String(t.side_effect_class)}"`)
    if (!Array.isArray(t.targets)) errors.push(`compile: task ${t.task_id} targets must be an array`)
    if (typeof t.task !== 'string' || t.task.trim().length === 0) {
      errors.push(`compile: task ${t.task_id} has empty task text`)
    }

    if (!Array.isArray(t.acceptance_criteria) || t.acceptance_criteria.length === 0) {
      errors.push(`compile: task ${t.task_id} must have acceptance criteria`)
    } else {
      const acIds = new Set<string>()
      for (const ac of t.acceptance_criteria) {
        if (typeof ac?.criterion_id !== 'string' || ac.criterion_id.length === 0) {
          errors.push(`compile: task ${t.task_id} criterion missing id`); continue
        }
        if (acIds.has(ac.criterion_id)) errors.push(`compile: task ${t.task_id} duplicate criterion_id "${ac.criterion_id}"`)
        acIds.add(ac.criterion_id)
        if (typeof ac.text !== 'string' || ac.text.trim().length === 0) {
          errors.push(`compile: task ${t.task_id} criterion ${ac.criterion_id} has empty text`)
        }
      }
    }

    if (Array.isArray(t.hard_dependencies)) {
      for (const d of t.hard_dependencies) {
        // Dependencies may reference sibling tasks or ALREADY-APPROVED tasks
        // from a previous compile (kept in the slate).
        const known = taskIds.has(d) || state.tasks.some((x) => x.task_id === d && x.approval_status === 'approved')
        if (!known) errors.push(`compile: task ${t.task_id} hard_dependency "${d}" does not exist`)
      }
    } else {
      errors.push(`compile: task ${t.task_id} hard_dependencies must be an array`)
    }
    if (!Array.isArray(t.soft_affinities)) {
      errors.push(`compile: task ${t.task_id} soft_affinities must be an array`)
    }
  }

  if (Array.isArray(out.conflicts)) {
    for (const c of out.conflicts) {
      if (c.kind !== 'supersedes' && c.kind !== 'contradicts') errors.push(`compile: conflict kind "${String(c.kind)}" illegal`)
      if (!inputIds.has(c.from_input_id)) errors.push(`compile: conflict references unknown from_input "${c.from_input_id}"`)
      if (!inputIds.has(c.to_input_id)) errors.push(`compile: conflict references unknown to_input "${c.to_input_id}"`)
    }
  } else {
    errors.push('compile: conflicts must be an array')
  }

  if (Array.isArray(out.dependency_cycles)) {
    for (const cycle of out.dependency_cycles) {
      if (!Array.isArray(cycle) || cycle.length === 0) errors.push('compile: empty dependency cycle')
      else for (const id of cycle) if (!taskIds.has(id)) errors.push(`compile: cycle references unknown task "${id}"`)
    }
  } else {
    errors.push('compile: dependency_cycles must be an array')
  }

  if (!Array.isArray(out.ambiguities)) {
    errors.push('compile: ambiguities must be an array')
  } else {
    for (const a of out.ambiguities) {
      if (!Array.isArray(a?.input_ids)) errors.push('compile: ambiguity missing input_ids')
      else for (const id of a.input_ids) if (!inputIds.has(id)) errors.push(`compile: ambiguity references unknown input "${id}"`)
    }
  }

  return errors
}

/**
 * Validate a reconcile output against the task and the captured evidence.
 * Verifies: criterion ids belong to the task's approved ACs; evidence refs
 * exist; enums legal; residual lineage (derived_from_criteria ⊆ parent's
 * approved ACs); expansion cannot masquerade as residual.
 */
export function validateReconcileOutput(
  out: ReconcileOutput,
  task: Task,
  capturedEvidence: { id: string }[],
): SchemaErrors {
  const errors: SchemaErrors = []
  const acIds = new Set(task.approved_acceptance_criteria.length > 0
    ? task.approved_acceptance_criteria.map((a) => a.criterion_id)
    : task.acceptance_criteria.map((a) => a.criterion_id))
  const evIds = new Set(capturedEvidence.map((e) => e.id))

  if (!ATTEMPT_STATUSES.has(out.attempt_status)) errors.push(`reconcile: illegal attempt_status "${String(out.attempt_status)}"`)
  if (!ATTEMPT_STATUSES.has(out.task_execution_status)) errors.push(`reconcile: illegal task_execution_status "${String(out.task_execution_status)}"`)
  if (!RESOLUTION_STATUSES.has(out.resolution_status)) errors.push(`reconcile: illegal resolution_status "${String(out.resolution_status)}"`)

  if (!Array.isArray(out.criteria_met)) {
    errors.push('reconcile: criteria_met must be an array')
  } else {
    const seen = new Set<string>()
    for (const c of out.criteria_met) {
      if (typeof c?.criterion_id !== 'string') { errors.push('reconcile: criterion_met missing criterion_id'); continue }
      if (seen.has(c.criterion_id)) errors.push(`reconcile: duplicate criterion_met "${c.criterion_id}"`)
      seen.add(c.criterion_id)
      if (!acIds.has(c.criterion_id)) {
        errors.push(`reconcile: criterion "${c.criterion_id}" not in task's approved ACs`)
      }
      if (!Array.isArray(c.evidence_refs)) {
        errors.push(`reconcile: criterion ${c.criterion_id} evidence_refs must be an array`)
      } else {
        for (const r of c.evidence_refs) {
          if (!evIds.has(r)) errors.push(`reconcile: criterion ${c.criterion_id} references unknown evidence "${r}"`)
        }
      }
    }
  }

  if (!Array.isArray(out.proposals)) {
    errors.push('reconcile: proposals must be an array')
  } else {
    const proposalIds = new Set<string>()
    for (const p of out.proposals) {
      if (!ORIGINS.has(p.origin)) {
        errors.push(`reconcile: proposal origin "${String(p.origin)}" illegal`); continue
      }
      if (typeof p.task?.task_id !== 'string' || p.task.task_id.length === 0) {
        errors.push('reconcile: proposal missing task.task_id'); continue
      }
      if (proposalIds.has(p.task.task_id)) errors.push(`reconcile: duplicate proposal task_id "${p.task.task_id}"`)
      proposalIds.add(p.task.task_id)

      if (p.origin === 'residual') {
        // Residual inherits authority from the parent approved obligation.
        if (p.parent_task_id !== task.task_id) {
          errors.push(`reconcile: residual ${p.task.task_id} parent_task_id must be the executing task ${task.task_id}`)
        }
        if (!Array.isArray(p.derived_from_criteria) || p.derived_from_criteria.length === 0) {
          errors.push(`reconcile: residual ${p.task.task_id} must derive from ≥1 parent AC`)
        } else {
          for (const d of p.derived_from_criteria) {
            if (!acIds.has(d)) errors.push(`reconcile: residual ${p.task.task_id} derives from non-parent-AC "${d}"`)
          }
        }
      } else {
        // proposed_expansion: must NOT claim parent lineage.
        if (Array.isArray(p.derived_from_criteria) && p.derived_from_criteria.length > 0) {
          errors.push(`reconcile: expansion ${p.task.task_id} must not claim derived_from_criteria (masquerade)`)
        }
      }

      if (!INTENT_TYPES.has(p.task.intent_type)) errors.push(`reconcile: proposal ${p.task.task_id} illegal intent_type`)
      if (!SIDE_EFFECT_CLASSES.has(p.task.side_effect_class)) errors.push(`reconcile: proposal ${p.task.task_id} illegal side_effect_class`)
      if (!Array.isArray(p.task.acceptance_criteria) || p.task.acceptance_criteria.length === 0) {
        errors.push(`reconcile: proposal ${p.task.task_id} must have acceptance criteria`)
      }
    }
  }

  if (!Array.isArray(out.audit_issues)) errors.push('reconcile: audit_issues must be an array')

  return errors
}
