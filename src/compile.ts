/**
 * dsh-instruction-queue — compiler (semantic judgment only, no state truth).
 *
 * Reads the buffered raw inputs and produces a PROPOSED obligation queue:
 * atomic intent extraction → dedupe/conflict analysis (supersession vs
 * contradiction) → dependency graph → grouping/ordering. Output must be
 * strict JSON matching CompiledQueueShape; anything else is a failed compile
 * (the caller keeps the queue in compiling/collecting state, nothing runs).
 *
 * @module dsh-instruction-queue/compile
 */

import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Config } from './index.ts'
import { validateCompileOutput } from './iq/schema.ts'
import type { RunState } from './iq/types.ts'

/** The JSON shape the compiler must produce. */
export interface CompileOutput {
  tasks: {
    task_id: string
    source_input_ids: string[]
    task: string
    intent_type: 'inspect' | 'modify' | 'decide' | 'verify' | 'explain'
    targets: string[]
    acceptance_criteria: { criterion_id: string; text: string }[]
    side_effect_class: 'read' | 'write' | 'external' | 'irreversible'
    hard_dependencies: string[]
    soft_affinities: string[]
  }[]
  conflicts: { kind: 'supersedes' | 'contradicts'; from_input_id: string; to_input_id: string; note: string }[]
  dependency_cycles: string[][]
  ambiguities: { input_ids: string[]; note: string }[]
}

export interface CompiledQueue extends CompileOutput {
  consumed_input_sequences: number[]
}

const COMPILE_INSTRUCTION = `You are the instruction-queue compiler.

You are given the raw instruction segments a user queued (in order). They may be
fragments of one task, several unrelated tasks, corrections, or supersessions.

Compile them into a PROPOSED obligation queue:

1. ATOMIC INTENTS: split and merge. One message may contain 3 tasks; 5 messages
   may describe 1 task. Each output task must be one atomic, executable intent.
2. CONFLICTS ≠ DUPLICATES: "use SQLite" then "switch to Postgres" is a
   SUPERSESSION, not a duplicate. Do not silently pick the later one; emit a
   conflict of kind "supersedes" (from = earlier input, to = later input).
   Genuine contradictions that cannot be resolved by recency are
   kind "contradicts".
3. ACCEPTANCE CRITERIA: every task MUST carry concrete, checkable acceptance
   criteria (each with a short stable criterion_id like "AC1"). These are what
   coverage is judged against — not similarity to the task text.
4. DEPENDENCIES: hard_dependencies ONLY for real needs (B needs A's result).
   Put mere co-location in soft_affinities instead.
5. SIDE-EFFECT CLASS: read = no workspace change; write = local changes;
   external = network/outside effects; irreversible = destructive/non-undoable.
6. ORDERING: hard dependencies → safety/irreversibility → information before
   action → user's explicit order → context locality → input order as the
   stable tie-breaker. You produce the ordered task list; the executor runs it
   topologically anyway.
7. CYCLES: if hard dependencies form a cycle, list it in dependency_cycles and
   still emit the tasks (the runner will refuse to dispatch until resolved).
8. AMBIGUITIES: anything you could not resolve silently, list with the input ids.

Rules:
- Never invent requirements the user did not state.
- Never merge two tasks whose criteria would become untestable.
- Output ONLY strict JSON matching this exact shape (no markdown, no preamble):
{
  "tasks": [
    {
      "task_id": "T1",
      "source_input_ids": ["IN1"],
      "task": "one sentence, directly executable",
      "intent_type": "inspect|modify|decide|verify|explain",
      "targets": ["file/module/feature/question"],
      "acceptance_criteria": [{ "criterion_id": "AC1", "text": "checkable criterion" }],
      "side_effect_class": "read|write|external|irreversible",
      "hard_dependencies": [],
      "soft_affinities": []
    }
  ],
  "conflicts": [{ "kind": "supersedes|contradicts", "from_input_id": "IN2", "to_input_id": "IN7", "note": "..." }],
  "dependency_cycles": [["T1", "T2"]],
  "ambiguities": [{ "input_ids": ["IN3"], "note": "..." }]
}
`

/** Extract plain text from a content block array. */
function textOf(m: { content?: unknown }): string {
  const content = m.content
  if (!Array.isArray(content)) return String(content ?? '')
  return content
    .map((b) => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text'
      ? (b as { text?: string }).text ?? ''
      : '')
    .join('\n')
}

function localeDirective(locale: string | undefined): string {
  if (locale === 'zh') return 'Simplified Chinese (中文)'
  if (locale === 'en') return 'English'
  return 'the same language as the user\'s messages'
}

/**
 * Run the compile LLM call. Returns the compiled queue, or null on failure
 * (never throws into the tool — a null keeps the queue un-compiled).
 */
export async function compileQueue(
  ctx: any,
  agent: any,
  state: RunState,
  config: Config,
  locale?: string,
): Promise<CompiledQueue | null> {
  try {
    const target = resolveTarget(ctx, agent, config)
    if (target === undefined) {
      // eslint-disable-next-line no-console
      console.log('[dsh-instruction-queue] compile: no provider/model')
      return null
    }
    const blocks = state.inputs.map((i) => `[${i.input_id}]\n${i.content}`).join('\n\n')
    const prompt = createUserMessage({
      content: [{
        type: 'text',
        text: `${COMPILE_INSTRUCTION}\nLanguage: write task text and criteria in ${localeDirective(locale)}.\n\nQUEUED INPUTS (in order):\n${blocks}`,
      }],
      source: { kind: 'user' },
    })
    const assembler = new BlockAssembler()
    const options = {
      provider: target.provider,
      model: target.model,
      messages: [prompt],
      maxTokens: 4000,
      sessionId: state.session_id,
      purpose: 'compaction' as const, // closest registered auxiliary purpose
    }
    for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
    const text = assembler.blocks()
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text?: string }).text ?? '')
      .join('')
      .trim()
    if (text.length === 0) return null
    // Strip any accidental code fences.
    const cleaned = text.replace(/^```(?:json)?/m, '').replace(/```$/m, '').trim()
    const parsed = JSON.parse(cleaned) as CompileOutput
    // Schema firewall: the LLM does not own state truth. A malformed object
    // is treated as a failed compile (zero loss — inputs stay buffered).
    const errors = validateCompileOutput(parsed, state)
    if (errors.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[dsh-instruction-queue] compile schema rejected:\n  ${errors.join('\n  ')}`)
      return null
    }
    const consumed = state.inputs.map((i) => i.queue_sequence)
    return { ...parsed, consumed_input_sequences: consumed }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log(`[dsh-instruction-queue] compile error: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

/** Resolve the LLM target: config override → session requestHeader → agent options. */
export function resolveTarget(ctx: any, agent: any, config: Config): { provider: string; model: string } | undefined {
  if (config.llmProvider.length > 0 && config.llmModel.length > 0) {
    return { provider: config.llmProvider, model: config.llmModel }
  }
  const latest = agent?.session?.requestHeader?.()?.config
  if (latest?.provider !== undefined && latest?.model !== undefined) {
    return { provider: latest.provider, model: latest.model }
  }
  if (agent?.options?.provider !== undefined && agent?.options?.model !== undefined) {
    return { provider: agent.options.provider, model: agent.options.model }
  }
  return undefined
}

export { textOf, localeDirective }
