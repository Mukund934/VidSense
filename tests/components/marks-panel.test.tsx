// @vitest-environment jsdom

/**
 * The marks panel.
 *
 * Its one distinctive claim is that these timestamps are exact — they come
 * from the player clock, not from a model-written transcript — so it offers a
 * plain jump with no precision caveat. That is only honest if the panel really
 * does send the current player position, which is the first thing tested here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { MarksPanel } from '@/components/marks-panel'
import type { Annotation } from '@/data/annotations'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

const mark = (over: Partial<Annotation> = {}): Annotation => ({
  id: 'a1',
  kind: 'note',
  videoId: 'dQw4w9WgXcQ',
  tMs: 65_000,
  text: 'worth revisiting',
  createdAt: 1,
  ...over,
})

function jsonOnce(body: unknown, ok = true, status = 200) {
  fetchMock.mockResolvedValueOnce({ ok, status, json: async () => body })
}

beforeEach(() => fetchMock.mockReset())
afterEach(cleanup)

const panel = (currentMs = 0, onSeek = vi.fn()) =>
  render(<MarksPanel videoId="dQw4w9WgXcQ" currentMs={currentMs} onSeek={onSeek} />)

describe('MarksPanel', () => {
  it('explains what marks are when there are none', async () => {
    jsonOnce({ annotations: [] })
    panel()
    expect(await screen.findByText(/nothing marked yet/i)).toBeTruthy()
    expect(screen.getByText(/land on the exact second/i)).toBeTruthy()
  })

  it('lists existing marks in video order', async () => {
    jsonOnce({
      annotations: [mark({ id: 'a', tMs: 10_000, text: 'first' }), mark({ id: 'b', tMs: 90_000, text: 'second' })],
    })
    panel()
    expect(await screen.findByText('first')).toBeTruthy()
    expect(screen.getByText('0:10')).toBeTruthy()
    expect(screen.getByText('1:30')).toBeTruthy()
  })

  it('names an unlabelled bookmark rather than showing an empty row', async () => {
    jsonOnce({ annotations: [mark({ kind: 'bookmark', text: '' })] })
    panel()
    expect(await screen.findByText(/bookmarked moment/i)).toBeTruthy()
  })

  it('offers the current player position as the note prompt', async () => {
    jsonOnce({ annotations: [] })
    panel(125_000)
    await waitFor(() => expect(screen.getByPlaceholderText('Note at 2:05')).toBeTruthy())
  })

  it('saves a note against the exact player position', async () => {
    jsonOnce({ annotations: [] })
    panel(65_000)
    await screen.findByText(/nothing marked yet/i)

    jsonOnce({ annotation: mark({ text: 'a thought' }) }, true, 201)
    await userEvent.type(screen.getByLabelText(/write a note/i), 'a thought')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    const [, init] = fetchMock.mock.calls[1]!
    expect(JSON.parse((init as { body: string }).body)).toMatchObject({
      kind: 'note',
      tMs: 65_000,
      text: 'a thought',
    })
    expect(await screen.findByText('a thought')).toBeTruthy()
  })

  it('bookmarks a moment without requiring any text', async () => {
    jsonOnce({ annotations: [] })
    panel(30_000)
    await screen.findByText(/nothing marked yet/i)

    jsonOnce({ annotation: mark({ kind: 'bookmark', text: '', tMs: 30_000 }) }, true, 201)
    await userEvent.click(screen.getByRole('button', { name: 'Bookmark' }))

    const [, init] = fetchMock.mock.calls[1]!
    expect(JSON.parse((init as { body: string }).body)).toMatchObject({ kind: 'bookmark', tMs: 30_000 })
  })

  it('will not save an empty note', async () => {
    jsonOnce({ annotations: [] })
    panel()
    await screen.findByText(/nothing marked yet/i)
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
  })

  it('jumps to a mark', async () => {
    const onSeek = vi.fn()
    jsonOnce({ annotations: [mark({ tMs: 65_000 })] })
    panel(0, onSeek)

    await userEvent.click(await screen.findByRole('button', { name: /jump to 1:05/i }))
    expect(onSeek).toHaveBeenCalledWith(65_000)
  })

  it('removes a mark', async () => {
    jsonOnce({ annotations: [mark({ text: 'delete me' })] })
    panel()
    await screen.findByText('delete me')

    jsonOnce({ ok: true })
    await userEvent.click(screen.getByRole('button', { name: /delete mark at 1:05/i }))
    await waitFor(() => expect(screen.queryByText('delete me')).toBeNull())
  })

  describe('when storage is missing', () => {
    it('says so plainly instead of failing silently', async () => {
      jsonOnce({ annotations: [], unavailable: true })
      panel()
      expect(await screen.findByText(/marks are unavailable/i)).toBeTruthy()
      expect(screen.getByText(/everything else on this page still works/i)).toBeTruthy()
    })

    it('surfaces a rejected save rather than pretending it worked', async () => {
      jsonOnce({ annotations: [] })
      panel()
      await screen.findByText(/nothing marked yet/i)

      jsonOnce({ error: 'unavailable', detail: 'That mark could not be saved.' }, false, 503)
      await userEvent.type(screen.getByLabelText(/write a note/i), 'x')
      await userEvent.click(screen.getByRole('button', { name: 'Save' }))

      expect(await screen.findByRole('alert')).toBeTruthy()
      expect(screen.getByText(/could not be saved/i)).toBeTruthy()
    })
  })
})
