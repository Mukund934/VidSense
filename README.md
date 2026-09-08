# VidSense AI

**Understand every video.**

VidSense AI turns a YouTube video into searchable, evidence-grounded knowledge — so you can ask questions
about it, find the moment something was said, and see the words that back every answer.

> Ask. Explore. Understand.

---

## Status

**Early but real. The application runs end to end.**

Paste a YouTube link and VidSense fetches the video's details, reads a transcript, stores it, and gives you a
workspace: the player, a searchable transcript, a question box that answers with citations, what viewers said,
and an evidence pack you can export. It has been exercised against live Gemini and YouTube APIs, not fixtures.

This README describes what is actually implemented. Where something is planned rather than present, it says so.

| Area | State |
|---|---|
| URL parsing, host allowlist | ✅ implemented |
| Transcript acquisition (Gemini, user-supplied) with fallback chain | ✅ implemented |
| Degraded modes (no transcript, live, unavailable, too long) | ✅ implemented |
| Video metadata (YouTube Data API v3) | ✅ implemented |
| Ingest orchestration — cache, single-flight, provenance | ✅ implemented |
| Firestore persistence + security rules | ✅ implemented |
| Lexical + interval retrieval over a transcript | ✅ implemented |
| Untrusted-text sanitising and prompt fencing | ✅ implemented |
| Timestamp trust model | ✅ implemented |
| Answer layer — cue-index citations, lanes, abstention | ✅ implemented |
| Prompt-injection suite (8 classes) | ✅ implemented |
| Comments ingestion for the VIEWERS SAY lane | ✅ implemented |
| Evidence Pack export | ✅ implemented |
| Web application — landing, workspace, player, chat, history, settings | ✅ implemented |
| Google sign-in over a server-verified session | ✅ implemented |
| Data deletion | ✅ implemented |
| Answer verifier (does a citation *support* its claim?) | ❌ not started |
| Notes, bookmarks, Takeout history import | ❌ not started |

---

## What makes it different

Most tools turn a video into an answer. VidSense aims to turn it into a **record**: an answer whose every
claim carries a verbatim quote, the moment it came from, and an honest statement of how precisely that
moment is known.

That last part is doing real work, and it is worth being specific about.

### Timestamp guarantees, and their limits

**Two different things can go wrong with a citation, and VidSense currently solves one of them.**

**Solved — a citation cannot point at text that does not exist.** The model never emits a timestamp. It emits
a *cue index*, and `resolveReceipt()` resolves that index against the transcript we hold, throwing on anything
out of range. A fabricated citation fails loudly at the boundary rather than rendering as a plausible quote.

**Not solved — the cue's own timestamp may be wrong.** Cue times come from the transcript provider, and
measured against ground truth on 2026-09-07, Gemini's are badly out:

| | median error | p95 |
|---|---|---|
| Raw model timestamps | **82 s** | 159 s |
| After anchoring to the video's true duration | **7.5 s** | 16.6 s |

*(356-second talk, 8 probe points, ground truth established by clipping the video to a known window — the
provider bounds clip content exactly, so a narrow clip is an authoritative answer to "what is said at time T".)*

The overshoot is roughly proportional but **not** a constant factor, so rescaling helps a great deal and does
not make it exact.

**So VidSense does not claim exactness it cannot deliver.** Every transcript carries a `TimingSource` and a
tolerance, every receipt inherits them, and the precision is derived rather than assumed:

| Timing source | Precision | What the product may say |
|---|---|---|
| `caption_track` (creator's own cues — not reachable in v1) | exact | "jump to the exact moment" |
| `clip_window` (we chose the span, so the bound is the span) | exact if the window is tight | "jump to the moment" |
| `model_rescaled` (duration-anchored correction) | approximate | "within about 17s" |
| `model_raw` | unlocated | no jump link at all |
| `user_supplied` | unlocated | no jump link at all |

An unlocated receipt still shows its verbatim quote, because the quote is real evidence. It gets no jump link,
because a link that lands in the wrong sentence turns evidence into a false claim with a timestamp attached.

A transcript that never states its timing defaults to the least trustworthy source. Precision has to be
earned, not assumed.

---

## Architecture

```
  YouTube URL
      |
      v
  parse + host allowlist        rejects javascript:, data:, lookalike hosts
      |
      v
  CACHE  videos/{id}            unexpired + shareable provenance -> ~2 reads, done
      |
  SINGLE-FLIGHT                 concurrent requests for one video join one ingest
      |
      v
  METADATA  videos.list         1 quota unit; detects private/live/removed early
      |                         (search.list is never called - it costs 100)
      v
  TRANSCRIPT CHAIN              first source that succeeds wins; terminal
      |                         failures stop the chain instead of burning quota
      |-- GeminiUrlSource
      |-- UserSuppliedSource    VTT / SRT / plain / [0:05] / (0:05) / 1:01:05
      |
      v
  STORE                         one document per video, transcript as a gzip blob
      |                         (one document per cue would cap the free tier at
      |                          13 videos/day across all users)
      v
  RETRIEVAL                     in-memory over the loaded transcript
      |-- lexical sweep         "every mention of X" - phrases match across cues
      |-- interval logic        "what came before 14:32", "how long on X"
      |
      v
  ANSWER                        transcript in context, fenced as untrusted
      |                         model returns CUE INDICES, never times or quotes
      v
  RECEIPTS                      resolved on our side; out-of-range citations
                                are dropped, not rendered
```

**There is no vector database, no embedding model and no reranker**, and that is a deliberate choice rather
than a missing feature. A two-hour transcript is roughly 25–35k tokens and fits in a model's context, so at
one-video scale retrieval machinery costs money to answer questions *worse* than a regex does. Embeddings
return when cross-video search does.

---

## Stack

- **TypeScript**, Node ≥ 20 — no build step in the library today
- **Firebase** — Cloud Firestore for storage, Firebase Auth (Google) planned for the app
- **Gemini** — transcript acquisition from a YouTube URL
- **YouTube Data API v3** — public metadata
- **Vitest** — the whole test suite
- Planned: **Next.js** (App Router) + Tailwind for the web app

---

## Setup

```bash
npm install
cp .env.example .env.local   # then fill in your own keys
```

### Environment variables

Names only — never commit values. `.env.local` is git-ignored.

| Variable | Purpose | Required |
|---|---|---|
| `GEMINI_API_KEY` | Transcript acquisition. Server-side only | yes |
| `YOUTUBE_API_KEY` | Video metadata. Server-side only | yes |
| `USE_FIREBASE_EMULATOR` | Route local traffic to the emulator | for local dev |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Firebase web config | for the app |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | Firebase web config | for the app |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | Firebase web config | for the app |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | Firebase web config | for the app |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | Admin SDK, for server writes | when deploying |
| `GEMINI_MODEL` | Override the default model | no |

The `NEXT_PUBLIC_FIREBASE_*` values are publishable by design — Firebase web config is not a secret, and
safety comes from Security Rules and App Check rather than from hiding it. `GEMINI_API_KEY` and
`YOUTUBE_API_KEY` are secrets and must never be exposed to a browser.

---

## Development

```bash
npm run dev        # http://localhost:3000
```

The app needs `GEMINI_API_KEY` and `YOUTUBE_API_KEY` to analyse anything. Without Firestore it still works —
it simply forgets between restarts, and the settings page says so rather than failing quietly.

```bash
npm test                # offline: no network, no keys, no emulator
npm run test:emulator   # security rules + Firestore adapters
npm run test:all        # both
npm run typecheck
npm run lint
npm run build
```

The default suite runs **fully offline against injected fakes**. It needs no API key and makes no network
call, so a contributor can work on the core without credentials of any kind.

`npm run test:emulator` starts a Firestore emulator, or reuses one already listening on the port in
`firebase.json`, and stops it afterwards. It needs Java (the emulator is a JAR) and the Firebase CLI.

> The emulator ports in `firebase.json` are deliberately **not** the Firebase defaults. The defaults collide
> with any other Firebase project's emulator suite running on the same machine, and a collision on the *hub*
> port tears down the whole suite — including Firestore — with an error that points nowhere near its cause.

### Experiments

`scripts/experiments/` holds the live-provider probes that turn assumptions into measurements. They are not
part of the application and each reports `BLOCKED` rather than failing when its credential is absent.

```bash
npm run experiment                 # everything runnable with what is configured
npm run experiment -- C1-align     # one experiment
```

---

## Project structure

```
app/             Next.js App Router — pages and route handlers
  api/           ingest (streamed), ask, comments, export, session, account
components/      the workspace: player, transcript, chat, receipts, viewers
lib/
  server/        the only place environment variables are read
src/
  domain/        pure logic, no I/O
    transcript.ts    cue model, receipt resolution, the cue-index invariant
    timing.ts        timestamp trust: sources, tolerances, precision
    interval.ts      temporal queries over a transcript
    blob.ts          gzip+base64 codec with a chunked fallback
    untrusted.ts     sanitising and prompt fencing for third-party text
  ingest/
    url.ts           YouTube URL parsing and host allowlist
    source.ts        the TranscriptSource port and degraded modes
    chain.ts         the fallback chain
    orchestrator.ts  cache, single-flight, provenance, storage
    sources/         Gemini, user-supplied, YouTube metadata adapters
  retrieval/
    lexical.ts       phrase search that spans cue boundaries
  answer/
    contract.ts      what a model may say, and how claims become receipts
    ask.ts           prompt construction and the question loop
  export/
    evidence-pack.ts the takeaway artifact, with a verbatim ceiling
  data/
    schema.ts        Firestore document shapes and collection paths
    firestore.ts     the storage adapters
scripts/experiments/ live-provider probes
tests/               offline suite, plus tests/emulator and tests/rules
```

---

## Security

Third-party text — transcripts, titles, descriptions, comments — is treated as data and never as instruction.

- **Sanitised at the boundary.** Zero-width characters, bidi overrides and the Unicode tag block are stripped
  where every transcript is built, so a payload that renders as nothing cannot reach storage or a model.
- **Fenced in context.** Untrusted text enters a prompt inside a delimited block carrying a per-call random
  nonce. A fixed delimiter is one the text can simply contain; a nonce it cannot guess is one it cannot close.
- **Deny-by-default storage.** Firestore rules are closed by default, user data is reachable only by its
  owner, and shared video knowledge is readable by signed-in users but writable only by the server.
- **Secrets stay server-side.** `GEMINI_API_KEY` and `YOUTUBE_API_KEY` are never `NEXT_PUBLIC_*`.

Homoglyphs are deliberately **not** folded. Confusable letters across scripts are a real trick, but rewriting
one script into another corrupts every legitimate comment not written in English — that is a detection
problem, not a normalisation one.

---

## Cost

VidSense is built to run on free tiers during development and early use.

- One document per video, not one per cue — the difference between roughly 6,600 and 13 videos per day on
  Firestore's free quota.
- The `videos/{id}` document **is** the cache. No separate cache tier.
- `videos.list` costs 1 quota unit and is the only metadata call; `search.list` costs 100 and is never used.
- No vector database, no object storage, no queue, no media pipeline.
- `MAX_DURATION_SEC` is set from a measured token rate (~103 prompt tokens per second of video against a
  1,048,576-token limit), so a video that could only fail at the provider is refused before it is paid for.

---

## Known limitations

- **Timestamps are approximate.** See the guarantees section above. Receipts state their own precision, and
  refuse to offer a jump link when they cannot support one.
- **No answer verifier.** Citations are guaranteed to point at real passages; nothing yet checks that a
  passage actually *supports* the claim attached to it. That is an entailment problem and it needs a verifier.
- **Watch history is not available.** YouTube's history playlist has returned empty since 2016; a Takeout
  import is the intended path and is not built.
- **Videos are never downloaded.** VidSense reads and reasons; it does not store or serve audiovisual bytes.
- Long videos beyond the measured single-call ceiling are refused rather than truncated.

---

## Contributing

The core is deliberately easy to work on without credentials: `npm test` runs the whole offline suite against
injected fakes.

Two conventions matter more than style:

1. **Provider behaviour is measured, not assumed.** If a change rests on how an external API behaves, add an
   experiment to `scripts/experiments/` and let it decide. Several assumptions in this repository have already
   been disproved that way.
2. **Claims in documentation must match the code.** A README that promises exact timestamps the system cannot
   deliver is a bug.

---

## License

Not yet licensed. All rights reserved.
