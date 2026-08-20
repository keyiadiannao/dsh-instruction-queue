/**
 * dsh-instruction-queue — right-side plan panel (details slot occupant).
 *
 * Fetches the run's plan projection from the host API and renders: phase,
 * buffered inputs, obligations (with acceptance criteria / resolvement),
 * residual/expansion, conflicts, dependency cycles, ambiguities.
 *
 * Uses inline styles (no CSS module) to keep the client bundle lean.
 */

import { useEffect, useState } from 'react'

interface PlanEvidenceRef {
  criterion_id: string
  evidence_refs: string[]
}

interface PlanTask {
  task_id: string
  approval_status: string
  origin: string
  parent_task_id: string | null
  task: string
  intent_type: string
  targets: string[]
  execution_status: string
  resolution_status: string
  side_effect_class: string
  hard_dependencies: string[]
  soft_affinities: string[]
  approved_task_revision: number | null
  criteria_met: PlanEvidenceRef[]
  acceptance_criteria: { criterion_id: string; text: string }[]
}

interface PlanInput {
  input_id: string
  content: string
  queue_sequence: number
}

interface PlanState {
  run_id: string
  phase: string
  enabled: boolean
  recovery_note: string | null
  inputs: PlanInput[]
  tasks: PlanTask[]
  conflicts: { kind: string; from_input_id: string; to_input_id: string; note: string }[]
  dependency_cycles: string[][]
  ambiguities: { input_ids: string[]; note: string }[]
}

interface StatusResponse {
  ok: boolean
  active: boolean
  state?: PlanState
}

const BADGE: Record<string, { color: string; label: string }> = {
  satisfied: { color: '#22c55e', label: '✓ satisfied' },
  covered: { color: '#22c55e', label: '✓ covered' },
  skipped: { color: '#a3a3a3', label: '– skipped' },
  partial: { color: '#f59e0b', label: '◐ partial' },
  open: { color: '#3b82f6', label: '○ open' },
  blocked: { color: '#ef4444', label: '⊘ blocked' },
}

const ORIGIN: Record<string, string> = {
  approved: 'approved',
  residual: 'residual',
  proposed_expansion: 'expansion',
}

const PHASE_LABEL: Record<string, string> = {
  idle: 'idle', collecting: 'collecting', compiling: 'compiling',
  awaiting_approval: 'awaiting approval', ready: 'ready', executing: 'executing',
  reconciling: 'reconciling', completing: 'completing', completed: 'completed',
  paused: 'paused', blocked: 'blocked', aborted: 'aborted', recovery_required: 'recovery required',
}

/** Locale-capable props: framework-injected session scope + our injected close. */
interface PlanPanelProps {
  sessionId?: string
  useSession?: (s: (x: unknown) => unknown) => unknown
  closeDetails?: () => void
}

export function PlanPanel({ sessionId, closeDetails }: PlanPanelProps): JSX.Element {
  const [data, setData] = useState<StatusResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    fetch(`/api/dsh-instruction-queue/status?sessionId=${encodeURIComponent(sessionId)}`)
      .then((r) => r.json() as Promise<StatusResponse>)
      .then((d) => { if (!cancelled) { setData(d); setError(null) } })
      .catch((e) => { if (!cancelled) setError(String(e)) })
    // Poll every 3s to reflect execution/reconcile progress.
    const t = setInterval(() => {
      if (cancelled) return
      fetch(`/api/dsh-instruction-queue/status?sessionId=${encodeURIComponent(sessionId)}`)
        .then((r) => r.json() as Promise<StatusResponse>)
        .then((d) => { if (!cancelled) setData(d) })
        .catch(() => { /* keep last */ })
    }, 3000)
    return () => { cancelled = true; clearInterval(t) }
  }, [sessionId])

  const st = data?.state
  return (
    <aside style={rootStyle}>
      <header style={headerStyle}>
        <strong style={titleStyle}>Instructions Queue</strong>
        <button type="button" onClick={closeDetails} aria-label="close"
          style={closeBtnStyle}>✕</button>
      </header>

      {error && <div style={errorStyle}>{error}</div>}
      {!data && !error && <div style={mutedStyle}>loading…</div>}
      {data && !data.active && <div style={mutedStyle}>No active queue run. Enable with /iq.</div>}

      {st && (
        <>
          <div style={phaseBarStyle}>
            phase: <strong>{PHASE_LABEL[st.phase] ?? st.phase}</strong>
            {st.recovery_note && <div style={warnStyle}>⚠ {st.recovery_note}</div>}
          </div>

          <Section title={`Buffered inputs (${st.inputs.length})`}>
            {st.inputs.length === 0 && <div style={mutedStyle}>none</div>}
            {st.inputs.map((i) => (
              <div key={i.input_id} style={rowStyle}>
                <span style={tagStyle}>{i.input_id}</span>
                <span style={textStyle}>{i.content}</span>
              </div>
            ))}
          </Section>

          <Section title={`Obligations (${st.tasks.length})`}>
            {st.tasks.length === 0 && <div style={mutedStyle}>none compiled yet</div>}
            {st.tasks.map((t) => (
              <div key={t.task_id} style={taskStyle}>
                <div style={taskHeadStyle}>
                  <span style={taskTitleStyle}>
                    {t.task_id}
                    <span style={originStyle}> {ORIGIN[t.origin] ?? t.origin}</span>
                  </span>
                  {BADGE[t.resolution_status] && (
                    <span style={{ ...badgeStyle, color: BADGE[t.resolution_status]!.color }}>
                      {BADGE[t.resolution_status]!.label}
                    </span>
                  )}
                </div>
                <div style={textStyle}>{t.task}</div>
                {(t.approved_task_revision !== null) && (
                  <div style={mutedSmallStyle}>approved rev {t.approved_task_revision} · {t.execution_status}</div>
                )}
                {t.hard_dependencies.length > 0 && (
                  <div style={mutedSmallStyle}>depends: {t.hard_dependencies.join(', ')}</div>
                )}
                {t.acceptance_criteria.length > 0 && (
                  <div style={acStyle}>
                    {t.acceptance_criteria.map((c) => {
                      const met = t.criteria_met?.some((m) => m.criterion_id === c.criterion_id)
                      return (
                        <div key={c.criterion_id} style={acRowStyle}>
                          <span style={{ color: met ? '#22c55e' : '#a3a3a3' }}>{met ? '✓' : '○'}</span>
                          <span style={mutedSmallStyle}>{c.text}</span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            ))}
          </Section>

          {st.conflicts?.length > 0 && (
            <Section title="Conflicts">
              {st.conflicts.map((c, idx) => (
                <div key={idx} style={warnRowStyle}>
                  {c.from_input_id} {c.kind === 'supersedes' ? '≺' : '≠'} {c.to_input_id} — {c.note}
                </div>
              ))}
            </Section>
          )}
          {st.dependency_cycles?.length > 0 && (
            <Section title="⚠ dependency cycles">
              {st.dependency_cycles.map((c, idx) => (
                <div key={idx} style={warnRowStyle}>{c.join(' → ')}</div>
              ))}
            </Section>
          )}
          {st.ambiguities?.length > 0 && (
            <Section title="Ambiguities">
              {st.ambiguities.map((a, idx) => (
                <div key={idx} style={mutedSmallStyle}>{a.input_ids.join(', ')}: {a.note}</div>
              ))}
            </Section>
          )}
        </>
      )}
    </aside>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div style={sectionStyle}>
      <div style={sectionTitleStyle}>{title}</div>
      {children}
    </div>
  )
}

// ── inline styles ──────────────────────────────────────────────────────────
const rootStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', height: '100%', overflow: 'auto',
  padding: '12px 14px', fontSize: 13, color: '#e5e5e5', background: '#1e1e1e',
  boxSizing: 'border-box',
}
const headerStyle: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  marginBottom: 10, borderBottom: '1px solid #333', paddingBottom: 8,
}
const titleStyle: React.CSSProperties = { fontSize: 14 }
const closeBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: 14,
}
const phaseBarStyle: React.CSSProperties = {
  padding: '6px 8px', borderRadius: 6, background: '#2a2a2a', marginBottom: 12,
}
const sectionStyle: React.CSSProperties = { marginBottom: 14 }
const sectionTitleStyle: React.CSSProperties = {
  fontWeight: 600, marginBottom: 6, color: '#bbb', fontSize: 12, textTransform: 'uppercase',
  letterSpacing: 0.5,
}
const rowStyle: React.CSSProperties = {
  display: 'flex', gap: 6, alignItems: 'flex-start', padding: '2px 0',
}
const tagStyle: React.CSSProperties = {
  background: '#333', borderRadius: 4, padding: '0 4px', fontSize: 11, color: '#8ab4f8',
  flexShrink: 0,
}
const taskStyle: React.CSSProperties = {
  border: '1px solid #333', borderRadius: 6, padding: '6px 8px', marginBottom: 6,
  background: '#242424',
}
const taskHeadStyle: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3,
}
const taskTitleStyle: React.CSSProperties = { fontWeight: 600 }
const originStyle: React.CSSProperties = { fontSize: 11, color: '#888', fontWeight: 400 }
const badgeStyle: React.CSSProperties = { fontSize: 11, fontWeight: 600 }
const textStyle: React.CSSProperties = { whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
const mutedStyle: React.CSSProperties = { color: '#888', fontStyle: 'italic' }
const mutedSmallStyle: React.CSSProperties = { color: '#aaa', fontSize: 12 }
const warnStyle: React.CSSProperties = { color: '#f59e0b', marginTop: 4 }
const warnRowStyle: React.CSSProperties = { color: '#f59e0b', fontSize: 12 }
const errorStyle: React.CSSProperties = { color: '#ef4444', marginTop: 8 }
const acStyle: React.CSSProperties = { marginTop: 4, borderTop: '1px solid #333', paddingTop: 4 }
const acRowStyle: React.CSSProperties = { display: 'flex', gap: 6, alignItems: 'center' }

export default PlanPanel
