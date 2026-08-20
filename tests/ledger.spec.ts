/**
 * Ledger tests: append-only ndjson persistence + torn-tail tolerance.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { IQEvent } from '../src/iq/events.ts'
import { appendEvents, assignSeqs, loadLedger } from '../src/iq/ledger.ts'

let dirs: string[] = []
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'iq-ledger-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

describe('ledger persistence', () => {
  it('missing file loads as empty', () => {
    expect(loadLedger(join(tmpDir(), 'none.ndjson'))).toEqual([])
  })

  it('round-trips events with seq assignment', () => {
    const file = join(tmpDir(), 'r.ndjson')
    const evts = assignSeqs([
      { kind: 'IQ_ENABLED', seq: -1, run_id: 'R1', ts: 't', session_id: 's' },
      { kind: 'INPUT_BUFFERED', seq: -1, run_id: 'R1', ts: 't', input_id: 'IN1', content: 'x', queue_sequence: 1, last_visible_event_id: null, session_id: 's' },
    ] as IQEvent[], 0)
    expect(evts.map((e) => e.seq)).toEqual([0, 1])
    appendEvents(file, evts)
    appendEvents(file, assignSeqs([
      { kind: 'COMPILE_REQUESTED', seq: -1, run_id: 'R1', ts: 't', input_sequences: [1] },
    ] as IQEvent[], 2))
    const loaded = loadLedger(file)
    expect(loaded).toHaveLength(3)
    expect(loaded[2]!.kind).toBe('COMPILE_REQUESTED')
    expect(loaded[2]!.seq).toBe(2)
  })

  it('tolerates a torn tail line (crash mid-append)', () => {
    const file = join(tmpDir(), 'r.ndjson')
    appendEvents(file, [{ kind: 'IQ_ENABLED', seq: 0, run_id: 'R1', ts: 't', session_id: 's' } as IQEvent])
    // Simulate a crash: partial JSON line appended without a newline.
    const fs = require('node:fs')
    fs.appendFileSync(file, '{"kind":"INPUT_BUFFERED","seq":1,"run_id":')
    const loaded = loadLedger(file)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.kind).toBe('IQ_ENABLED')
  })

  it('is append-only: rewrite never touches prior lines', () => {
    const file = join(tmpDir(), 'r.ndjson')
    appendEvents(file, [{ kind: 'IQ_ENABLED', seq: 0, run_id: 'R1', ts: 't', session_id: 's' } as IQEvent])
    appendEvents(file, [{ kind: 'RUN_ABORTED', seq: 1, run_id: 'R1', ts: 't', note: null } as IQEvent])
    const raw = readFileSync(file, 'utf8')
    const lines = raw.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('IQ_ENABLED')
    expect(lines[1]).toContain('RUN_ABORTED')
  })
})
