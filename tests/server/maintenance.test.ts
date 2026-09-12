import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The two endpoints an operator needs and a user never sees.
 *
 * `/api/health` is what a deploy is checked against, so it has to fail when the
 * deployment cannot do its job rather than when the process has died.
 *
 * `/api/maintenance/sweep` deletes data on a `GET` — which is what a cron
 * scheduler sends — so everything guarding it is load-bearing.
 */

const caps = vi.fn(() => ({ gemini: true, youtube: true, firestore: true }))
const db = vi.fn<() => object | null>(() => ({}))

vi.mock('@/lib/server/deps', () => ({
  capabilities: () => caps(),
  geminiModel: () => 'gemini-3.5-flash-lite',
  firestore: () => db(),
}))

const sweepExpired =
  vi.fn<typeof import('@/data/retention').sweepExpired>(async () => ({
    deleted: 4,
    failed: 0,
    more: false,
  }))
vi.mock('@/data/retention', async (original) => {
  const actual = await original<typeof import('@/data/retention')>()
  return { ...actual, sweepExpired }
})

const { GET: health } = await import('@/app/api/health/route')
const { GET: sweep } = await import('@/app/api/maintenance/sweep/route')

const SECRET = 'a-long-enough-cron-secret'

function call(authorization?: string) {
  return sweep(
    new Request('https://vidsense.test/api/maintenance/sweep', {
      ...(authorization ? { headers: { authorization } } : {}),
    }),
  )
}

beforeEach(() => {
  caps.mockReturnValue({ gemini: true, youtube: true, firestore: true })
  db.mockReturnValue({})
  process.env.CRON_SECRET = SECRET
})

afterEach(() => {
  delete process.env.CRON_SECRET
  vi.clearAllMocks()
})

describe('GET /api/health', () => {
  it('is ok when the deployment can actually analyse a video', async () => {
    const res = health()
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ ok: true, model: 'gemini-3.5-flash-lite' })
  })

  it('fails when a required key is missing', async () => {
    // The most likely deploy defect: the app boots perfectly and can do nothing.
    caps.mockReturnValue({ gemini: false, youtube: true, firestore: true })
    const res = health()
    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toMatchObject({ ok: false, required: { transcripts: false } })
  })

  it('stays ok without storage, because the product is designed to forget', async () => {
    caps.mockReturnValue({ gemini: true, youtube: true, firestore: false })
    const res = health()
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ ok: true, optional: { storage: false } })
  })

  it('names no key and no fragment of one', async () => {
    const body = JSON.stringify(await health().json())
    expect(body).not.toMatch(/key/i)
  })

  it('is never cached', () => {
    expect(health().headers.get('cache-control')).toBe('no-store')
  })
})

describe('GET /api/maintenance/sweep', () => {
  it('sweeps and reports when the secret matches', async () => {
    const res = await call(`Bearer ${SECRET}`)
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ deleted: 4, failed: 0, more: false })
    expect(sweepExpired).toHaveBeenCalledOnce()
  })

  it.each([
    ['no header at all', undefined],
    ['the wrong secret', 'Bearer not-the-secret-at-all!!'],
    ['the right secret without the scheme', SECRET],
    ['an empty bearer', 'Bearer '],
    ['a prefix of the secret', `Bearer ${SECRET.slice(0, 8)}`],
  ])('refuses %s', async (_label, header) => {
    const res = await call(header)
    expect(res.status).toBe(401)
    expect(sweepExpired).not.toHaveBeenCalled()
  })

  it('refuses to run at all when no secret is configured', async () => {
    // An unauthenticated endpoint that deletes data is worse than a retention
    // sweep nobody has switched on yet.
    delete process.env.CRON_SECRET
    const res = await call(`Bearer ${SECRET}`)
    expect(res.status).toBe(503)
    expect(sweepExpired).not.toHaveBeenCalled()
  })

  it('says so rather than sweeping nothing when there is no storage', async () => {
    db.mockReturnValue(null)
    const res = await call(`Bearer ${SECRET}`)
    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toMatchObject({ error: 'no_storage' })
  })

  it('reports a failed sweep as a failure, not as a clean run', async () => {
    sweepExpired.mockRejectedValueOnce(new Error('firestore is unavailable'))
    const res = await call(`Bearer ${SECRET}`)
    expect(res.status).toBe(500)
    // The reason stays in the log. A caller who can reach this already knows
    // what they asked for, and the detail can name a project.
    await expect(res.json()).resolves.toEqual({ error: 'sweep_failed' })
  })
})
