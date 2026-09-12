// @vitest-environment jsdom

/**
 * The receipt card is where the product's honesty guarantees become visible.
 *
 * Every rule tested here is one a user could be misled by if it silently
 * regressed: a jump control on a receipt whose timing was never established, a
 * timestamp presented as exact when it is an estimate, or a claim that quietly
 * loses its evidence with no explanation of why. None of those would fail a
 * build or a type check. They would just be wrong on screen.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ReceiptCard } from '@/components/receipt'
import { LaneBadge, PrecisionBadge } from '@/components/precision'
import { buildTranscript, resolveReceipt } from '@/domain/transcript'
import { timingFor, type TimingSource } from '@/domain/timing'

afterEach(cleanup)

function receiptWith(source: TimingSource) {
  const transcript = buildTranscript({
    videoId: 'vid12345678',
    provenance: 'gemini_url',
    language: 'en',
    durationMs: 8000,
    cues: [
      { startMs: 0, endMs: 4000, text: 'the opening statement' },
      { startMs: 4000, endMs: 8000, text: 'the second statement' },
    ],
    timing: timingFor(source),
  })
  return resolveReceipt(transcript, 1, 1)
}

describe('PrecisionBadge', () => {
  it('says exact only for an authoritative source', () => {
    render(<PrecisionBadge timing={timingFor('caption_track')} />)
    expect(screen.getByText('exact moment')).toBeTruthy()
  })

  it('quantifies an estimate rather than rounding it to "exact"', () => {
    render(<PrecisionBadge timing={timingFor('model_rescaled')} />)
    expect(screen.getByText('within about 17s')).toBeTruthy()
  })

  it('admits when timing was never established', () => {
    render(<PrecisionBadge timing={timingFor('model_raw')} />)
    expect(screen.getByText('timing not established')).toBeTruthy()
  })
})

describe('LaneBadge', () => {
  it('names the lane so viewer opinion is never read as video evidence', () => {
    render(<LaneBadge lane="VIEWERS" />)
    const badge = screen.getByText('VIEWERS')
    expect(badge.getAttribute('title')).toMatch(/not by the video/i)
  })
})

describe('ReceiptCard', () => {
  it('shows the claim and the words behind it', () => {
    render(
      <ReceiptCard text="A claim about the video" lane="VIDEO" receipt={receiptWith('caption_track')} />,
    )
    expect(screen.getByText('A claim about the video')).toBeTruthy()
    expect(screen.getByText(/the second statement/)).toBeTruthy()
  })

  describe('the jump control follows the timing, not the wish', () => {
    it('offers a jump when the timing is exact', async () => {
      const onSeek = vi.fn()
      render(
        <ReceiptCard text="c" lane="VIDEO" receipt={receiptWith('caption_track')} onSeek={onSeek} />,
      )
      const button = screen.getByRole('button', { name: /jump to it/i })
      await userEvent.click(button)
      expect(onSeek).toHaveBeenCalledWith(4000)
    })

    it('still offers a jump when the timing is approximate', () => {
      render(
        <ReceiptCard text="c" lane="VIDEO" receipt={receiptWith('model_rescaled')} onSeek={vi.fn()} />,
      )
      expect(screen.getByRole('button', { name: /jump to it/i })).toBeTruthy()
    })

    it('offers NO jump control when the timing was never established', () => {
      // The quote is still evidence. A link that lands in the wrong sentence
      // would turn that evidence into a false citation.
      render(
        <ReceiptCard text="c" lane="VIDEO" receipt={receiptWith('model_raw')} onSeek={vi.fn()} />,
      )
      expect(screen.queryByRole('button', { name: /jump/i })).toBeNull()
      expect(screen.getByText(/no reliable jump for this quote/i)).toBeTruthy()
    })

    it('keeps showing the quote even when it cannot be jumped to', () => {
      render(<ReceiptCard text="c" lane="VIDEO" receipt={receiptWith('user_supplied')} />)
      expect(screen.getByText(/the second statement/)).toBeTruthy()
    })
  })

  describe('verification', () => {
    it('marks a checked claim', () => {
      render(
        <ReceiptCard
          text="c"
          lane="VIDEO"
          receipt={receiptWith('caption_track')}
          verification={{ entailment: 'supported' }}
        />,
      )
      expect(screen.getByText('checked')).toBeTruthy()
    })

    it('does not mark an unchecked claim as checked', () => {
      render(<ReceiptCard text="c" lane="VIDEO" receipt={receiptWith('caption_track')} />)
      expect(screen.queryByText('checked')).toBeNull()
    })

    it('does not mark an unclear verdict as checked', () => {
      render(
        <ReceiptCard
          text="c"
          lane="VIDEO"
          receipt={receiptWith('caption_track')}
          verification={{ entailment: 'unclear' }}
        />,
      )
      expect(screen.queryByText('checked')).toBeNull()
    })

    it('explains why a rejected claim lost its evidence', () => {
      // A silently receipt-less claim looks like one nobody checked.
      render(
        <ReceiptCard
          text="a claim"
          lane="VIDEO"
          receipt={null}
          verification={{ entailment: 'not_supported' }}
        />,
      )
      expect(screen.getByText('a claim')).toBeTruthy()
      expect(screen.getByText(/does not support the statement/i)).toBeTruthy()
      expect(screen.getByText(/may still be true/i)).toBeTruthy()
    })
  })

  it('says plainly when a non-video lane is not grounded', () => {
    render(<ReceiptCard text="my own reasoning" lane="INFERENCE" receipt={null} />)
    expect(screen.getByText(/not grounded in the video/i)).toBeTruthy()
  })
})

describe('copy with link', () => {
  /** Installs a clipboard, and hands back what was written to it. */
  function stubClipboard(fail = false) {
    const written: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          if (fail) throw new Error('denied')
          written.push(text)
        },
      },
    })
    return written
  }

  const card = (source: TimingSource = 'caption_track', props: Record<string, unknown> = {}) =>
    render(
      <ReceiptCard
        text="The second point is made here"
        lane="VIDEO"
        receipt={receiptWith(source)}
        videoId="vid12345678"
        title="Computer Networks"
        {...props}
      />,
    )

  it('puts the claim, the quote, the moment and a link on the clipboard', async () => {
    const written = stubClipboard()
    card()
    await userEvent.click(screen.getByRole('button', { name: /copy with link/i }))

    expect(written).toHaveLength(1)
    expect(written[0]).toContain('Computer Networks')
    expect(written[0]).toContain('The second point is made here')
    expect(written[0]).toContain('“the second statement”')
    expect(written[0]).toContain('watch?v=vid12345678&t=4s')
  })

  it('names no moment when the timing could not establish one', async () => {
    // Same rule as the jump control, pointed outward: a pasted line that claims
    // a time we cannot vouch for is a false citation that travels.
    const written = stubClipboard()
    card('model_raw')
    await userEvent.click(screen.getByRole('button', { name: /copy with link/i }))

    expect(written[0]).toContain('time not established')
    expect(written[0]).not.toContain('&t=')
  })

  it('confirms, so the click is not a guess', async () => {
    stubClipboard()
    card()
    await userEvent.click(screen.getByRole('button', { name: /copy with link/i }))
    expect(screen.getByRole('button', { name: /copied with its link/i })).toBeTruthy()
  })

  it('says so when the browser refuses', async () => {
    // An insecure origin or a declined permission. A control that silently does
    // nothing is worse than one that admits it failed.
    stubClipboard(true)
    card()
    await userEvent.click(screen.getByRole('button', { name: /copy with link/i }))
    expect(screen.getByRole('button', { name: /could not copy/i })).toBeTruthy()
  })

  it('is absent when there is no video to link to', () => {
    render(<ReceiptCard text="a claim" lane="VIDEO" receipt={receiptWith('caption_track')} />)
    expect(screen.queryByRole('button', { name: /copy with link/i })).toBeNull()
  })

  it('is absent on a claim with no receipt, because there is nothing to cite', () => {
    render(<ReceiptCard text="my own reasoning" lane="INFERENCE" receipt={null} videoId="vid12345678" />)
    expect(screen.queryByRole('button', { name: /copy with link/i })).toBeNull()
  })
})
