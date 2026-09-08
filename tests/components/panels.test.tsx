// @vitest-environment jsdom

/**
 * Transcript and chat panels.
 *
 * The rules worth guarding here are the ones a screenshot cannot show: that
 * transcript lines stop being clickable when their timing cannot be trusted,
 * that an abstention reads as a finding rather than a failure, and that a
 * dropped claim is counted out loud instead of vanishing.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ChatPanel, type Turn } from '@/components/chat-panel'
import { TranscriptPanel } from '@/components/transcript-panel'
import { buildTranscript, resolveReceipt } from '@/domain/transcript'
import { timingFor, type TimingSource } from '@/domain/timing'

afterEach(cleanup)

const LINES = [
  'we begin by discussing the transformer',
  'architecture and why attention matters',
  'then we move on to something unrelated',
]

function transcriptWith(source: TimingSource) {
  return buildTranscript({
    videoId: 'vid12345678',
    provenance: 'gemini_url',
    language: 'en',
    durationMs: LINES.length * 4000,
    cues: LINES.map((text, i) => ({ startMs: i * 4000, endMs: (i + 1) * 4000, text })),
    timing: timingFor(source),
  })
}

describe('TranscriptPanel', () => {
  it('lists the lines with their timestamps', () => {
    render(
      <TranscriptPanel transcript={transcriptWith('caption_track')} currentMs={0} onSeek={vi.fn()} />,
    )
    expect(screen.getByText(LINES[0]!)).toBeTruthy()
    expect(screen.getByText('3 lines')).toBeTruthy()
  })

  it('seeks when a line is clicked and the timing supports it', async () => {
    const onSeek = vi.fn()
    render(
      <TranscriptPanel transcript={transcriptWith('caption_track')} currentMs={0} onSeek={onSeek} />,
    )
    await userEvent.click(screen.getByText(LINES[1]!))
    expect(onSeek).toHaveBeenCalledWith(4000)
  })

  it('stops being clickable when the timing was never established', () => {
    // A click that lands somewhere else is a worse answer than no click.
    render(<TranscriptPanel transcript={transcriptWith('model_raw')} currentMs={0} onSeek={vi.fn()} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText(/lines are not clickable/i)).toBeTruthy()
    // The words are still there and still accurate.
    expect(screen.getByText(LINES[0]!)).toBeTruthy()
  })

  it('shows the precision of the transcript it is displaying', () => {
    render(
      <TranscriptPanel transcript={transcriptWith('model_rescaled')} currentMs={0} onSeek={vi.fn()} />,
    )
    expect(screen.getByText('within about 17s')).toBeTruthy()
  })

  describe('search', () => {
    it('filters to matching lines and reports time spent', async () => {
      render(
        <TranscriptPanel transcript={transcriptWith('caption_track')} currentMs={0} onSeek={vi.fn()} />,
      )
      await userEvent.type(screen.getByLabelText(/search the transcript/i), 'unrelated')

      expect(screen.getByText(LINES[2]!)).toBeTruthy()
      expect(screen.queryByText(LINES[0]!)).toBeNull()
      expect(screen.getByText(/1 matching line/i)).toBeTruthy()
    })

    it('finds a phrase that spans two lines', async () => {
      render(
        <TranscriptPanel transcript={transcriptWith('caption_track')} currentMs={0} onSeek={vi.fn()} />,
      )
      await userEvent.type(screen.getByLabelText(/search the transcript/i), 'transformer architecture')

      // The phrase straddles a cue boundary; both lines must survive the filter.
      expect(screen.getByText(LINES[0]!)).toBeTruthy()
      expect(screen.getByText(LINES[1]!)).toBeTruthy()
    })

    it('says plainly when nothing matches', async () => {
      render(
        <TranscriptPanel transcript={transcriptWith('caption_track')} currentMs={0} onSeek={vi.fn()} />,
      )
      await userEvent.type(screen.getByLabelText(/search the transcript/i), 'kubernetes')
      expect(screen.getByText(/nothing in this video matches/i)).toBeTruthy()
    })
  })
})

// ---------------------------------------------------------------- chat panel

const receipt = () => resolveReceipt(transcriptWith('caption_track'), 0, 0)

const chat = (turns: Turn[], over: Partial<React.ComponentProps<typeof ChatPanel>> = {}) =>
  render(
    <ChatPanel
      turns={turns}
      pending={false}
      onAsk={vi.fn()}
      onSeek={vi.fn()}
      {...over}
    />,
  )

describe('ChatPanel', () => {
  it('suggests what to ask before anything has been asked', () => {
    chat([])
    expect(screen.getByText(/ask about this video\./i)).toBeTruthy()
    expect(screen.getByText(/says so rather than filling the gap/i)).toBeTruthy()
  })

  it('renders an answer as claims with their evidence', () => {
    chat([
      {
        question: 'What is it about?',
        answer: {
          status: 'answered',
          claims: [{ text: 'It is about transformers', lane: 'VIDEO', receipt: receipt() }],
          rejected: [],
        },
      },
    ])
    expect(screen.getByText('What is it about?')).toBeTruthy()
    expect(screen.getByText('It is about transformers')).toBeTruthy()
  })

  it('presents an abstention as a finding, not a failure', () => {
    chat([
      {
        question: 'What is the capital of France?',
        answer: {
          status: 'not_in_video',
          claims: [],
          rejected: [],
          message: 'This video does not address that question.',
        },
      },
    ])
    expect(screen.getByText('Not covered in this video')).toBeTruthy()
    expect(screen.getByText(/does not address that question/i)).toBeTruthy()
  })

  it('counts dropped claims out loud rather than letting them vanish', () => {
    chat([
      {
        question: 'q',
        answer: {
          status: 'answered',
          claims: [{ text: 'kept', lane: 'VIDEO', receipt: receipt() }],
          rejected: [{ text: 'invented', reason: 'cue_out_of_range' }],
        },
      },
    ])
    expect(screen.getByText(/1 claim was dropped for citing evidence that is not in this transcript/i))
      .toBeTruthy()
  })

  it('surfaces a request failure without pretending it answered', () => {
    chat([{ question: 'q', answer: null, error: 'The request failed. Try again.' }])
    expect(screen.getByText(/the request failed/i)).toBeTruthy()
  })

  it('explains why asking is unavailable instead of showing a dead box', () => {
    chat([], { disabled: true, disabledReason: 'There is no transcript for this video.' })
    expect(screen.getByText(/no transcript for this video/i)).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('will not submit an empty question', async () => {
    const onAsk = vi.fn()
    chat([], { onAsk })
    expect(screen.getByRole('button', { name: 'Ask' }).hasAttribute('disabled')).toBe(true)
    expect(onAsk).not.toHaveBeenCalled()
  })

  it('submits a typed question', async () => {
    const onAsk = vi.fn()
    chat([], { onAsk })
    await userEvent.type(screen.getByLabelText(/ask about this video/i), 'why?')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    expect(onAsk).toHaveBeenCalledWith('why?')
  })

  it('says it is working rather than going silent', () => {
    chat([], { pending: true })
    expect(screen.getByText(/reading the transcript/i)).toBeTruthy()
  })
})
