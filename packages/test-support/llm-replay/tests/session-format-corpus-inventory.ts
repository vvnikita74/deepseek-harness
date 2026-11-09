/** Exact historical conversion refusals; current-generation fixtures never qualify. */
export const expectedUnsupported: Readonly<Partial<Record<string, { sourceVersion: number; reason: string }>>> = {
  'packages/test-support/session-snapshot/tests/fixtures/suite/pin-turn/session.v2.jsonl': {
    sourceVersion: 2,
    reason: 'session snapshot line 3: format v2 changed request prompt outside an open step cannot retain source chronology',
  },
  'packages/test-support/session-snapshot/tests/fixtures/suite/plain-turn/session.1.v2.jsonl': {
    sourceVersion: 2,
    reason: 'session snapshot line 3: format v2 changed request prompt outside an open step cannot retain source chronology',
  },
  'packages/test-support/session-snapshot/tests/fixtures/suite/plain-turn/session.v2.jsonl': {
    sourceVersion: 2,
    reason: 'session snapshot line 3: format v2 changed request prompt outside an open step cannot retain source chronology',
  },
  'packages/test-support/session-snapshot/tests/fixtures/suite/shared-pin/session.v2.jsonl': {
    sourceVersion: 2,
    reason: 'session snapshot line 3: format v2 changed request prompt outside an open step cannot retain source chronology',
  },
  // This recording contains an event absent from the released V2 event inventory.
}

/** Headerless snapshot-harness protocol examples, not released Session artifacts. */
export const unversionedProtocolFixtures = new Set([
  'packages/test-support/session-snapshot/tests/fixtures/record-suite/rec-child/session.1.jsonl',
  'packages/test-support/session-snapshot/tests/fixtures/record-suite/rec-child/session.jsonl',
  'packages/test-support/session-snapshot/tests/fixtures/record-suite/rec-pin/session.1.jsonl',
  'packages/test-support/session-snapshot/tests/fixtures/record-suite/rec-pin/session.jsonl',
  'packages/test-support/session-snapshot/tests/fixtures/record-suite/rec-skip/session.jsonl',
  'packages/test-support/session-snapshot/tests/fixtures/suite/authored-error/session.jsonl',
  'packages/test-support/session-snapshot/tests/fixtures/suite/blocked-log/session.jsonl',
  'packages/test-support/session-snapshot/tests/fixtures/suite/no-model/session.jsonl',
  'packages/test-support/session-snapshot/tests/fixtures/suite/pin-turn/session.jsonl',
  'packages/test-support/session-snapshot/tests/fixtures/suite/plain-turn/session.1.jsonl',
  'packages/test-support/session-snapshot/tests/fixtures/suite/plain-turn/session.jsonl',
  'packages/test-support/session-snapshot/tests/fixtures/suite/shared-pin/session.jsonl',
])
