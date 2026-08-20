/**
 * dsh-instruction-queue — append-only ledger persistence.
 *
 * The ledger is a single ndjson file per run: each line is one JSON event.
 * Writes are append-only with an fsync'd temp+rename per batch so a crash
 * never rewrites history; recovery reads the file, replays through the pure
 * reducer, and reconciles the tail (see recovery.ts). A torn tail line (crash
 * mid-append) is tolerated: the event was never durably committed.
 *
 * @module dsh-instruction-queue/iq/ledger
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { IQEvent } from './events.ts'

/** Loads a ledger file as parsed events (empty array when missing). */
export function loadLedger(file: string): IQEvent[] {
  if (!existsSync(file)) return []
  const raw = readFileSync(file, 'utf8')
  const events: IQEvent[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      events.push(JSON.parse(trimmed) as IQEvent)
    } catch {
      // Torn tail line — stop; recovery treats the ledger as ending here.
      break
    }
  }
  return events
}

/** Appends one event batch durably. Append-only: nothing is ever rewritten. */
export function appendEvents(file: string, events: readonly IQEvent[]): void {
  if (events.length === 0) return
  mkdirSync(dirname(file), { recursive: true })
  const block = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  appendFileSync(file, block, 'utf8')
}

/** Assign sequential seq numbers to a batch starting after the ledger tail. */
export function assignSeqs(events: readonly IQEvent[], nextSeq: number): IQEvent[] {
  return events.map((e, i) => ({ ...e, seq: nextSeq + i }) as IQEvent)
}
