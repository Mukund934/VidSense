import { describe, expect, it } from 'vitest'
import {
  MAX_LABEL_CHARS,
  MAX_NOTE_CHARS,
  VALIDATION_MESSAGE,
  validate,
  type NewAnnotation,
} from '@/data/annotations'

const note = (over: Partial<NewAnnotation> = {}): NewAnnotation => ({
  kind: 'note',
  videoId: 'dQw4w9WgXcQ',
  tMs: 65_000,
  text: 'worth revisiting',
  ...over,
})

describe('validate', () => {
  it('accepts an ordinary note', () => {
    expect(validate(note())).toBeNull()
  })

  it('accepts a bookmark with no label', () => {
    expect(validate(note({ kind: 'bookmark', text: '' }))).toBeNull()
  })

  it('accepts a mark at the very start', () => {
    expect(validate(note({ tMs: 0 }))).toBeNull()
  })

  describe('refuses what the rules would reject anyway', () => {
    // Firestore would deny these, but a denied write surfaces as "permission
    // denied", which tells a user nothing about the note they just lost.
    it('rejects an unknown kind', () => {
      expect(validate(note({ kind: 'scribble' as never }))).toBe('bad_kind')
    })

    it.each([
      ['a path segment', 'users/alice'],
      ['too short', 'abc'],
      ['empty', ''],
      ['traversal', '../../etc'],
    ])('rejects %s as a video id', (_label, videoId) => {
      expect(validate(note({ videoId }))).toBe('bad_video')
    })

    it.each([
      ['negative', -1],
      ['fractional', 1000.5],
      ['not a number', Number.NaN],
    ])('rejects %s time', (_label, tMs) => {
      expect(validate(note({ tMs }))).toBe('bad_time')
    })

    it('rejects an empty note but suggests the alternative', () => {
      expect(validate(note({ text: '   ' }))).toBe('empty_note')
      expect(VALIDATION_MESSAGE.empty_note).toMatch(/bookmark instead/i)
    })

    it('rejects a note past the cap', () => {
      expect(validate(note({ text: 'x'.repeat(MAX_NOTE_CHARS + 1) }))).toBe('too_long')
    })

    it('rejects a bookmark label past its own, smaller cap', () => {
      const label = 'x'.repeat(MAX_LABEL_CHARS + 1)
      expect(validate(note({ kind: 'bookmark', text: label }))).toBe('too_long')
      // A note of the same length is fine — the caps differ on purpose.
      expect(validate(note({ text: label }))).toBeNull()
    })
  })

  it('has a human sentence for every failure', () => {
    for (const message of Object.values(VALIDATION_MESSAGE)) {
      expect(message.length).toBeGreaterThan(10)
      expect(message).toMatch(/[.!]$/)
    }
  })
})
