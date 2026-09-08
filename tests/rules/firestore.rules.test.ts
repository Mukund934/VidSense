/**
 * Firestore security rules, proven against the emulator.
 *
 * The property that matters most is negative: user B must not be able to reach
 * user A's data by any path. Ownership bugs do not announce themselves, so every
 * collection gets an explicit cross-tenant denial test.
 *
 * Requires the Firestore emulator. `npm run test:rules` starts one automatically.
 */

import {
  type RulesTestEnvironment,
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing'
import { doc, getDoc, setDoc, deleteDoc, updateDoc } from 'firebase/firestore'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest'

let env: RulesTestEnvironment

const ALICE = 'alice'
const BOB = 'bob'

/**
 * Read the emulator port from firebase.json rather than repeating it here.
 *
 * These ports are deliberately not the Firebase defaults: the defaults collide
 * with any other project's emulator suite running on the same machine, and a
 * collision on the *hub* port tears down the whole suite — including Firestore —
 * leaving this file failing for a reason that looks nothing like its cause.
 */
function emulatorPort(): number {
  const config = JSON.parse(readFileSync('firebase.json', 'utf8')) as {
    emulators?: { firestore?: { port?: number } }
  }
  const port = config.emulators?.firestore?.port
  if (typeof port !== 'number') {
    throw new Error('firebase.json does not declare emulators.firestore.port')
  }
  return port
}

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'vidsense-rules-test',
    firestore: {
      rules: readFileSync('firestore.rules', 'utf8'),
      host: '127.0.0.1',
      port: emulatorPort(),
    },
  })
})

afterAll(async () => {
  await env?.cleanup()
})

beforeEach(async () => {
  await env.clearFirestore()
})

const alice = () => env.authenticatedContext(ALICE).firestore()
const bob = () => env.authenticatedContext(BOB).firestore()
const anon = () => env.unauthenticatedContext().firestore()

const now = 1_760_000_000_000

describe('users/{uid} profile', () => {
  it('lets the owner create and read their profile', async () => {
    const ref = doc(alice(), `users/${ALICE}`)
    await assertSucceeds(setDoc(ref, { createdAt: now, displayName: 'Alice' }))
    await assertSucceeds(getDoc(ref))
  })

  it('denies another user reading it', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `users/${ALICE}`), { createdAt: now })
    })
    await assertFails(getDoc(doc(bob(), `users/${ALICE}`)))
  })

  it('denies another user writing it', async () => {
    await assertFails(setDoc(doc(bob(), `users/${ALICE}`), { createdAt: now }))
  })

  it('denies anonymous access', async () => {
    await assertFails(getDoc(doc(anon(), `users/${ALICE}`)))
  })

  it('rejects unknown fields', async () => {
    await assertFails(
      setDoc(doc(alice(), `users/${ALICE}`), { createdAt: now, isAdmin: true }),
    )
  })

  it('rejects an oversized display name', async () => {
    await assertFails(
      setDoc(doc(alice(), `users/${ALICE}`), { createdAt: now, displayName: 'x'.repeat(201) }),
    )
  })
})

describe('history', () => {
  const entry = { videoId: 'vid1', lastOpenedAt: now, title: 'Networks', status: 'ready' }

  it('lets the owner write and read an entry', async () => {
    const ref = doc(alice(), `users/${ALICE}/history/vid1`)
    await assertSucceeds(setDoc(ref, entry))
    await assertSucceeds(getDoc(ref))
  })

  it('denies another user reading it', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `users/${ALICE}/history/vid1`), entry)
    })
    await assertFails(getDoc(doc(bob(), `users/${ALICE}/history/vid1`)))
  })

  it('requires the document id to match the videoId field', async () => {
    await assertFails(
      setDoc(doc(alice(), `users/${ALICE}/history/vid1`), { ...entry, videoId: 'other' }),
    )
  })

  it('rejects an unknown status', async () => {
    await assertFails(
      setDoc(doc(alice(), `users/${ALICE}/history/vid1`), { ...entry, status: 'pending' }),
    )
  })
})

describe('conversations and messages', () => {
  const convo = { videoId: 'vid1', createdAt: now }
  const message = { role: 'assistant', text: 'TCP uses a three-way handshake.', createdAt: now }

  it('lets the owner create a conversation and a message', async () => {
    await assertSucceeds(setDoc(doc(alice(), `users/${ALICE}/conversations/c1`), convo))
    await assertSucceeds(
      setDoc(doc(alice(), `users/${ALICE}/conversations/c1/messages/m1`), message),
    )
  })

  it('denies another user reading messages', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `users/${ALICE}/conversations/c1/messages/m1`), message)
    })
    await assertFails(getDoc(doc(bob(), `users/${ALICE}/conversations/c1/messages/m1`)))
  })

  // The receipts invariant, enforced at the database boundary: evidence is a
  // record of what was said, so it can be deleted but never rewritten.
  it('denies updating a message once written', async () => {
    await assertSucceeds(
      setDoc(doc(alice(), `users/${ALICE}/conversations/c1/messages/m1`), message),
    )
    await assertFails(
      updateDoc(doc(alice(), `users/${ALICE}/conversations/c1/messages/m1`), { text: 'edited' }),
    )
  })

  it('allows the owner to delete a message', async () => {
    await assertSucceeds(
      setDoc(doc(alice(), `users/${ALICE}/conversations/c1/messages/m1`), message),
    )
    await assertSucceeds(
      deleteDoc(doc(alice(), `users/${ALICE}/conversations/c1/messages/m1`)),
    )
  })

  it('rejects an unknown role', async () => {
    await assertFails(
      setDoc(doc(alice(), `users/${ALICE}/conversations/c1/messages/m1`), {
        ...message,
        role: 'system',
      }),
    )
  })

  it('rejects an unknown lane', async () => {
    await assertFails(
      setDoc(doc(alice(), `users/${ALICE}/conversations/c1/messages/m1`), {
        ...message,
        lane: 'RUMOUR',
      }),
    )
  })

  it('rejects an oversized message body', async () => {
    await assertFails(
      setDoc(doc(alice(), `users/${ALICE}/conversations/c1/messages/m1`), {
        ...message,
        text: 'x'.repeat(20_001),
      }),
    )
  })
})

describe('notes and bookmarks', () => {
  it('lets the owner create a note', async () => {
    await assertSucceeds(
      setDoc(doc(alice(), `users/${ALICE}/notes/n1`), {
        videoId: 'vid1',
        tMs: 872_000,
        text: 'handshake explained here',
        createdAt: now,
      }),
    )
  })

  it('rejects a negative timestamp', async () => {
    await assertFails(
      setDoc(doc(alice(), `users/${ALICE}/bookmarks/b1`), {
        videoId: 'vid1',
        tMs: -1,
        createdAt: now,
      }),
    )
  })

  it('rejects a non-integer timestamp', async () => {
    await assertFails(
      setDoc(doc(alice(), `users/${ALICE}/bookmarks/b1`), {
        videoId: 'vid1',
        tMs: 12.5,
        createdAt: now,
      }),
    )
  })

  it('denies another user reading notes', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `users/${ALICE}/notes/n1`), {
        videoId: 'vid1',
        tMs: 0,
        text: 'private',
        createdAt: now,
      })
    })
    await assertFails(getDoc(doc(bob(), `users/${ALICE}/notes/n1`)))
  })
})

describe('videos — shared knowledge', () => {
  const video = {
    metadata: { title: 'T', channelId: 'c', channelTitle: 'C', publishedAt: '2026-01-01', durationSec: 60 },
    provenance: 'gemini_url',
    ingestedAt: now,
    refreshedAt: now,
    expiresAt: now + 1000,
    schemaVersion: 1,
    status: 'ready',
  }

  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'videos/vid1'), video)
      await setDoc(doc(ctx.firestore(), 'videos/vid1/comments/p1'), {
        clusters: { codec: 'gzip+b64', count: 0, bytes: 0, blob: '' },
        sampleSize: 300,
        fetchedAt: now,
      })
    })
  })

  it('lets any signed-in user read a video — this is the cross-user cache', async () => {
    await assertSucceeds(getDoc(doc(alice(), 'videos/vid1')))
    await assertSucceeds(getDoc(doc(bob(), 'videos/vid1')))
  })

  it('lets a signed-in user read comment pages', async () => {
    await assertSucceeds(getDoc(doc(bob(), 'videos/vid1/comments/p1')))
  })

  it('denies anonymous reads', async () => {
    await assertFails(getDoc(doc(anon(), 'videos/vid1')))
  })

  // No client may poison knowledge that other users will read. The server writes
  // via the Admin SDK, which bypasses rules entirely.
  it('denies all client writes', async () => {
    await assertFails(setDoc(doc(alice(), 'videos/vid1'), video))
    await assertFails(updateDoc(doc(alice(), 'videos/vid1'), { status: 'failed' }))
    await assertFails(deleteDoc(doc(alice(), 'videos/vid1')))
  })

  it('denies client writes to comment pages', async () => {
    await assertFails(
      setDoc(doc(bob(), 'videos/vid1/comments/p1'), { sampleSize: 1, fetchedAt: now }),
    )
  })
})

describe('default deny', () => {
  it('refuses collections the rules never mention', async () => {
    await assertFails(getDoc(doc(alice(), 'admin/secrets')))
    await assertFails(setDoc(doc(alice(), 'admin/secrets'), { x: 1 }))
    await assertFails(setDoc(doc(alice(), 'billing/alice'), { plan: 'pro' }))
  })
})

describe('imported watch history', () => {
  const path = (uid: string) => `users/${uid}/watched/imported`

  it('lets the owner read their own import', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), path(ALICE)), { importedAt: 1, count: 3 })
    })
    await assertSucceeds(getDoc(doc(alice(), path(ALICE))))
  })

  it('denies another user reading it', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), path(ALICE)), { importedAt: 1, count: 3 })
    })
    await assertFails(getDoc(doc(bob(), path(ALICE))))
  })

  it('lets the owner delete it, so data deletion works', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), path(ALICE)), { importedAt: 1, count: 3 })
    })
    await assertSucceeds(deleteDoc(doc(alice(), path(ALICE))))
  })

  it('denies a client writing it, however large', async () => {
    // Only the server writes this. A client that could would be writing an
    // unbounded blob into a shared free-tier quota.
    await assertFails(setDoc(doc(alice(), path(ALICE)), { importedAt: 1, count: 1 }))
  })

  it('denies another user writing it', async () => {
    await assertFails(setDoc(doc(bob(), path(ALICE)), { importedAt: 1, count: 1 }))
  })
})
