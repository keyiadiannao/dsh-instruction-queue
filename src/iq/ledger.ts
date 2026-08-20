/**
 * dsh-instruction-queue — append-only ledger persistence.
 *
 * The ledger is a single ndjson file per run: each line is one JSON event.
 * Writes are append-only and each batch is committed DURABLY: the batch is
 * written to a temp file, fsync'd, then renamed over the live file (atomic on
 * POSIX and on Windows via MoveFileEx replacement semantics). A crash before
 * the rename leaves the previous durable state intact; a crash mid-append can
 * only tear the temp file, never the live ledger. Recovery reads the file,
 * replays through the pure reducer, and reconciles the tail (see recovery.ts).
 * A torn tail line in the live file (defensive) is tolerated: the event was
 * never durably committed.
 *
 * @module dsh-instruction-queue/iq/ledger
 */

import { existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, closeSync, fsyncSync } from 'node:fs'
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

/**
 * Appends one event batch durably.
 *
 * Durability protocol (matches the file's contract):
 *  1. copy current file → `${file}.tmp`
 *  2. append the batch to the tmp file
 *  3. fsync the tmp file (flush to disk)
 *  4. rename tmp over the live file (atomic swap)
 *
 * A crash anywhere before step 4 leaves the previous committed state intact
 * (the live file is untouched until the rename). This is a batch commit, not
 * a bare append — the cost is one file copy per tool call, acceptable for a
 * low-frequency orchestration ledger.
 */
export function appendEvents(file: string, events: readonly IQEvent[]): void {
  if (events.length === 0) return
  mkdirSync(dirname(file), { recursive: true })
  const block = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  const tmp = `${file}.tmp`

  const prior = existsSync(file) ? readFileSync(file, 'utf8') : ''
  // Write the full prior content + the new batch into the temp file.
  writeFileSync(tmp, prior + block, 'utf8')

  // fsync the temp file so its contents are durable before the rename.
  const fd = openSync(tmp, 'r+')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }

  // Atomic swap: readers either see the old complete ledger or the new one.
  renameSync(tmp, file)
}

/** Assign sequential seq numbers to a batch starting after the ledger tail. */
export function assignSeqs(events: readonly IQEvent[], nextSeq: number): IQEvent[] {
  return events.map((e, i) => ({ ...e, seq: nextSeq + i }) as IQEvent)
}
