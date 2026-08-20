/**
 * dsh-instruction-queue — right-side persistent narrow rail.
 *
 * Lives in the frame-wide `shell.overlay` additive layer. It is a thin,
 * always-visible vertical strip pinned to the right edge of the viewport so
 * the plan surface stays reachable even while the `details` column is closed
 * (details collapses to width 0 — unlike the left sidebar there is no native
 * right rail). Clicking it opens the details column (the plan panel).
 *
 * Uses inline styles with pointer-events re-enabled (shell.overlay is
 * click-through by default).
 */

interface PlanRailProps {
  openDetails?: () => void
  /** Bumping badge: unread/active count, when supplied. */
  count?: number
}

export function PlanRail({ openDetails, count }: PlanRailProps): JSX.Element {
  return (
    <div style={railStyle} onClick={openDetails} role="button" tabIndex={0}
      aria-label="Open instruction queue plan"
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetails?.() } }}>
      <div style={iconStyle} title="Instruction Queue plan">▤</div>
      {count !== undefined && count > 0 && (
        <div style={badgeStyle}>{count}</div>
      )}
      <div style={labelStyle}>计划</div>
    </div>
  )
}

const railStyle: React.CSSProperties = {
  position: 'fixed', right: 0, top: '50%', transform: 'translateY(-50%)',
  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
  width: 26, padding: '8px 2px', cursor: 'pointer', zIndex: 100,
  background: '#2a2a2a', borderTopLeftRadius: 8, borderBottomLeftRadius: 8,
  border: '1px solid #333', borderRight: 'none', pointerEvents: 'auto',
  color: '#ddd', opacity: 0.82,
}
const iconStyle: React.CSSProperties = { fontSize: 14, lineHeight: 1 }
const labelStyle: React.CSSProperties = {
  writingMode: 'vertical-rl', textOrientation: 'mixed',
  fontSize: 10, color: '#aaa', letterSpacing: 1,
}
const badgeStyle: React.CSSProperties = {
  background: '#ef4444', color: '#fff', borderRadius: 8, minWidth: 16,
  height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 10, padding: '0 3px',
}

export default PlanRail
