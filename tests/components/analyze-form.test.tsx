// @vitest-environment jsdom

/**
 * The entry point.
 *
 * Validation happens in the field the user is looking at rather than after a
 * round trip, so these tests are the only thing standing between a typo and a
 * page that spends ten seconds before saying no.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

const { AnalyzeForm } = await import('@/components/analyze-form')

beforeEach(() => push.mockReset())
afterEach(cleanup)

const field = () => screen.getByLabelText(/youtube video link/i)
const submit = () => screen.getByRole('button', { name: /understand it/i })

describe('AnalyzeForm', () => {
  it('starts with the button disabled, so an empty submit is impossible', () => {
    render(<AnalyzeForm />)
    expect(submit().hasAttribute('disabled')).toBe(true)
  })

  it('opens the workspace for a watch URL', async () => {
    render(<AnalyzeForm />)
    await userEvent.type(field(), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    await userEvent.click(submit())
    expect(push).toHaveBeenCalledWith('/v/dQw4w9WgXcQ')
  })

  it.each([
    ['a share link', 'https://youtu.be/dQw4w9WgXcQ'],
    ['a Shorts link', 'https://www.youtube.com/shorts/dQw4w9WgXcQ'],
    ['a link with tracking junk', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=abc&t=42s'],
    ['no scheme', 'youtube.com/watch?v=dQw4w9WgXcQ'],
    ['a bare video id', 'dQw4w9WgXcQ'],
  ])('accepts %s', async (_label, url) => {
    render(<AnalyzeForm />)
    await userEvent.type(field(), url)
    await userEvent.click(submit())
    expect(push).toHaveBeenCalledWith('/v/dQw4w9WgXcQ')
  })

  describe('refuses what it cannot open, in the field itself', () => {
    it.each([
      ['another site', 'https://vimeo.com/12345'],
      ['a lookalike host', 'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ'],
      ['a javascript URL', 'javascript:alert(1)'],
      ['prose', 'not a youtube link at all'],
      ['a channel page', 'https://www.youtube.com/@someone'],
    ])('%s', async (_label, url) => {
      render(<AnalyzeForm />)
      await userEvent.type(field(), url)
      await userEvent.click(submit())

      expect(push).not.toHaveBeenCalled()
      expect(screen.getByRole('alert').textContent).toMatch(/does not look like a YouTube video link/i)
    })
  })

  it('marks the field invalid for a screen reader, not just visually', async () => {
    render(<AnalyzeForm />)
    await userEvent.type(field(), 'https://vimeo.com/12345')
    await userEvent.click(submit())

    expect(field().getAttribute('aria-invalid')).toBe('true')
    expect(field().getAttribute('aria-describedby')).toBe('video-url-error')
    expect(screen.getByRole('alert').id).toBe('video-url-error')
  })

  it('clears the error as soon as the user starts fixing it', async () => {
    render(<AnalyzeForm />)
    await userEvent.type(field(), 'https://vimeo.com/12345')
    await userEvent.click(submit())
    expect(screen.getByRole('alert')).toBeTruthy()

    await userEvent.type(field(), 'x')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(field().getAttribute('aria-invalid')).toBeNull()
  })
})
