/**
 * dsh-instruction-queue — reconciler (semantic judgment only).
 *
 * After one segment executes, reconcile the plan:
 *  1. Judge each approved acceptance criterion against the captured evidence
 *     (Invariant #5: covered only when ALL approved ACs have evidence; an
 *     agent-conclusion is never sufficient alone).
 *  2. Extract residual work (parts of the ORIGINAL approved obligation still
 *     unmet — auto-enters the graph) vs scope-expanding work (new targets /
 *     optimizations / refactors NOT in the approved criteria — must be
 *     PROPOSED and approved before it enters the executable queue,
 *     Invariant #4).
 *
 * @module dsh-instruction-queue/reconcile
 */

import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { resolveTarget } from './compile.ts'
import type { Config } from './index.ts'
import type { EvidenceEvent } from './iq/events.ts'
import { validateReconcileOutput } from './iq/schema.ts'
import type { Attempt, RunState, Task } from './iq/types.ts'

/** Evidence as captured in the ATTEMPT_RESULT_CAPTURED event (type is string). */
export type ReconcileEvidence = EvidenceEvent

export interface ReconcileInput {
  summary: string | null
  evidence: ReconcileEvidence[]
  criteria?: { criterion_id: string; satisfied: boolean; evidence_refs: string[] }[]
}

export interface ReconcileProposal {
  task: {
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
  parent_task_id: string | null
  derived_from_criteria: string[]
  origin: 'residual' | 'proposed_expansion'
}

export interface ReconcileOutput {
  attempt_status: 'finished' | 'failed' | 'uncertain'
  task_execution_status: 'finished' | 'failed' | 'uncertain'
  criteria_met: { criterion_id: string; evidence_refs: string[] }[]
  resolution_status: 'satisfied' | 'partial' | 'covered' | 'skipped' | 'open'
  note: string | null
  proposals: ReconcileProposal[]
  audit_issues: string[]
}

const RECONCILE_INSTRUCTION = `You are the instruction-queue reconciler.

A segment of the approved plan just executed. Judge its result against the
task's APPROVED acceptance criteria — similarity to the task text is NOT
coverage. Decide:

1. For EACH approved acceptance criterion: is it satisfied by the supplied
   evidence? An agent conclusion alone is never enough; a criterion needs a
   tool/workspace/external observation (file change, command result, workspace
   state). Mark satisfied only when the evidence refs actually support it.
2. Residual vs expansion:
   - RESIDUAL = work that remains from the ORIGINAL approved obligation
     (a criterion not yet met, or an explicitly stated part that is undone).
     Residual auto-enters the queue.
   - EXPANSION = new targets, optimizations, refactors, or scope NOT present
     in the approved criteria. Expansion must be proposed (origin
     "proposed_expansion") and approved separately — NEVER auto-enter it.
   Only propose work you have concrete evidence/reason to believe is needed;
   do not invent busywork.
3. Resolution status:
   - "satisfied": every approved criterion has non-agent evidence.
   - "partial": some criteria met, others not (and remaining work is residual).
   - "covered": all criteria met by evidence from this or earlier attempts.
   - "skipped": the user explicitly chose to skip this obligation.
   - "open": nothing conclusive.
4. attempt_status:
   - "finished" when execution clearly completed (even if criteria unmet).
   - "failed" when execution clearly failed.
   - "uncertain" when the outcome cannot be proven (crash window).

Output ONLY strict JSON matching this exact shape (no markdown):
{
  "attempt_status": "finished|failed|uncertain",
  "task_execution_status": "finished|failed|uncertain",
  "criteria_met": [{ "criterion_id": "AC1", "evidence_refs": ["E1"] }],
  "resolution_status": "satisfied|partial|covered|skipped|open",
  "note": "short rationale or null",
  "proposals": [{
    "task": {
      "task_id": "T1.R1",
      "source_input_ids": [],
      "task": "residual/expansion description",
      "intent_type": "inspect|modify|decide|verify|explain",
      "targets": [],
      "acceptance_criteria": [{ "criterion_id": "AC1", "text": "..." }],
      "side_effect_class": "read|write|external|irreversible",
      "hard_dependencies": [],
      "soft_affinities": []
    },
    "parent_task_id": "T1",
    "derived_from_criteria": [],
    "origin": "residual|proposed_expansion"
  }],
  "audit_issues": []
}
`

/**
 * Run the reconcile LLM call. Falls back to a deterministic local judgement
 * when the LLM call fails (never throws into the tool).
 */
export async function reconcileResult(
  ctx: any,
  agent: any,
  state: RunState,
  task: Task,
  attempt: Attempt,
  config: Config,
  input: ReconcileInput,
): Promise<ReconcileOutput> {
  try {
    const target = resolveTarget(ctx, agent, config)
    if (target !== undefined) {
      const llm = await reconcileWithLlm(ctx, target, state, task, input)
      if (llm !== null) return llm
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log(`[dsh-instruction-queue] reconcile LLM error: ${e instanceof Error ? e.message : String(e)}`)
  }
  return reconcileDeterministic(task, attempt, input)
}

async function reconcileWithLlm(
  ctx: any,
  target: { provider: string; model: string },
  state: RunState,
  task: Task,
  input: ReconcileInput,
): Promise<ReconcileOutput | null> {
  const criteriaText = task.acceptance_criteria
    .map((c) => `- ${c.criterion_id}: ${c.text}`)
    .join('\n')
  const evText = input.evidence.length
    ? input.evidence.map((e) => `- ${e.id} [${e.authority}/${e.type}] ${e.path ?? e.command ?? ''}${e.note ? ` — ${e.note}` : ''}`).join('\n')
    : '(no evidence captured)'
  const userCriteria = (input.criteria ?? [])
    .map((c) => `- ${c.criterion_id}: ${c.satisfied ? 'satisfied' : 'not satisfied'} refs=[${c.evidence_refs.join(',')}]`)
    .join('\n') || '(none)'
  const prompt = createUserMessage({
    content: [{
      type: 'text',
      text: `${RECONCILE_INSTRUCTION}\n\nTASK: ${task.task_id}\n${task.task}\n\nAPPROVED ACCEPTANCE CRITERIA:\n${criteriaText}\n\nRESULT SUMMARY (advisory):\n${input.summary ?? '(none)'}\n\nEVIDENCE CAPTURED:\n${evText}\n\nEXECUTOR'S OWN CRITERIA JUDGEMENT (advisory, re-verify):\n${userCriteria}`,
    }],
    source: { kind: 'user' },
  })
  const assembler = new BlockAssembler()
  const options = {
    provider: target.provider,
    model: target.model,
    messages: [prompt],
    maxTokens: 2000,
    sessionId: state.session_id,
    purpose: 'compaction' as const,
  }
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  const text = assembler.blocks()
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text?: string }).text ?? '')
    .join('')
    .trim()
  if (text.length === 0) return null
  const cleaned = text.replace(/^```(?:json)?/m, '').replace(/```$/m, '').trim()
  const parsed = JSON.parse(cleaned) as ReconcileOutput
  // Schema firewall: the LLM does not own state truth. A malformed object is
  // rejected → the caller falls back to the deterministic judgement.
  const errors = validateReconcileOutput(parsed, task, input.evidence)
  if (errors.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`[dsh-instruction-queue] reconcile schema rejected:\n  ${errors.join('\n  ')}`)
    return null
  }
  return parsed
}

/**
 * Deterministic fallback: use the executor's own criteria judgement, but
 * enforce the evidence authority rule — a criterion claimed satisfied with
 * only agent-authority evidence is demoted (not counted satisfied).
 */
export function reconcileDeterministic(
  task: Task,
  _attempt: Attempt,
  input: ReconcileInput,
): ReconcileOutput {
  const auditIssues: string[] = []
  const criteria = input.criteria ?? []
  const criteriaMap = new Map(task.acceptance_criteria.map((c) => [c.criterion_id, c]))
  const criteriaMet: { criterion_id: string; evidence_refs: string[] }[] = []
  for (const c of criteria) {
    const ac = criteriaMap.get(c.criterion_id)
    if (ac === undefined) continue
    const refs = (c.evidence_refs ?? []).filter((r) => input.evidence.some((e) => e.id === r))
    const evs = refs.map((r) => input.evidence.find((e) => e.id === r)).filter((e): e is ReconcileEvidence => e !== undefined)
    const onlyAgent = evs.length > 0 && evs.every((e) => e.authority === 'agent')
    if (c.satisfied && refs.length === 0) {
      auditIssues.push(`${ac.criterion_id}: claimed satisfied with no evidence refs — demoted`)
      continue
    }
    if (c.satisfied && onlyAgent) {
      auditIssues.push(`${ac.criterion_id}: claimed satisfied with only agent-authority evidence — demoted (Invariant #6)`)
      continue
    }
    if (c.satisfied) criteriaMet.push({ criterion_id: c.criterion_id, evidence_refs: refs })
  }
  const total = task.acceptance_criteria.length
  const met = criteriaMet.length
  const resolution: ReconcileOutput['resolution_status'] =
    total === 0 ? 'satisfied' : met === total ? 'satisfied' : met > 0 ? 'partial' : 'open'
  const attemptStatus: ReconcileOutput['attempt_status'] = 'finished'
  return {
    attempt_status: attemptStatus,
    task_execution_status: 'finished',
    criteria_met: criteriaMet,
    resolution_status: resolution,
    note: `deterministic reconcile: ${met}/${total} criteria met with valid evidence`,
    proposals: [],
    audit_issues: auditIssues,
  }
}
