/**
 * dsh-instruction-queue — right-top button to open the plan panel.
 * Lives in the official `conversation.session.header.actions` slot.
 */

interface PlanButtonProps {
  openDetails?: () => void
}

export function PlanButton({ openDetails }: PlanButtonProps): JSX.Element {
  return (
    <button
      type="button"
      onClick={openDetails}
      title="Open Instructions Queue panel"
      style={{
        background: 'none', border: '1px solid #444', color: '#ddd', cursor: 'pointer',
        borderRadius: 6, padding: '3px 8px', fontSize: 12, lineHeight: 1.4,
      }}
    >
      ▤ 计划
    </button>
  )
}

export default PlanButton
