// @vitest-environment jsdom

/**
 * The workspace's tab strip.
 *
 * Two of these guard money rather than polish. The viewers panel fetches three
 * pages of YouTube comments, which is real quota out of a budget shared by
 * every user of the deployment — so it must not load for a tab nobody opened,
 * and it must not load *again* every time somebody comes back to it. The panel
 * used to be unmounted on every switch, which made both of those wrong at once
 * and threw away the transcript's scroll position for good measure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { Workspace } from '@/components/workspace'

afterEach(cleanup)

const META = {
  title: 'Computer Networks',
  channelId: 'c1',
  channelTitle: 'Prof X',
  publishedAt: '2026-01-01',
  durationSec: 600,
}

const TRANSCRIPT = {
  videoId: 'vid12345678',
  provenance: 'gemini_url',
  language: 'en',
  durationMs: 8000,
  timing: { source: 'caption_track', toleranceMs: 0 },
  cues: [
    { i: 0, startMs: 0, endMs: 4000, text: 'the opening statement' },
    { i: 1, startMs: 4000, endMs: 8000, text: 'the second statement' },
  ],
}

/** How many times each endpoint was called, so a refetch is visible. */
let calls: Record<string, number>

function ndjson(lines: unknown[]): Response {
  const body = lines.map((l) => `${JSON.stringify(l)}\n`).join('')
  return {
    ok: true,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body))
        controller.close()
      },
    }),
  } as unknown as Response
}

beforeEach(() => {
  calls = {}
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const key = url.split('?')[0] ?? url
      calls[key] = (calls[key] ?? 0) + 1

      if (key.endsWith('/api/ingest')) {
        return ndjson([
          {
            type: 'result',
            result: {
              videoId: 'vid12345678',
              status: 'ready',
              fromCache: false,
              metadata: META,
              transcript: TRANSCRIPT,
              attempts: [],
            },
          },
        ])
      }
      if (key.endsWith('/api/comments')) {
        return {
          ok: true,
          json: async () => ({ threads: [{ id: 'c1', author: 'A viewer', text: 'hello', likeCount: 3, replyCount: 0 }], truncated: false }),
        } as unknown as Response
      }
      return { ok: true, json: async () => ({ annotations: [] }) } as unknown as Response
    }),
  )
})

async function openWorkspace() {
  render(<Workspace videoId="vid12345678" />)
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Ask' })).toBeTruthy())
}

const tab = (name: string) => screen.getByRole('tab', { name })

/**
 * How many times an endpoint was called.
 *
 * Matched by suffix rather than by a full URL: the components fetch relative
 * paths, and an absolute key silently matches nothing — which would let
 * "was never called" pass while the call was happening.
 */
const timesCalled = (path: string) =>
  Object.entries(calls)
    .filter(([url]) => url.endsWith(path))
    .reduce((total, [, n]) => total + n, 0)

describe('Workspace tabs', () => {
  it('does not fetch comments for a tab nobody opened', async () => {
    await openWorkspace()
    expect(timesCalled('/api/comments')).toBe(0)
    // Proof the counter is wired up at all, so the assertion above cannot pass
    // by matching nothing.
    expect(timesCalled('/api/ingest')).toBe(1)
  })

  it('fetches comments once, however many times you come back', async () => {
    // The regression this exists for: three quota units per visit.
    await openWorkspace()
    await userEvent.click(tab('Viewers say'))
    await waitFor(() => expect(screen.getByText('A viewer')).toBeTruthy())

    await userEvent.click(tab('Ask'))
    await userEvent.click(tab('Viewers say'))
    await userEvent.click(tab('Ask'))
    await userEvent.click(tab('Viewers say'))

    expect(timesCalled('/api/comments')).toBe(1)
  })

  it('keeps a visited panel in the document, hidden', async () => {
    await openWorkspace()
    await userEvent.click(tab('Transcript'))
    await userEvent.click(tab('Ask'))

    const transcript = document.getElementById('panel-transcript')
    expect(transcript).not.toBeNull()
    expect(transcript?.hidden).toBe(true)
    expect(document.getElementById('panel-chat')?.hidden).toBe(false)
  })

  it('wires each tab to the panel it names', async () => {
    await openWorkspace()
    for (const name of ['Ask', 'Transcript', 'Viewers say', 'Marks']) {
      const control = tab(name)
      const panelId = control.getAttribute('aria-controls')
      expect(panelId).toBeTruthy()
      await userEvent.click(control)
      const panel = document.getElementById(panelId!)
      expect(panel?.getAttribute('role')).toBe('tabpanel')
      expect(panel?.getAttribute('aria-labelledby')).toBe(control.id)
    }
  })

  it('is one tab stop, not four', async () => {
    // Roving tabindex. Without it a keyboard user pages through every tab
    // before reaching the panel they already chose.
    await openWorkspace()
    expect(tab('Ask').getAttribute('tabindex')).toBe('0')
    expect(tab('Marks').getAttribute('tabindex')).toBe('-1')
  })

  it('moves between tabs with the arrow keys', async () => {
    await openWorkspace()
    tab('Ask').focus()

    await userEvent.keyboard('{ArrowRight}')
    expect(tab('Transcript').getAttribute('aria-selected')).toBe('true')

    await userEvent.keyboard('{ArrowLeft}')
    expect(tab('Ask').getAttribute('aria-selected')).toBe('true')
  })

  it('wraps at both ends rather than stopping', async () => {
    await openWorkspace()
    tab('Ask').focus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(tab('Marks').getAttribute('aria-selected')).toBe('true')
  })
})
