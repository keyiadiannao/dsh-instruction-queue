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
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { IQEvent } from './iq/events.ts'
import { appendEvents, assignSeqs, loadLedger } from './iq/ledger.ts'
import { allApprovedResolved, approvedObligations, executableTasks, nextDispatchable, reduceAll } from './iq/reducer.ts'
import { auditCoverage } from './iq/invariants.ts'
import type { RawInput, RunState, Task } from './iq/types.ts'
import type { ReconcileEvidence } from './reconcile.ts'

export const name = 'dsh-instruction-queue'

export const inject = ['tools', 'llm', 'webServer', 'agents']

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
  /**
   * When true (and the run is collecting), normal user inputs are
   * intercepted at agent/pre-step and buffered instead of executed —
   * the queue becomes a real input routing state. Control utterances
   * (start/compile/approve/abort) pass through. Default false: the
   * tool-driven loop (iq_collect) is the V1 behavior.
   */
  autoCapture: boolean
}

/** Schemastery schema; cordis validates and provides it as apply(ctx, config). */
export const Config: z<Config> = z.object({
  // Empty default → resolve portably at apply time (~/.dsh/storages/...).
  dataDir: z.string().default(''),
  llmProvider: z.string().default(''),
  llmModel: z.string().default(''),
  allowPartialApproval: z.boolean().default(true),
  maxCompiledTasks: z.number().min(1).max(50).default(12),
  autoCapture: z.boolean().default(false),
})

/** Resolve the ledger root: explicit config, else the portable default. */
export function resolveDataDir(configDataDir: string): string {
  if (configDataDir.length > 0) return configDataDir
  // Prefer the harness home ($DSH_HOME) so a test/isolated instance keeps its
  // ledger inside its OWN home instead of polluting the default user home;
  // fall back to os.homedir()/.dsh. Never hardcode a user-specific path.
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'storages', 'instruction-queue')
}

/** A registered tool's execute context (subset we rely on). */
interface ExecCtx {
  signal?: AbortSignal
  agent?: AgentLike
}

/** The live agent surface the driver + tools rely on (loose; typechecked locally). */
interface AgentLike {
  id: string
  status: 'idle' | 'running'
  session?: {
    id?: unknown
    requestHeader?: () => { config?: { provider?: string; model?: string } }
  }
  inbox?: {
    nextTurn?: readonly { id?: string; content?: unknown; source?: { kind?: string; plugin?: string } }[]
    nextStep?: readonly { id?: string; content?: unknown; source?: { kind?: string; plugin?: string } }[]
    hasPending?: boolean
    append?(target: 'next-turn' | 'next-step', message: unknown): void
    prepend?(target: 'next-turn' | 'next-step', message: unknown): void
  }
  /** Push-driven dispatch: inject the next execution envelope and wake the loop. */
  followup?: (input: { content: unknown; source?: unknown }) => void
  cancel?(cause: unknown, options?: { keepInbox?: boolean }): void
  whenIdle?(): Promise<void>
}

/** One queued/claimed execution envelope reserved until quiescence. */
interface DriverAttempt {
  messageId: string
  taskId: string
  attemptId: string
  phase: 'queued' | 'claimed' | 'admitted'
  stale: boolean
}

/** Serialized process-local scheduling state for one agent lifecycle. */
interface DriverState {
  agent: AgentLike
  attempt: DriverAttempt | undefined
  competingQueued: boolean
  requested: boolean
  run: Promise<void> | undefined
  stopping: boolean
}

export function apply(ctx: any, config: Config): void {
  // Portable ledger root (explicit config wins, else ~/.dsh/storages/...).
  const dataDir = resolveDataDir(config.dataDir)
  // Per-session run state cache: { sessionId → { events, state } }.
  // This is a cache ONLY; the ledger file is authoritative (Invariant #9).
  const runs = new Map<string, { events: IQEvent[]; state: RunState }>()

  // SECURITY: never derive the ledger filename from a raw session id (a
  // session id ending in ../ could escape dataDir). Use a fixed-length sha256
  // hash of the id as the filename; the raw id is stored inside the ledger
  // (run_id/session_id) and verified on replay.
  const ledgerOf = (sessionId: string) => join(dataDir, `${sha256Hex(sessionId)}.ndjson`)
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

  // ── idle-gated IQ driver (goal-round-driver pattern) ──────────────────────
  // The plan drives segment execution from an EXTERNAL driver that only acts
  // when the whole agent is idle, so a human interjection queued in nextTurn
  // is never hidden behind our push envelope (Inbox.claim takes only the FIFO
  // head of nextTurn at a fresh turn). Reconcile marks the run as needing a
  // drive; agent/status==='idle' runs it; agent/inbox/inserted raises a
  // competing flag that pauses us; agent/pre-step validates stale reservations
  // and buffers human deltas (live intake).
  const driverStates = new Map<string, DriverState>()

  /** Get (or create) the serialized driver state for a session id. */
  function stateForSession(sessionId: string): DriverState {
    const existing = driverStates.get(sessionId)
    if (existing !== undefined) return existing
    const state: DriverState = {
      agent: { id: sessionId, status: 'idle' } as AgentLike,
      attempt: undefined,
      competingQueued: false,
      requested: false,
      run: undefined,
      stopping: false,
    }
    driverStates.set(sessionId, state)
    return state
  }

  /** Whether this exact lifecycle is quiescent with no competing prompt. */
  function readyToDrive(state: DriverState): boolean {
    return !state.stopping
      && state.agent.status === 'idle'
      && !state.competingQueued
  }

  /**
   * Dispatch the next runnable approved segment (write TASK_DISPATCHED) and
   * reserve ONE execution envelope, then followup() it. Called only from the
   * idle driver, so a queued human prompt gets its own turn first.
   */
  function drive(state: DriverState): Promise<void> {
    // ONLY drive from true quiescence — if the agent is still running (e.g. a
    // requestDrive arrived from inside the reconcile tool), do nothing; the
    // agent/status==='idle' transition will re-trigger the driver later.
    if (!readyToDrive(state)) return Promise.resolve()
    const sessionId = state.agent.id
    const run = runs.get(sessionId)
    if (run === undefined || !run.state.enabled) return Promise.resolve()
    if (run.state.active_task_id !== null) return Promise.resolve() // one owner
    // Phase gates: only drive when the queue is ready/executing/reconciling.
    const phase = run.state.phase
    if (phase !== 'ready' && phase !== 'executing' && phase !== 'reconciling') return Promise.resolve()
    const next = nextDispatchable(run.state)
    if (next === null) return Promise.resolve()
    const attemptId = `A${next.attempts.length + 1}`
    const dispatchEvt: IQEvent = {
      kind: 'TASK_DISPATCHED', seq: -1, run_id: sessionId, ts: nowIso(),
      task_id: next.task_id, attempt_id: attemptId,
    }
    const afterDispatch = commitEvents(sessionId, run.events, [dispatchEvt])
    const t = afterDispatch.state.tasks.find((x) => x.task_id === next.task_id)
    if (t === undefined) return Promise.resolve()
    const message = buildEnvelopeMessage(t, attemptId)
    const reservation: DriverAttempt = {
      messageId: message.id,
      taskId: t.task_id,
      attemptId,
      phase: 'queued',
      stale: false,
    }
    state.attempt = reservation
    try {
      // The live agent may differ from the state stub; resolve it via ctx.
      const live = resolveLiveAgent(sessionId)
      if (live !== undefined && typeof live.followup === 'function') {
        live.followup(message)
        // eslint-disable-next-line no-console
        console.log(`[dsh-instruction-queue] driver: followup envelope ${t.task_id} (${attemptId})`)
      } else {
        // eslint-disable-next-line no-console
        console.log(`[dsh-instruction-queue] driver: no live agent for ${sessionId}; envelope reserved, not sent`)
      }
    } catch (e) {
      state.attempt = undefined
      // eslint-disable-next-line no-console
      console.log(`[dsh-instruction-queue] driver: followup failed for ${sessionId}: ${e instanceof Error ? e.message : String(e)}`)
    }
    return Promise.resolve()
  }

  /** Coalesce triggers onto one agent-local serialized driver. */
  function requestDrive(state: DriverState): void {
    if (state.stopping) return
    state.requested = true
    if (state.run !== undefined) return
    let run: Promise<void>
    try {
      run = (async () => {
        while (state.requested && !state.stopping) {
          state.requested = false
          try {
            await drive(state)
          } catch (e) {
            // eslint-disable-next-line no-console
            console.log(`[dsh-instruction-queue] driver failed for ${state.agent.id}: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
      })()
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log(`[dsh-instruction-queue] could not start driver for ${state.agent.id}: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    state.run = run
    const retire = (): void => {
      state.run = undefined
      if (state.requested && !state.stopping) requestDrive(state)
    }
    void run.then(retire, () => { retire() })
  }

  /**
   * Reconcile calls this after writing its events: mark the run as needing a
   * drive. The driver fires when the agent converges to idle.
   */
  function requestDriveForAgent(agent: AgentLike | undefined): void {
    const sessionId = agent?.session?.id
    if (sessionId === undefined || sessionId === null) return
    const id = String(sessionId)
    const state = stateForSession(id)
    // Refresh the live agent so status checks are real.
    const live = resolveLiveAgent(id)
    if (live !== undefined) state.agent = live
    requestDrive(state)
  }

  /** Resolve the live agent instance for a session id via ctx.agents. */
  function resolveLiveAgent(sessionId: string): AgentLike | undefined {
    try {
      const agents = (ctx as { agents?: { get?: (id: string) => AgentLike | undefined } }).agents
      return agents?.get?.(sessionId)
    } catch {
      return undefined
    }
  }

  // ── HTTP status surface (for the client plan panel) ──────────────────────
  // GET /api/dsh-instruction-queue/status?sessionId=... → serializable
  // projection of the run state the client renders. Loopback-only trust fence.
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/dsh-instruction-queue/status',
    handler: async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
      const address = req.socket?.remoteAddress
      if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'forbidden: non-loopback' }))
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sessionId = url.searchParams.get('sessionId') ?? ''
        if (sessionId === '') {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'missing sessionId' }))
          return
        }
        const run = loadRun(sessionId)
        const body = run === null
          ? { ok: true, active: false }
          : { ok: true, active: true, state: projectForClient(run.state) }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : 'bad request' }))
      }
    },
  }), 'dsh-instruction-queue: status route')

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
          return { active: false, phase: 'idle', input_count: 0, approved_count: 0, resolved_count: 0, next_task_id: '', recovery_note: '' }
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
          // DSH schema accepts only single types (no ['string','null']), so
          // null becomes '' (render already tolerates empty via ??).
          next_task_id: next?.task_id ?? '',
          recovery_note: run.state.recovery_note ?? '',
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
        const maxTasks = Math.max(1, config.maxCompiledTasks)
        const overLimit = compiled.tasks.length > maxTasks
        const message = `Compiled ${compiled.tasks.length} proposed obligation(s) — phase ${next.state.phase}. `
          + (overLimit
            ? `⚠ ${compiled.tasks.length} tasks exceeds maxCompiledTasks (${maxTasks}) — consider splitting or pruning. `
            : '')
          + (compiled.dependency_cycles.length > 0
            ? '⚠ unresolved dependency cycle(s): approval is blocked until resolved. '
            : 'Review and approve with iq_approve (or adjust inputs and recompile).')
        return {
          ok: true,
          proposed_tasks: compiled.tasks.length,
          conflicts: compiled.conflicts.map((c) => `${c.from_input_id} ${c.kind === 'supersedes' ? 'superseded by' : 'contradicts'} ${c.to_input_id}`),
          cycles: compiled.dependency_cycles.map((c) => c.join(' → ')),
          ambiguities: [
            ...compiled.ambiguities.map((a) => `${a.input_ids.join(', ')}: ${a.note}`),
            ...(overLimit ? [`task count ${compiled.tasks.length} > maxCompiledTasks ${maxTasks}`] : []),
          ],
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
        // GATE 1 — unresolved hard-dependency cycles block approval
        // (design: "unresolved hard dependency cycle 不进入 READY").
        if (run.state.dependency_cycles.length > 0) {
          return {
            ok: false, approved: 0, rejected: 0, phase: run.state.phase,
            message: `Approval blocked: unresolved dependency cycle(s) ${run.state.dependency_cycles.map((c) => c.join(' → ')).join('; ')}. Recompile after fixing inputs, or reject the cyclic tasks.`,
          }
        }
        // GATE 2 — every compiler-reported supersession/contradiction must be
        // acknowledged (or its tasks rejected) before approval. A supersede
        // conflict means input `to` replaces input `from`; the user must
        // confirm by passing { from, to }, or reject tasks carrying `from`.
        const ackedPairs = new Set(
          (Array.isArray(args.supersessions) ? args.supersessions : [])
            .filter((s) => typeof s?.from === 'string' && typeof s?.to === 'string')
            .map((s) => `${s.from}->${s.to}`),
        )
        const rejectIds = new Set(Array.isArray(args.reject_task_ids) ? args.reject_task_ids : [])
        const unacked: string[] = []
        for (const c of run.state.conflicts) {
          const pair = `${c.from_input_id}->${c.to_input_id}`
          const covered = ackedPairs.has(pair)
          const rejected = proposed.some((t) => rejectIds.has(t.task_id) && t.source_input_ids.includes(c.from_input_id))
          if (!covered && !rejected) {
            unacked.push(`${c.from_input_id} ${c.kind === 'supersedes' ? 'superseded by' : 'contradicts'} ${c.to_input_id}`)
          }
        }
        if (unacked.length > 0) {
          return {
            ok: false, approved: 0, rejected: 0, phase: run.state.phase,
            message: `Approval blocked: unresolved compiler conflict(s): ${unacked.join('; ')}. Acknowledge each with supersessions: [{from, to}] or reject the affected tasks.`,
          }
        }
        // GATE 3 — partial approval only when the deployment allows it.
        const wantsPartial = args.approve_all === false && Array.isArray(args.task_ids) && args.task_ids.length > 0
        if (wantsPartial && !config.allowPartialApproval) {
          return {
            ok: false, approved: 0, rejected: 0, phase: run.state.phase,
            message: 'Partial approval is disabled by config (allowPartialApproval=false) — approve the whole queue with approve_all=true.',
          }
        }
        let approveIds: Set<string>
        if (wantsPartial) {
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
        const acked = (Array.isArray(args.supersessions) ? args.supersessions : [])
          .filter((s) => typeof s?.from === 'string' && typeof s?.to === 'string')
          .map((s) => ({ from_input_id: s.from, to_input_id: s.to }))
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
        // Failure returns omit the nullable task_id/attempt_id/envelope fields
        // entirely (DSH schema is single-typed; non-required fields may be
        // absent, but may NOT be null). The renderer shows message on !ok.
        if (sessionId === '') return { ok: false, message: 'iq_execute_next requires an owning agent session.' }
        const run = loadRun(sessionId)
        if (run === null) return { ok: false, message: 'No active queue.' }
        const state = run.state
        if (state.phase !== 'ready' && state.phase !== 'executing' && state.phase !== 'reconciling') {
          return { ok: false, message: `Queue is ${state.phase} — cannot dispatch now.` }
        }
        // IDEMPOTENT DISPATCH (push/pull unify): if a task already has a
        // dispatched-but-not-reconciled attempt (the plan push-ran ahead and
        // wrote TASK_DISPATCHED), return that task's live envelope WITHOUT
        // writing a second TASK_DISPATCHED. This lets the agent pull the exact
        // same envelope the plan pushed — no double dispatch, no pending
        // conflict. The latest such task is the one the plan dispatched.
        const dispatchedPending = executableTasks(state).find((t) =>
          t.attempts.length > 0 && t.attempts[t.attempts.length - 1]!.status === 'dispatched'
          && (t.resolution_status === 'open' || t.resolution_status === 'partial'),
        )
        if (dispatchedPending !== undefined) {
          const aId = dispatchedPending.attempts[dispatchedPending.attempts.length - 1]!.attempt_id
          return {
            ok: true,
            task_id: dispatchedPending.task_id,
            attempt_id: aId,
            envelope: envelopeFor(dispatchedPending, aId),
            message: `Returning already-dispatched segment ${dispatchedPending.task_id} (${aId}) — no new dispatch.`,
          }
        }
        if (state.active_task_id !== null) {
          return { ok: false, message: `Task ${state.active_task_id} is already active — finish it (iq_reconcile) first.` }
        }
        const task = nextDispatchable(state)
        if (task === null) {
          const done = allResolved(state)
          return { ok: false, message: done ? 'All approved obligations resolved — queue complete.' : 'No dispatchable task (check dependencies / approvals).' }
        }
        const attemptId = `A${task.attempts.length + 1}`
        const ts = nowIso()
        // Dispatch ONLY. ATTEMPT_STARTED is written by iq_reconcile when the
        // segment has actually executed — this preserves the real crash
        // window "dispatched-but-not-started" that recovery.ts models
        // (a crash after dispatch but before any execution is uncertain,
        // never silently re-run).
        const evts: IQEvent[] = [
          { kind: 'TASK_DISPATCHED', seq: -1, run_id: sessionId, ts, task_id: task.task_id, attempt_id: attemptId },
        ]
        const next = commitEvents(sessionId, run.events, evts)
        const envelope = envelopeFor(task, attemptId)
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
        // P0-5: ATTEMPT_STARTED is a FACT of actual execution. iq_execute_next
        // only dispatched; reaching iq_reconcile proves the segment ran, so
        // this is the moment the attempt truly started (and now finished).
        // In the crash window (dispatch, crash, no reconcile) the attempt
        // stays 'dispatched' and recovery.ts treats it as uncertain.
        const evid = Array.isArray(args.evidence) ? args.evidence : []
        const preEvents: IQEvent[] = []
        if (attempt.status === 'dispatched') {
          preEvents.push({
            kind: 'ATTEMPT_STARTED', seq: -1, run_id: sessionId, ts,
            task_id: task.task_id, attempt_id: attempt.attempt_id,
          })
        }
        // SIDE_EFFECT_OBSERVED: a write/external/irreversible side effect that
        // reconcile can prove from captured evidence (file changes, external
        // calls, workspace mutations). Agent conclusions alone never count.
        const observedEffect = evid.some((e) => e.type === 'file_change' || e.type === 'workspace_state')
          ? 'write'
          : evid.some((e) => e.type === 'external')
            ? 'external'
            : null
        if (observedEffect !== null) {
          preEvents.push({
            kind: 'SIDE_EFFECT_OBSERVED', seq: -1, run_id: sessionId, ts,
            task_id: task.task_id, attempt_id: attempt.attempt_id,
            effect_class: observedEffect,
          })
        }
        let baseRun = run
        if (preEvents.length > 0) {
          baseRun = commitEvents(sessionId, run.events, preEvents)
        }
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
        const captured = commitEvents(sessionId, baseRun.events, [evtCap])

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
        let auditFailures: { task_id: string; criterion_id: string; reason: string }[] = []
        if (remaining === 0 && approved.length > 0) {
          // Final coverage audit (design: incremental reconcile and the final
          // coverage audit are SEPARATE). Every approved AC must have
          // non-agent evidence; otherwise the run is BLOCKED, not completed.
          auditFailures = auditCoverage(next.state).filter((a) => !a.ok)
          if (auditFailures.length === 0) {
            // LIVE INTAKE DELTA: if the plan finished executing every approved
            // obligation but the user added NEW inputs while it ran (Pending
            // Delta), do NOT complete yet — compile the delta into fresh
            // PROPOSED obligations and enter awaiting_approval, so the run
            // continues with the user's late intent (invariant #4: nothing new
            // executes without approval). Only when no delta remains do we
            // write RUN_COMPLETED.
            const pending = pendingDeltaInputs(next.state)
            if (pending.length > 0) {
              const reqEvt: IQEvent = {
                kind: 'COMPILE_REQUESTED', seq: -1, run_id: sessionId, ts: nowIso(),
                input_sequences: pending.map((i) => i.queue_sequence),
              }
              const afterReq = commitEvents(sessionId, next.events, [reqEvt])
              const { compileQueue } = await import('./compile.ts')
              const compiled = await compileQueue(ctx, exec.agent, afterReq.state, config)
              if (compiled !== null && compiled.tasks.length > 0) {
                const compiledEvt: IQEvent = {
                  kind: 'QUEUE_COMPILED', seq: -1, run_id: sessionId, ts: nowIso(),
                  tasks: compiled.tasks, conflicts: compiled.conflicts,
                  dependency_cycles: compiled.dependency_cycles, ambiguities: compiled.ambiguities,
                }
                const afterCompiled = commitEvents(sessionId, afterReq.events, [compiledEvt])
                message = `All ${approved.length} approved obligation(s) resolved and coverage passed, but the user added `
                  + `${pending.length} new instruction(s) during execution (live intake). They were compiled into `
                  + `${compiled.tasks.length} proposed delta obligation(s) — phase ${afterCompiled.state.phase}. ` 
                  + 'Review and approve with iq_approve to continue.'
              } else {
                // Compile failed (LLM/validation) — still complete the current
                // approved work; the late inputs remain buffered for the user.
                const comp: IQEvent = {
                  kind: 'RUN_COMPLETED', seq: -1, run_id: sessionId, ts: nowIso(),
                  summary: approved.map((t) => ({ task_id: t.task_id, resolution_status: t.resolution_status })),
                }
                const final = commitEvents(sessionId, afterReq.events, [comp])
                message = `Current obligations completed, but ${pending.length} live input(s) could not be compiled — `
                  + `queue COMPLETED (phase ${final.state.phase}); the buffered inputs remain for a new run.`
              }
            } else {
              const comp: IQEvent = {
                kind: 'RUN_COMPLETED', seq: -1, run_id: sessionId, ts: nowIso(),
                summary: approved.map((t) => ({ task_id: t.task_id, resolution_status: t.resolution_status })),
              }
              const final = commitEvents(sessionId, next.events, [comp])
              message = `All ${approved.length} approved obligation(s) resolved AND final coverage audit passed — queue COMPLETED (phase ${final.state.phase}).`
            }
          } else {
            const blocked: IQEvent = {
              kind: 'QUEUE_BLOCKED',
              seq: -1,
              run_id: sessionId,
              ts: nowIso(),
              note: `final coverage audit failed: ${auditFailures.map((f) => `${f.task_id}/${f.criterion_id}: ${f.reason}`).join('; ')}`,
            }
            const blockedState = commitEvents(sessionId, next.events, [blocked])
            message = `Coverage audit FAILED — queue BLOCKED (phase ${blockedState.state.phase}). `
              + `${auditFailures.map((f) => `${f.task_id}/${f.criterion_id}: ${f.reason}`).join('; ')}. `
              + 'Resolve by adding evidence, or skip the affected criteria, then reconcile again.'
          }
        } else {
          message += ` ${remaining} obligation(s) remain (phase ${next.state.phase}).`
          // IDLE-GATED PUSH: the plan still has dispatchable work, but we do
          // NOT followup() from inside this tool (that would hide a human
          // interjection behind our envelope — Inbox.claim takes only the FIFO
          // head of nextTurn). Instead, request a drive; the external idle
          // driver dispatches the next segment once the agent converges to
          // idle and no competing user input is queued.
          requestDriveForAgent(exec.agent)
        }
        return {
          ok: true,
          resolution: rec.resolution_status,
          audit_issues: [
            ...rec.audit_issues,
            ...auditFailures.map((f) => `${f.task_id}/${f.criterion_id}: ${f.reason}`),
          ],
          proposed: rec.proposals.map((p) => `${p.task.task_id} (${p.origin})`),
          remaining,
          message,
        }
      },
    },
    'dsh-instruction-queue: iq_reconcile',
  )

  // ── autoCapture: queue mode as a real input routing state ────────────────
  // When enabled and the run is collecting, intercept normal user inputs at
  // agent/pre-step and buffer them (INPUT_BUFFERED) instead of executing.
  // Returning an `enter` decision with ZERO messages makes the agent loop
  // close the turn without a model call (agent-loop: step 0 + empty messages
  // → turn completed), so the user sees "buffered", nothing runs.
  // Control utterances pass through to the main agent (which drives the
  // iq_* tools). Default off: the tool-driven loop is the V1 behavior.
  if (config.autoCapture) {
    ctx.on('agent/pre-step', async ({ agent, messages }: {
      agent?: { session?: { id?: unknown } }
      messages?: readonly { content?: unknown; source?: { kind?: string } }[]
    }, next: () => Promise<unknown>): Promise<unknown> => {
      try {
        const id = agent?.session?.id
        if (id === undefined || id === null) return next()
        const sessionId = String(id)
        const run = runs.get(sessionId)
        if (run === undefined || !run.state.enabled) return next()
        // LIVE INTAKE: capture user text inputs during ANY in-progress phase
        // (collecting, executing, reconciling, compiling, awaiting_approval) —
        // "collection never closes". During execution this is a Pending Delta:
        // it is buffered, does NOT mutate the running attempt (immutable
        // execution envelope), and is merged at the reconciliation barrier.
        // Completed/aborted runs no longer accept new queue inputs.
        if (run.state.phase === 'completed' || run.state.phase === 'aborted') return next()
        if (messages === undefined || messages.length === 0) return next()

        // Only human user text messages are capture candidates. Plugin/system
        // sources (schedule wakes, injected context, our own push envelopes)
        // and non-text content (images/files) always pass through untouched.
        const batch = [...messages]
        if (!batch.every((m) => isCaptureCandidate(m))) return next()

        const texts = batch.map(textOfMessage).filter((t) => t.length > 0)
        if (texts.length === 0) return next()

        // Control utterances are NOT captured — they pass to the agent, which
        // routes them to the iq_* tools (start/compile/approve/…).
        if (texts.every(isControlUtterance)) return next()

        const startSeq = run.state.inputs.length
        const ts = nowIso()
        const evts: IQEvent[] = texts.map((content, i) => ({
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
        commitEvents(sessionId, run.events, evts)
        // eslint-disable-next-line no-console
        console.log(`[dsh-instruction-queue] live intake buffered ${texts.length} input(s) (phase=${run.state.phase})`)
        // Empty enter → turn closes with no model call; nothing executed.
        return { kind: 'enter', messages: [] }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.log(`[dsh-instruction-queue] autoCapture error: ${e instanceof Error ? e.message : String(e)}`)
        return next() // never break the agent loop
      }
    }, 'dsh-instruction-queue: autoCapture pre-step')
  }

  // ── idle-gated driver: lifecycle + race-fence listeners ──────────────────
  // Registered unconditionally (push execution + live intake are core, not
  // gated by config.autoCapture). The composite effect keeps the fences
  // installed until the plugin's own scheduling tasks settle.
  ctx.effect(function* () {
    ctx.on('agent/created', ({ agent }: { agent: { id: string } }) => {
      const state = stateForSession(String(agent.id))
      const live = resolveLiveAgent(String(agent.id))
      if (live !== undefined) state.agent = live
    })
    ctx.on('agent/disposed', ({ agent }: { agent: { id: string } }) => {
      driverStates.delete(String(agent.id))
    })
    ctx.on('agent/status', ({ agent, status }: { agent: { id: string }; status: 'idle' | 'running' }) => {
      const state = stateForSession(String(agent.id))
      const live = resolveLiveAgent(String(agent.id))
      if (live !== undefined) state.agent = live
      if (status === 'idle') {
        state.competingQueued = false
        requestDrive(state)
      }
    })
    ctx.on('agent/inbox/inserted', ({ agent, message }: {
      agent: { id: string; inbox?: { nextTurn?: readonly { id?: string }[] } }
      message: { id?: string; content?: unknown; source?: { kind?: string; plugin?: string } }
    }) => {
      // Only competing ORDINARY input matters; our own envelope is excluded.
      const inbox = agent.inbox
      if (inbox === undefined) return
      const pending = inbox.nextTurn ?? []
      if (!pending.some((c) => c.id !== undefined && c.id === message.id)) return
      const isOurs = message.source?.kind === 'plugin' && message.source.plugin === 'dsh-instruction-queue'
      if (isOurs) return
      const state = stateForSession(String(agent.id))
      state.competingQueued = true
      if (state.attempt?.phase === 'queued') state.attempt.stale = true
    })
    ctx.on('agent/inbox/claimed', ({ agent, message }: {
      agent: { id: string }
      message: { id?: string }
    }) => {
      const state = stateForSession(String(agent.id))
      const attempt = state.attempt
      if (attempt !== undefined && message.id === attempt.messageId) attempt.phase = 'claimed'
    })

    ctx.on('agent/pre-step', async ({ agent, messages, signal }: {
      agent: { id: string; session?: { id?: unknown } }
      messages: readonly { id?: string; content?: unknown; source?: { kind?: string; plugin?: string } }[]
      signal?: AbortSignal
    }, next: () => Promise<unknown>): Promise<unknown> => {
      try {
        const sessionId = agent.session?.id
        if (sessionId === undefined || sessionId === null) return next()
        const id = String(sessionId)
        const state = stateForSession(id)
        const live = resolveLiveAgent(id)
        if (live !== undefined) state.agent = live
        const batch = [...messages]

        // 1) STALE RESERVATION: if our envelope was claimed but the attempt is
        //    stale (a human prompt arrived after we reserved), drop it and
        //    restore the other claimed records, then reject so the competing
        //    human input gets its own turn.
        const submitted = batch.find((m) => m.source?.kind === 'plugin' && m.source.plugin === 'dsh-instruction-queue')
        if (submitted !== undefined && state.attempt !== undefined && submitted.id === state.attempt.messageId) {
          const attempt = state.attempt
          if (attempt.stale || !readyToDrive(state)) {
            attempt.stale = true
            state.attempt = undefined
            restoreOtherClaimed(live, batch, submitted.id)
            requestDrive(state)
            return { kind: 'reject' }
          }
        }

        // 2) LIVE INTAKE: buffer human text inputs while the plan is active.
        //    The running attempt is IMMUTABLE (design invariant): a human
        //    interjection must be buffered as a Pending Delta, never fed into
        //    the model's current step. A claimed batch may mix our envelope +
        //    human deltas + steering; we must NOT call next() after recording a
        //    human delta (next() feeds the whole batch to the model, leaking
        //    the unapproved delta into the running attempt).
        const run = runs.get(id)
        if (run !== undefined && run.state.enabled
          && run.state.phase !== 'completed' && run.state.phase !== 'aborted') {
          const deltas = batch.filter((m) => isCaptureCandidate(m))
          const humanTexts = deltas.map(textOfMessage).filter((t) => t.length > 0)
            .filter((t) => !isControlUtterance(t))
          if (deltas.length > 0 && humanTexts.length > 0) {
            // Buffer the human interjection into the ledger as a Pending Delta.
            const startSeq = run.state.inputs.length
            const ts = nowIso()
            const evts: IQEvent[] = humanTexts.map((content, i) => ({
              kind: 'INPUT_BUFFERED' as const,
              seq: -1,
              run_id: id,
              ts,
              input_id: `IN${startSeq + i + 1}`,
              content,
              queue_sequence: startSeq + i + 1,
              last_visible_event_id: null,
              session_id: id,
            }))
            commitEvents(id, run.events, evts)
            // eslint-disable-next-line no-console
            console.log(`[dsh-instruction-queue] driver: live intake buffered ${humanTexts.length} (phase=${run.state.phase})`)
            // Competing input present → pause auto-drive until the delta is
            // interpreted at the reconciliation barrier.
            state.competingQueued = true

            // Determine whether the remaining (non-human) records are entirely
            // our own approved envelope(s) or foreign (steering/other).
            const nonHuman = batch.filter((m) => !isCaptureCandidate(m))
            const onlyOurs = nonHuman.every((m) => m.source?.kind === 'plugin' && m.source.plugin === 'dsh-instruction-queue')
            if (onlyOurs && nonHuman.length > 0) {
              // Mixed batch: our approved envelope + human delta. Admit ONLY
              // the approved envelope so the already-approved segment runs;
              // do not leak the unapproved delta into the model step.
              requestDrive(state)
              return { kind: 'enter', messages: nonHuman }
            }
            // Foreign non-human records in a mixed batch: reject the whole
            // proposal and restore ONLY the foreign records (the human delta
            // is already buffered in the ledger; the approved envelope is
            // dropped to let the competing input take the next turn).
            if (nonHuman.length > 0) {
              restoreForeign(live, batch, deltas)
              requestDrive(state)
              return { kind: 'reject' }
            }
            // Pure human batch: spend no model call.
            requestDrive(state)
            return { kind: 'enter', messages: [] }
          }
        }
        return next()
      } catch (e) {
        // eslint-disable-next-line no-console
        console.log(`[dsh-instruction-queue] driver pre-step error: ${e instanceof Error ? e.message : String(e)}`)
        return next()
      }
    }, 'dsh-instruction-queue: driver pre-step')
  }, 'dsh-instruction-queue: driver lifecycle')
}

/** True when every approved obligation is resolved (completion gate). */
function allResolved(state: RunState): boolean {
  return allApprovedResolved(state)
}

/** A capture candidate: human user source, text-only content. */
function isCaptureCandidate(m: { content?: unknown; source?: { kind?: string } }): boolean {
  if (m.source !== undefined && m.source.kind !== 'user') return false
  const content = m.content
  if (!Array.isArray(content)) return typeof content === 'string' || content === undefined
  return content.every((b) => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text')
}

/** Plain text of one message's content blocks. */
function textOfMessage(m: { content?: unknown }): string {
  const content = m.content
  if (!Array.isArray(content)) return String(content ?? '')
  return content
    .map((b) => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text'
      ? (b as { text?: string }).text ?? ''
      : '')
    .join('\n')
}

/** SHA-256 hex of a string — used to map a session id to a fixed-length,
 * filesystem-safe ledger filename (prevents path traversal via session id). */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

/** Control utterances route to the queue tools instead of being buffered. */
function isControlUtterance(text: string): boolean {
  const t = text.trim()
  return /^\/iq\b/i.test(t)
    || /^(开始|开始吧|开始执行|编译|批准|审批|暂停|继续|停止|终止|状态|进度)$/.test(t)
    || /^(start|compile|approve|pause|resume|abort|status|go)$/i.test(t)
}

/**
 * When the driver drops only its own stale envelope from a claimed batch,
 * restore the OTHER claimed messages to next-step so they are not lost
 * (goal-round-driver's restoreOtherClaimed pattern). `agent` must be the
 * live agent (its inbox has the pending queues).
 */
function restoreOtherClaimed(
  agent: AgentLike | undefined,
  messages: readonly { id?: string; content?: unknown; source?: { kind?: string; plugin?: string } }[],
  messageId: string,
): void {
  if (agent === undefined || agent.inbox?.prepend === undefined) return
  const retained = messages.filter((m) => m.id !== messageId
    && !(m.source?.kind === 'plugin' && m.source.plugin === 'dsh-instruction-queue'))
  for (const message of retained.toReversed()) {
    const inNextStep = (agent.inbox.nextStep ?? []).some((c) => c.id === message.id)
    const inNextTurn = (agent.inbox.nextTurn ?? []).some((c) => c.id === message.id)
    if (inNextStep || inNextTurn) continue
    agent.inbox.prepend('next-step', message)
  }
}

/**
 * Restore ONLY foreign (non-human, non-our-envelope) records from a claimed
 * batch back to next-step. Used when a mixed batch (foreign steering + human
 * delta + our envelope) must be rejected: the human delta is already buffered
 * in the ledger (must NOT re-enter the inbox), our envelope is dropped to let
 * the competing input win the turn, and only foreign records are preserved.
 * `human` is the set of human UserMessage objects already buffered.
 */
function restoreForeign(
  agent: AgentLike | undefined,
  messages: readonly { id?: string; source?: { kind?: string; plugin?: string } }[],
  human: readonly { id?: string }[],
): void {
  if (agent === undefined || agent.inbox?.prepend === undefined) return
  const humanIds = new Set(human.map((h) => h.id).filter((x): x is string => x !== undefined))
  const foreign = messages.filter((m) =>
    !(m.source?.kind === 'user')
    && !(m.source?.kind === 'plugin' && m.source.plugin === 'dsh-instruction-queue')
    && !(m.id !== undefined && humanIds.has(m.id)))
  for (const message of foreign.toReversed()) {
    if ((agent.inbox.nextStep ?? []).some((c) => c.id === message.id)) continue
    if ((agent.inbox.nextTurn ?? []).some((c) => c.id === message.id)) continue
    agent.inbox.prepend('next-step', message)
  }
}

/**
 * LIVE INTAKE delta: inputs the user added WHILE the plan was executing that
 * have not yet been consumed by any task (approved or proposed). These are the
 * "Pending Delta" merged at the reconciliation barrier — they do not touch the
 * immutable running attempt, and become PROPOSED obligations needing approval.
 */
export function pendingDeltaInputs(state: RunState): RawInput[] {
  const used = new Set<string>()
  for (const t of state.tasks) {
    for (const sid of t.source_input_ids) used.add(sid)
  }
  return state.inputs.filter((i) => !used.has(i.input_id))
}

/** Build the model-facing execution envelope for a dispatched task. */
function envelopeFor(task: Task, attemptId: string): {
  task: string
  intent_type: string
  targets: string[]
  acceptance_criteria: string[]
  hard_dependencies: string[]
  side_effect_class: string
  instruction: string
} {
  return {
    task: task.task,
    intent_type: task.intent_type,
    targets: task.targets,
    acceptance_criteria: task.acceptance_criteria.map((c) => c.text),
    hard_dependencies: task.hard_dependencies,
    side_effect_class: task.side_effect_class,
    instruction: `Execute exactly this segment in the main session. Do NOT advance other queue tasks. `
      + `After executing, call iq_reconcile with { task_id: "${task.task_id}", attempt_id: "${attemptId}", result: ... }.`,
  }
}

/** Build a full UserMessage with a FRESH id carrying the execution envelope. */
function buildEnvelopeMessage(task: Task, attemptId: string): {
  id: string
  content: { type: 'text'; text: string }[]
  source: { kind: 'plugin'; plugin: string }
} {
  const criteria = task.acceptance_criteria.map((c, i) => `${i + 1}. ${c.text}`).join('\n')
  const text = `[Instructions Queue] Execute the approved segment (${task.task_id}, attempt ${attemptId}).\n\n`
    + `TASK: ${task.task}\n`
    + `intent: ${task.intent_type} | targets: ${task.targets.join(', ')} | side-effect: ${task.side_effect_class}\n\n`
    + `ACCEPTANCE CRITERIA:\n${criteria}\n\n`
    + 'Execute exactly this task in the main session; do not advance other queue tasks. '
    + `When done, call iq_reconcile ONCE with { task_id: "${task.task_id}", attempt_id: "${attemptId}", result_summary, evidence, criteria }.`
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-instruction-queue' },
  })
  return {
    id: message.id,
    content: message.content,
    source: message.source,
  }
}

/**
 * Serialize a RunState for the client plan panel. Everything here is derived
 * from the ledger projection; the client never reads the raw ledger (which
 * may reference absolute paths / session internals).
 */
export function projectForClient(s: RunState): unknown {
  return {
    run_id: s.run_id,
    session_id: s.session_id,
    phase: s.phase,
    enabled: s.enabled,
    recovery_note: s.recovery_note,
    completed_at: s.completed_at,
    aborted_at: s.aborted_at,
    inputs: s.inputs.map((i) => ({ input_id: i.input_id, content: i.content, queue_sequence: i.queue_sequence })),
    tasks: s.tasks.map((t) => ({
      task_id: t.task_id,
      approval_status: t.approval_status,
      origin: t.origin,
      parent_task_id: t.parent_task_id,
      task: t.task,
      intent_type: t.intent_type,
      targets: t.targets,
      execution_status: t.execution_status,
      resolution_status: t.resolution_status,
      attempts: t.attempts.map((a) => ({
        attempt_id: a.attempt_id,
        status: a.status,
        side_effect_observed: a.side_effect_observed,
        evidence_ids: a.evidence_ids,
      })),
      acceptance_criteria: t.acceptance_criteria.map((c) => ({ criterion_id: c.criterion_id, text: c.text })),
      side_effect_class: t.side_effect_class,
      hard_dependencies: t.hard_dependencies,
      soft_affinities: t.soft_affinities,
      approved_task_revision: t.approved_task_revision,
      criteria_met: t.coverage.criteria_met,
      resolution: t.resolution_status,
    })),
    conflicts: s.conflicts,
    dependency_cycles: s.dependency_cycles,
    ambiguities: s.ambiguities,
  }
}
