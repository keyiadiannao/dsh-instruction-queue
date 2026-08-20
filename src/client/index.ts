/**
 * dsh-instruction-queue browser half.
 *
 * Renders the persistent plan as a right-side collapsible panel:
 *  - painelless state flows through the official `details` column slot
 *    (a right-side column that `ctx.layout` opens/closes); we shadow the
 *    built-in DetailsPanel at priority -10.
 *  - a per-session "计划" button is added to the official
 *    `conversation.session.header.actions` slot; clicking it calls
 *    `ctx.layout.openDetails()`.
 *  - data is fetched from the host API
 *    `/api/dsh-instruction-queue/status?sessionId=...` (loopback-only).
 *
 * @module dsh-instruction-queue/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { PlanPanel } from './PlanPanel.tsx'
import { PlanButton } from './PlanButton.tsx'
import { PlanRail } from './PlanRail.tsx'

/** Required services. */
export const inject = ['slots', 'layout']

/**
 * Self-contained view of the DSH slot contracts we register into, so the
 * standalone typecheck (which cannot see the host DSH SlotMap extension)
 * still typechecks. Mirrors the declarations the host packages actually make.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'details': {
      kind: 'single'
      scope: 'session'
      owner: {
        session: { id?: string; running?: boolean }
      }
    }
    'conversation.session.header.actions': {
      kind: 'list'
      scope: 'session'
      owner: {
        session: { id?: string; running?: boolean }
      }
    }
    /** Frame-wide floating layer above every column (additive). */
    'shell.overlay': {
      kind: 'list'
      scope: 'root'
      owner: Record<string, unknown>
    }
  }
}

/**
 * Host wire types we rely on (kept loose so the standalone build stays clean).
 */
interface LayoutLike {
  openDetails(): void
  closeDetails(): void
}

interface CtxLike {
  slots: {
    inject(name: string, cb: () => unknown): unknown
    register(spec: {
      name: string
      id?: string
      order?: number
      priority?: number
      locale?: string
      inject?: () => Record<string, unknown>
      children?: Record<string, unknown>
    }, component: unknown): unknown
  }
  layout: LayoutLike
}

export function apply(ctx: ClientContext): void {
  const services = ctx as unknown as CtxLike

  // Right-side plan panel (details column; shadows built-in DetailsPanel).
  // priority -10 < built-in 0 → ours wins when the column opens.
  services.slots.inject('details', () =>
    services.slots.register({
      name: 'details',
      priority: -10,
      locale: 'instructions.queue',
      inject: () => ({ closeDetails: () => services.layout.closeDetails() }),
    }, PlanPanel),
  )

  // Right-top header button to open the plan panel.
  services.slots.inject('conversation.session.header.actions', () =>
    services.slots.register({
      name: 'conversation.session.header.actions',
      id: 'iq-plan-button',
      order: 100,
      locale: 'instructions.queue',
      inject: () => ({ openDetails: () => services.layout.openDetails() }),
    }, PlanButton),
  )

  // Persistent right-side rail (frame-wide additive layer): always-visible
  // strip to open the plan panel even when details is collapsed.
  services.slots.inject('shell.overlay', () =>
    services.slots.register({
      name: 'shell.overlay',
      id: 'iq-plan-rail',
      order: 1000,
      locale: 'instructions.queue',
      inject: () => ({ openDetails: () => services.layout.openDetails() }),
    }, PlanRail),
  )
}
