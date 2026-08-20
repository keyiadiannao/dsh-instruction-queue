/**
 * dsh-instruction-queue — host plugin.
 *
 * The persistent instruction queue: collect the user's multi-segment
 * instructions into a collaborative plan, compile them into approved
 * obligations, execute them segment-by-segment through the main agent
 * session, and reconcile the plan after each segment against user intent,
 * agent discoveries, and workspace evidence.
 *
 * V1 scope (competitive-validation MVP — three differentiators only):
 *   1. compile-before-execute   — collected inputs buffer; nothing runs until
 *      the compiler produces a queue and the user approves it.
 *   2. approval-preserves-intent — approval locks the task semantics and its
 *      acceptance criteria (approved_task_revision); later semantic change
 *      must go through a NEW proposal, never a silent rewrite.
 *   3. reconcile-after-execute  — after each segment the plan is reconciled
 *      against the captured result: residual work may auto-enter the graph,
 *      scope-expanding work must be proposed and approved (Invariants #2/#4).
 *
 * Architecture: event-sourced obligation orchestrator. The append-only
 * ledger (ndjson per run) is the single source of truth; the pure reducer
 * projects it to RunState (Invariant #9). The LLM only performs semantic
 * judgment inside compile/reconcile — it never owns state truth.
 *
 * @module dsh-instruction-queue
 */

import z from '@deepseek-ai/schemastery'
import { join } from 'node:path'
import type { IQEvent } from './iq/events.ts'
import { appendEvents, assignSeqs, loadLedger } from './iq/ledger.ts'
import { approvedObligations, nextDispatchable, reduceAll } from './iq/reducer.ts'
import type { RunState, Task } from './iq/types.ts'
import type { ReconcileEvidence } from './reconcile.ts'

export const name = 'dsh-instruction-queue'

export const inject = ['tools']

/** Plugin configuration. */
export interface Config {
  /** Root directory holding one `<session>.ndjson` ledger per run. */
  dataDir: string
  /** Provider/model for compile + reconcile semantic calls (empty = session default). */
  llmProvider: string
  llmModel: string
  /** Allow partial approval of a compiled queue (true) or force whole-queue approve. */
  allowPartialApproval: boolean
  /** Max tasks in one compiled queue before the compiler warns. */
  maxCompiledTasks: number
}

/** Schemastery schema; cordis validates and provides it as apply(ctx, config). */
export const Config: z<Config> = z.object({
  dataDir: z.string().default('C:/Users/26433/.dsh/storages/instruction-queue'),
  llmProvider: z.string().default(''),
  llmModel: z.string().default(''),
  allowPartialApproval: z.boolean().default(true),
  maxCompiledTasks: z.number().min(1).max(50).default(12),
})

/** A registered tool's execute context (subset we rely on). */
interface ExecCtx {
  signal?: AbortSignal
  agent?: {
    session?: {
      id?: unknown
      requestHeader?: () => { config?: { provider?: string; model?: string } }
    }
  }
}

export function apply(ctx: any, config: Config): void {
  // Per-session run state cache: { sessionId → { events, state } }.
  // This is a cache ONLY; the ledger file is authoritative (Invariant #9).
  const runs = new Map<string, { events: IQEvent[]; state: RunState }>()

  const ledgerOf = (sessionId: string) => join(config.dataDir, `${sessionId}.ndjson`)
  const sessionOf = (exec: ExecCtx): string => {
    const id = exec.agent?.session?.id
    return id === undefined || id === null ? '' : String(id)
  }

  /** Load (or re-load) a session's run from its ledger file. */
  const loadRun = (sessionId: string): { events: IQEvent[]; state: RunState } | null => {
    if (sessionId === '') return null
    const cached = runs.get(sessionId)
    if (cached !== undefined) return cached
    const events = loadLedger(ledgerOf(sessionId))
    if (events.length === 0) return null
    const state = reduceAll(events)
    const entry = { events, state }
    runs.set(sessionId, entry)
    return entry
  }

  /** Append events to the ledger + cache; returns the new run (events + state). */
  const commitEvents = (sessionId: string, events: IQEvent[], added: IQEvent[]): { events: IQEvent[]; state: RunState } => {
    if (added.length === 0) return { events, state: reduceAll(events) }
    const seq = events.length
    const stamped = assignSeqs(added, seq) as IQEvent[]
    appendEvents(ledgerOf(sessionId), stamped)
    const all = [...events, ...stamped]
    const state = reduceAll(all)
    const entry = { events: all, state }
    runs.set(sessionId, entry)
    return entry
  }

  const nowIso = () => new Date().toISOString()

  // ── iq_status ────────────────────────────────────────────────────────────
  ctx.tools.register(
    {
      name: 'iq_status',
      description:
        'Instruction Queue: show the current run state (phase, buffered inputs, '
        + 'approved obligations, resolutions, next dispatchable task). Read-only. '
        + 'Use when the user asks "what is queued", "status", "进度", or before deciding '
        + 'whether to compile / approve / execute.',
      parameters: { type: 'object', properties: {}, required: [] },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            active: { type: 'boolean' },
            phase: { type: 'string' },
            input_count: { type: 'number' },
            approved_count: { type: 'number' },
            resolved_count: { type: 'number' },
            next_task_id: { type: 'string' },
            recovery_note: { type: 'string' },
          },
          required: ['active', 'phase', 'input_count', 'approved_count', 'resolved_count'],
        },
        render: (_args: unknown, value: { active: boolean; phase: string; input_count: number; approved_count: number; resolved_count: number; next_task_id: string | null; recovery_note: string | null }) => {
          if (!value.active) {
            return [{ type: 'text', text: 'Instruction Queue: no active run. Enable with iq_enable.' }]
          }
          return [{
            type: 'text',
            text: `Instruction Queue — phase: ${value.phase}\n`
              + `buffered inputs: ${value.input_count} | approved obligations: ${value.approved_count} | resolved: ${value.resolved_count}\n`
              + `next dispatchable: ${value.next_task_id ?? 'none'}${value.recovery_note ? `\n⚠ ${value.recovery_note}` : ''}`,
          }]
        },
      },
      async execute(_args: Record<string, never>, exec: ExecCtx) {
        const sessionId = sessionOf(exec)
        const run = loadRun(sessionId)
        if (run === null) {
          return { active: false, phase: 'idle', input_count: 0, approved_count: 0, resolved_count: 0, next_task_id: null, recovery_note: null }
        }
        const approved = approvedObligations(run.state)
        const resolved = approved.filter((t) => ['satisfied', 'covered', 'skipped'].includes(t.resolution_status)).length
        const next = nextDispatchable(run.state)
        return {
          active: true,
          phase: run.state.phase,
          input_count: run.state.inputs.length,
          approved_count: approved.length,
          resolved_count: resolved,
          next_task_id: next?.task_id ?? null,
          recovery_note: run.state.recovery_note,
        }
      },
    },
    'dsh-instruction-queue: iq_status',
  )

  // ── iq_enable ────────────────────────────────────────────────────────────
  ctx.tools.register(
    {
      name: 'iq_enable',
      description:
        'Instruction Queue: start a queue run for this session. From now on the user may '
        + 'queue multi-segment instructions via iq_collect; nothing executes until the queue '
        + 'is compiled (iq_compile) and approved (iq_approve).',
      parameters: { type: 'object', properties: {}, required: [] },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            phase: { type: 'string' },
            message: { type: 'string' },
          },
          required: ['ok', 'phase', 'message'],
        },
        render: (_args: unknown, v: { ok: boolean; phase: string; message: string }) =>
          [{ type: 'text', text: v.message }],
      },
      async execute(_args: Record<string, never>, exec: ExecCtx) {
        const sessionId = sessionOf(exec)
        if (sessionId === '') {
          return { ok: false, phase: 'idle', message: 'iq_enable requires an owning agent session.' }
        }
        const existing = loadRun(sessionId)
        if (existing !== null && existing.state.enabled) {
          return { ok: true, phase: existing.state.phase, message: `Instruction Queue already active (phase: ${existing.state.phase}).` }
        }
        const run = existing ?? { events: [] as IQEvent[], state: { run_id: sessionId, session_id: sessionId, phase: 'idle' as const, enabled: false, inputs: [], tasks: [], active_task_id: null, last_seen_event_id: null, conflicts: [], dependency_cycles: [], ambiguities: [], event_count: 0, paused_note: null, recovery_note: null, completed_at: null, aborted_at: null } }
        const evt: IQEvent = {
          kind: 'IQ_ENABLED', seq: -1, run_id: sessionId, ts: nowIso(), session_id: sessionId,
        }
        const nextRun = commitEvents(sessionId, run.events, [evt])
        return { ok: true, phase: nextRun.state.phase, message: `Instruction Queue enabled — collecting (phase: ${nextRun.state.phase}). Queue instructions with iq_collect.` }
      },
    },
    'dsh-instruction-queue: iq_enable',
  )

  // ── iq_collect ───────────────────────────────────────────────────────────
  ctx.tools.register(
    {
      name: 'iq_collect',
      description:
        'Instruction Queue: buffer user instruction segments into the queue WITHOUT executing '
        + 'them. Each input is recorded verbatim (immutable) with its queue position. Use when '
        + 'the user is giving a multi-part instruction, corrections, or additions while the '
        + 'queue is collecting. Nothing runs until iq_compile + iq_approve.',
      parameters: {
        type: 'object',
        properties: {
          inputs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                content: { type: 'string', description: 'One instruction segment, verbatim from the user.' },
              },
              required: ['content'],
            },
            description: 'One or more instruction segments to buffer.',
          },
        },
        required: ['inputs'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            buffered: { type: 'number' },
            total_inputs: { type: 'number' },
            phase: { type: 'string' },
            message: { type: 'string' },
          },
          required: ['ok', 'buffered', 'total_inputs', 'phase', 'message'],
        },
        render: (_args: unknown, v: { ok: boolean; buffered: number; total_inputs: number; phase: string; message: string }) =>
          [{ type: 'text', text: v.message }],
      },
      async execute(args: { inputs: { content: string }[] }, exec: ExecCtx) {
        const sessionId = sessionOf(exec)
        if (sessionId === '') return { ok: false, buffered: 0, total_inputs: 0, phase: 'idle', message: 'iq_collect requires an owning agent session.' }
        const run = loadRun(sessionId)
        const base = run ?? { events: [] as IQEvent[], state: { run_id: sessionId, session_id: sessionId, phase: 'idle' as const, enabled: false, inputs: [], tasks: [], active_task_id: null, last_seen_event_id: null, conflicts: [], dependency_cycles: [], ambiguities: [], event_count: 0, paused_note: null, recovery_note: null, completed_at: null, aborted_at: null } }
        const list = Array.isArray(args.inputs) ? args.inputs : []
        const clean = list
          .map((i) => (typeof i?.content === 'string' ? i.content.trim() : ''))
          .filter((c) => c.length > 0)
        if (clean.length === 0) {
          return { ok: false, buffered: 0, total_inputs: base.state.inputs.length, phase: base.state.phase, message: 'iq_collect: no non-empty input content provided.' }
        }
        const startSeq = base.state.inputs.length
        const ts = nowIso()
        const evts: IQEvent[] = clean.map((content, i) => ({
          kind: 'INPUT_BUFFERED' as const,
          seq: -1,
          run_id: sessionId,
          ts,
          input_id: `IN${startSeq + i + 1}`,
          content,
          queue_sequence: startSeq + i + 1,
          last_visible_event_id: null,
          session_id: sessionId,
        }))
        const nextRun = commitEvents(sessionId, base.events, evts)
        return {
          ok: true,
          buffered: clean.length,
          total_inputs: nextRun.state.inputs.length,
          phase: nextRun.state.phase,
          message: `Buffered ${clean.length} instruction segment(s) — total ${nextRun.state.inputs.length}. Queue is ${nextRun.state.phase}; nothing executed yet.`,
        }
      },
    },
    'dsh-instruction-queue: iq_collect',
  )

  // ── iq_compile ───────────────────────────────────────────────────────────
  ctx.tools.register(
    {
      name: 'iq_compile',
      description:
        'Instruction Queue: compile the buffered inputs into a PROPOSED obligation queue '
        + '(atomic intent extraction, dedupe/conflict analysis, dependency graph, ordering). '
        + 'The result is a proposal — NOTHING executes until iq_approve. Compile detects '
        + 'supersessions (e.g. input 7 replaces input 2), contradictions, dependency cycles, '
        + 'and ambiguities, and reports them for the user to resolve at approval time.',
      parameters: { type: 'object', properties: {}, required: [] },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            proposed_tasks: { type: 'number' },
            conflicts: { type: 'array', items: { type: 'string' } },
            cycles: { type: 'array', items: { type: 'string' } },
            ambiguities: { type: 'array', items: { type: 'string' } },
            message: { type: 'string' },
          },
          required: ['ok', 'proposed_tasks', 'conflicts', 'cycles', 'ambiguities', 'message'],
        },
        render: (_args: unknown, v: { ok: boolean; proposed_tasks: number; conflicts: string[]; cycles: string[]; ambiguities: string[]; message: string }) => {
          const extra = [
            ...(v.conflicts.length ? [`conflicts: ${v.conflicts.join('; ')}`] : []),
            ...(v.cycles.length ? [`⚠ dependency cycles: ${v.cycles.join('; ')}`] : []),
            ...(v.ambiguities.length ? [`ambiguities: ${v.ambiguities.join('; ')}`] : []),
          ]
          return [{ type: 'text', text: v.message + (extra.length ? `\n${extra.join('\n')}` : '') }]
        },
      },
      async execute(_args: Record<string, never>, exec: ExecCtx) {
        const sessionId = sessionOf(exec)
        if (sessionId === '') return { ok: false, proposed_tasks: 0, conflicts: [], cycles: [], ambiguities: [], message: 'iq_compile requires an owning agent session.' }
        const run = loadRun(sessionId)
        if (run === null || !run.state.enabled) {
          return { ok: false, proposed_tasks: 0, conflicts: [], cycles: [], ambiguities: [], message: 'No active queue — call iq_enable first.' }
        }
        if (run.state.inputs.length === 0) {
          return { ok: false, proposed_tasks: 0, conflicts: [], cycles: [], ambiguities: [], message: 'Queue is empty — call iq_collect with instruction segments first.' }
        }
        const state = run.state
        const ts = nowIso()
        const requested: IQEvent = {
          kind: 'COMPILE_REQUESTED', seq: -1, run_id: sessionId, ts,
          input_sequences: state.inputs.map((i) => i.queue_sequence),
        }
        const afterRequest = commitEvents(sessionId, run.events, [requested])

        // The LLM semantic work lives in a lazily-imported module so this file
        // stays importable without dsh-llm installed (e.g. typecheck-only).
        const { compileQueue } = await import('./compile.ts')
        const compiled = await compileQueue(ctx, exec.agent, afterRequest.state, config)
        if (compiled === null) {
          // Compile failed (LLM error / bad output). Re-emit collecting: the
          // queue keeps its buffered inputs untouched (nothing runs, zero loss).
          return {
            ok: false,
            proposed_tasks: 0,
            conflicts: [],
            cycles: [],
            ambiguities: [],
            message: 'Compile failed (LLM error or malformed output). Inputs are preserved — retry iq_compile or adjust inputs.',
          }
        }
        const evts: IQEvent[] = [
          {
            kind: 'QUEUE_COMPILED',
            seq: -1,
            run_id: sessionId,
            ts: nowIso(),
            tasks: compiled.tasks,
            conflicts: compiled.conflicts,
            dependency_cycles: compiled.dependency_cycles,
            ambiguities: compiled.ambiguities,
          },
        ]
        const next = commitEvents(sessionId, afterRequest.events, evts)
        const message = `Compiled ${compiled.tasks.length} proposed obligation(s) — phase ${next.state.phase}. `
          + (compiled.dependency_cycles.length > 0
            ? '⚠ unresolved dependency cycle(s): approval is blocked until resolved. '
            : 'Review and approve with iq_approve (or adjust inputs and recompile).')
        return {
          ok: true,
          proposed_tasks: compiled.tasks.length,
          conflicts: compiled.conflicts.map((c) => `${c.from_input_id} ${c.kind === 'supersedes' ? 'superseded by' : 'contradicts'} ${c.to_input_id}`),
          cycles: compiled.dependency_cycles.map((c) => c.join(' → ')),
          ambiguities: compiled.ambiguities.map((a) => `${a.input_ids.join(', ')}: ${a.note}`),
          message,
        }
      },
    },
    'dsh-instruction-queue: iq_compile',
  )

  // ── iq_approve ───────────────────────────────────────────────────────────
  ctx.tools.register(
    {
      name: 'iq_approve',
      description:
        'Instruction Queue: approve the compiled proposal (whole or partial). Approval locks '
        + 'each task\'s semantics AND its acceptance criteria at this revision — later semantic '
        + 'changes require a new proposal, never a silent rewrite. Provide supersessions to '
        + 'acknowledge the compiler\'s conflicts (e.g. {from: "IN2", to: "IN7"} = input 7 '
        + 'replaces input 2).',
      parameters: {
        type: 'object',
        properties: {
          approve_all: {
            type: 'boolean',
            description: 'Approve every proposed task (default true). Set false to approve only task_ids.',
          },
          task_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tasks to approve when approve_all is false.',
          },
          reject_task_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tasks to explicitly reject (dropped from the queue).',
          },
          supersessions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                from: { type: 'string' },
                to: { type: 'string' },
              },
              required: ['from', 'to'],
            },
            description: 'Acknowledge compiler conflicts the user confirms (supersessions).',
          },
        },
        required: [],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            approved: { type: 'number' },
            rejected: { type: 'number' },
            phase: { type: 'string' },
            message: { type: 'string' },
          },
          required: ['ok', 'approved', 'rejected', 'phase', 'message'],
        },
        render: (_args: unknown, v: { ok: boolean; approved: number; rejected: number; phase: string; message: string }) =>
          [{ type: 'text', text: v.message }],
      },
      async execute(args: { approve_all?: boolean; task_ids?: string[]; reject_task_ids?: string[]; supersessions?: { from: string; to: string }[] }, exec: ExecCtx) {
        const sessionId = sessionOf(exec)
        if (sessionId === '') return { ok: false, approved: 0, rejected: 0, phase: 'idle', message: 'iq_approve requires an owning agent session.' }
        const run = loadRun(sessionId)
        if (run === null || run.state.phase !== 'awaiting_approval') {
          return { ok: false, approved: 0, rejected: 0, phase: run?.state.phase ?? 'idle', message: 'No proposal awaiting approval — run iq_compile first.' }
        }
        const proposed = run.state.tasks.filter((t) => t.approval_status === 'proposed')
        if (proposed.length === 0) {
          return { ok: false, approved: 0, rejected: 0, phase: run.state.phase, message: 'No proposed tasks to approve.' }
        }
        const supersessions = Array.isArray(args.supersessions) ? args.supersessions : []
        const rejectIds = new Set(Array.isArray(args.reject_task_ids) ? args.reject_task_ids : [])
        let approveIds: Set<string>
        if (args.approve_all === false && Array.isArray(args.task_ids) && args.task_ids.length > 0) {
          approveIds = new Set(args.task_ids)
        } else {
          approveIds = new Set(proposed.map((t) => t.task_id))
        }
        for (const id of rejectIds) approveIds.delete(id)
        const approveList = proposed.filter((t) => approveIds.has(t.task_id)).map((t) => t.task_id)
        const rejectList = proposed.filter((t) => rejectIds.has(t.task_id)).map((t) => t.task_id)
        if (approveList.length === 0) {
          return { ok: false, approved: 0, rejected: rejectList.length, phase: run.state.phase, message: 'Nothing approved — provide task_ids or approve_all=true.' }
        }
        // Acknowledged supersessions: the compiler's supersede conflicts that
        // the user confirms. We record them as facts in the approval event.
        const acked = supersessions.filter((s) =>
          typeof s?.from === 'string' && typeof s?.to === 'string',
        ).map((s) => ({ from_input_id: s.from, to_input_id: s.to }))
        const rev = 1 // V1: first approval revision; semantic edits bump later via proposal
        const evt: IQEvent = {
          kind: 'QUEUE_APPROVED',
          seq: -1,
          run_id: sessionId,
          ts: nowIso(),
          approved_task_ids: approveList,
          supersessions: acked,
          rejected_task_ids: rejectList,
          approved_revision: rev,
        }
        const next = commitEvents(sessionId, run.events, [evt])
        const msg = `Approved ${approveList.length} obligation(s)${rejectList.length ? `, rejected ${rejectList.length}` : ''} — phase ${next.state.phase}. `
          + 'Execute the next segment with iq_execute_next.'
        return { ok: true, approved: approveList.length, rejected: rejectList.length, phase: next.state.phase, message: msg }
      },
    },
    'dsh-instruction-queue: iq_approve',
  )

  // ── iq_execute_next ──────────────────────────────────────────────────────
  ctx.tools.register(
    {
      name: 'iq_execute_next',
      description:
        'Instruction Queue: dispatch the next approved obligation as the current execution '
        + 'segment. Returns the execution envelope (exact task, acceptance criteria, '
        + 'constraints). Execute THIS segment only — do NOT advance other queue tasks. '
        + 'After executing, call iq_reconcile with the result.',
      parameters: { type: 'object', properties: {}, required: [] },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            task_id: { type: 'string' },
            attempt_id: { type: 'string' },
            envelope: {
              type: 'object',
              additionalProperties: false,
              properties: {
                task: { type: 'string' },
                intent_type: { type: 'string' },
                targets: { type: 'array', items: { type: 'string' } },
                acceptance_criteria: { type: 'array', items: { type: 'string' } },
                hard_dependencies: { type: 'array', items: { type: 'string' } },
                side_effect_class: { type: 'string' },
                instruction: { type: 'string' },
              },
              required: ['task', 'intent_type', 'targets', 'acceptance_criteria', 'side_effect_class', 'instruction'],
            },
            message: { type: 'string' },
          },
          required: ['ok', 'message'],
        },
        render: (_args: unknown, v: { ok: boolean; task_id: string | null; attempt_id: string | null; envelope: { task: string; intent_type: string; targets: string[]; acceptance_criteria: string[]; hard_dependencies: string[]; side_effect_class: string; instruction: string } | null; message: string }) => {
          if (!v.ok || v.envelope === null) return [{ type: 'text', text: v.message }]
          const e = v.envelope
          return [{
            type: 'text',
            text: `Execute segment ${v.task_id} (attempt ${v.attempt_id}):\n\n`
              + `TASK: ${e.task}\n`
              + `intent: ${e.intent_type} | targets: ${e.targets.join(', ')} | side-effect: ${e.side_effect_class}\n\n`
              + `ACCEPTANCE CRITERIA:\n${e.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\n`
              + `${e.instruction}\n\n`
              + 'After completing, call iq_reconcile with the result.',
          }]
        },
      },
      async execute(_args: Record<string, never>, exec: ExecCtx) {
        const sessionId = sessionOf(exec)
        if (sessionId === '') return { ok: false, task_id: null, attempt_id: null, envelope: null, message: 'iq_execute_next requires an owning agent session.' }
        const run = loadRun(sessionId)
        if (run === null) return { ok: false, task_id: null, attempt_id: null, envelope: null, message: 'No active queue.' }
        const state = run.state
        if (state.phase !== 'ready' && state.phase !== 'executing' && state.phase !== 'reconciling') {
          return { ok: false, task_id: null, attempt_id: null, envelope: null, message: `Queue is ${state.phase} — cannot dispatch now.` }
        }
        if (state.active_task_id !== null) {
          return { ok: false, task_id: null, attempt_id: null, envelope: null, message: `Task ${state.active_task_id} is already active — finish it (iq_reconcile) first.` }
        }
        const task = nextDispatchable(state)
        if (task === null) {
          const done = allResolved(state)
          return { ok: false, task_id: null, attempt_id: null, envelope: null, message: done ? 'All approved obligations resolved — queue complete.' : 'No dispatchable task (check dependencies / approvals).' }
        }
        const attemptId = `A${task.attempts.length + 1}`
        const ts = nowIso()
        const evts: IQEvent[] = [
          { kind: 'TASK_DISPATCHED', seq: -1, run_id: sessionId, ts, task_id: task.task_id, attempt_id: attemptId },
          { kind: 'ATTEMPT_STARTED', seq: -1, run_id: sessionId, ts, task_id: task.task_id, attempt_id: attemptId },
        ]
        const next = commitEvents(sessionId, run.events, evts)
        const envelope = {
          task: task.task,
          intent_type: task.intent_type,
          targets: task.targets,
          acceptance_criteria: task.acceptance_criteria.map((c) => c.text),
          hard_dependencies: task.hard_dependencies,
          side_effect_class: task.side_effect_class,
          instruction: `Execute exactly this segment in the main session. Do NOT advance other queue tasks. `
            + `After executing, call iq_reconcile with { task_id: "${task.task_id}", attempt_id: "${attemptId}", result: ... }.`,
        }
        return { ok: true, task_id: task.task_id, attempt_id: attemptId, envelope, message: `Dispatched ${task.task_id} (${attemptId}).` }
      },
    },
    'dsh-instruction-queue: iq_execute_next',
  )

  // ── iq_reconcile ─────────────────────────────────────────────────────────
  ctx.tools.register(
    {
      name: 'iq_reconcile',
      description:
        'Instruction Queue: reconcile the plan after executing one segment. Captures the '
        + 'segment result (advisory summary + evidence), judges each acceptance criterion '
        + 'against the evidence, and revises the remaining graph: residual work auto-enters '
        + 'the queue; scope-expanding work is PROPOSED and requires a new approval. Never '
        + 'calls this before executing the dispatched segment.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The dispatched task id from iq_execute_next.' },
          attempt_id: { type: 'string', description: 'The attempt id from iq_execute_next.' },
          result_summary: {
            type: 'string',
            description: 'What was done. This is ADVISORY context — criteria are judged on evidence, not this summary.',
          },
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                type: { type: 'string', enum: ['file_change', 'command_result', 'workspace_state', 'agent_conclusion', 'external'] },
                path: { type: 'string' },
                command: { type: 'string' },
                exit_code: { type: 'number' },
                authority: { type: 'string', enum: ['tool', 'workspace', 'agent'] },
                artifact_version: { type: 'string' },
                note: { type: 'string' },
              },
              required: ['id', 'type', 'authority'],
            },
            description: 'Structured evidence observed during execution (file changes, command results, workspace state). Agent conclusions are the weakest authority and alone cannot satisfy a criterion.',
          },
          criteria: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                criterion_id: { type: 'string' },
                satisfied: { type: 'boolean' },
                evidence_refs: { type: 'array', items: { type: 'string' } },
              },
              required: ['criterion_id', 'satisfied', 'evidence_refs'],
            },
            description: 'Per-criterion judgement: which acceptance criteria are satisfied and by which evidence.',
          },
        },
        required: ['task_id', 'attempt_id'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            resolution: { type: 'string' },
            audit_issues: { type: 'array', items: { type: 'string' } },
            proposed: { type: 'array', items: { type: 'string' } },
            remaining: { type: 'number' },
            message: { type: 'string' },
          },
          required: ['ok', 'resolution', 'audit_issues', 'proposed', 'remaining', 'message'],
        },
        render: (_args: unknown, v: { ok: boolean; resolution: string; audit_issues: string[]; proposed: string[]; remaining: number; message: string }) => {
          const issues = v.audit_issues.length ? `\n⚠ ${v.audit_issues.join('\n⚠ ')}` : ''
          const props = v.proposed.length ? `\nproposed additions: ${v.proposed.join('; ')}` : ''
          return [{ type: 'text', text: v.message + issues + props }]
        },
      },
      async execute(args: { task_id: string; attempt_id: string; result_summary?: string; evidence?: { id: string; type: string; path?: string; command?: string; exit_code?: number; authority: string; artifact_version?: string; note?: string }[]; criteria?: { criterion_id: string; satisfied: boolean; evidence_refs: string[] }[] }, exec: ExecCtx) {
        const sessionId = sessionOf(exec)
        if (sessionId === '') return { ok: false, resolution: 'none', audit_issues: [], proposed: [], remaining: 0, message: 'iq_reconcile requires an owning agent session.' }
        const run = loadRun(sessionId)
        if (run === null) return { ok: false, resolution: 'none', audit_issues: [], proposed: [], remaining: 0, message: 'No active queue.' }
        const task = run.state.tasks.find((t) => t.task_id === args.task_id)
        if (task === undefined) return { ok: false, resolution: 'none', audit_issues: [], proposed: [], remaining: 0, message: `Task ${args.task_id} not found.` }
        const attempt = task.attempts.find((a) => a.attempt_id === args.attempt_id)
        if (attempt === undefined) return { ok: false, resolution: 'none', audit_issues: [], proposed: [], remaining: 0, message: `Attempt ${args.attempt_id} not found on ${args.task_id}.` }
        if (run.state.active_task_id !== task.task_id) {
          return { ok: false, resolution: 'none', audit_issues: [], proposed: [], remaining: 0, message: `${args.task_id} is not the active task — dispatch it with iq_execute_next first.` }
        }

        const ts = nowIso()
        const evid = Array.isArray(args.evidence) ? args.evidence : []
        const evtCap: IQEvent = {
          kind: 'ATTEMPT_RESULT_CAPTURED',
          seq: -1,
          run_id: sessionId,
          ts,
          task_id: task.task_id,
          attempt_id: attempt.attempt_id,
          result_summary: typeof args.result_summary === 'string' && args.result_summary.length > 0 ? args.result_summary : null,
          evidence: evid.map((e) => ({
            id: e.id,
            type: e.type,
            ...(e.path !== undefined ? { path: e.path } : {}),
            ...(e.command !== undefined ? { command: e.command } : {}),
            ...(e.exit_code !== undefined ? { exit_code: e.exit_code } : {}),
            observed_at: ts,
            authority: e.authority,
            ...(e.artifact_version !== undefined ? { artifact_version: e.artifact_version } : {}),
            ...(e.note !== undefined ? { note: e.note } : {}),
          })),
        }
        const captured = commitEvents(sessionId, run.events, [evtCap])

        // The LLM semantic work (criterion judgement + residual/expansion
        // extraction) lives in the lazily-imported module.
        const { reconcileResult } = await import('./reconcile.ts')
        const rec = await reconcileResult(ctx, exec.agent, captured.state, task, attempt, config, {
          summary: evtCap.result_summary,
          evidence: evtCap.evidence as ReconcileEvidence[],
          criteria: Array.isArray(args.criteria) ? args.criteria : undefined,
        })

        const evts: IQEvent[] = [
          {
            kind: 'ATTEMPT_COMMITTED',
            seq: -1,
            run_id: sessionId,
            ts: nowIso(),
            task_id: task.task_id,
            attempt_id: attempt.attempt_id,
            attempt_status: rec.attempt_status,
            task_execution_status: rec.task_execution_status,
          },
          ...rec.criteria_met.map((c) => ({
            kind: 'TASK_CRITERION_SATISFIED' as const,
            seq: -1,
            run_id: sessionId,
            ts: nowIso(),
            task_id: task.task_id,
            criterion_id: c.criterion_id,
            evidence_refs: c.evidence_refs,
          })),
          {
            kind: 'TASK_COVERED',
            seq: -1,
            run_id: sessionId,
            ts: nowIso(),
            task_id: task.task_id,
            resolution_status: rec.resolution_status,
            note: rec.note,
          },
          ...rec.proposals.map((p) => ({
            kind: 'TASK_PROPOSED' as const,
            seq: -1,
            run_id: sessionId,
            ts: nowIso(),
            task: p.task,
            parent_task_id: p.parent_task_id,
            derived_from_criteria: p.derived_from_criteria,
            origin: p.origin,
          })),
        ]
        const next = commitEvents(sessionId, captured.events, evts)

        // Completion gate: all approved obligations resolved?
        const approved = approvedObligations(next.state)
        const unresolved = approved.filter((t) => !['satisfied', 'covered', 'skipped'].includes(t.resolution_status))
        const remaining = unresolved.length
        let message = `Reconciled ${task.task_id}: resolution=${rec.resolution_status}.`
        if (remaining === 0 && approved.length > 0) {
          const comp: IQEvent = {
            kind: 'RUN_COMPLETED',
            seq: -1,
            run_id: sessionId,
            ts: nowIso(),
            summary: approved.map((t) => ({ task_id: t.task_id, resolution_status: t.resolution_status })),
          }
          const final = commitEvents(sessionId, next.events, [comp])
          message = `All ${approved.length} approved obligation(s) resolved — queue COMPLETED (phase ${final.state.phase}).`
        } else {
          message += ` ${remaining} obligation(s) remain (phase ${next.state.phase}).`
        }
        return {
          ok: true,
          resolution: rec.resolution_status,
          audit_issues: rec.audit_issues,
          proposed: rec.proposals.map((p) => `${p.task.task_id} (${p.origin})`),
          remaining,
          message,
        }
      },
    },
    'dsh-instruction-queue: iq_reconcile',
  )
}

/** True when every approved obligation is resolved (completion gate). */
function allResolved(state: RunState): boolean {
  const approved = approvedObligations(state)
  if (approved.length === 0) return false
  return approved.every((t) => ['satisfied', 'covered', 'skipped'].includes(t.resolution_status))
}
