# VidSense AI

**Understand every video.**

VidSense AI turns a YouTube video into searchable, evidence-grounded knowledge — so you can ask questions
about it, find the moment something was said, and see the words that back every answer.

> Ask. Explore. Understand.

---

## Status

**Feature-complete and deployable. The application runs end to end.**

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
| Evidence Pack export, and copy-with-link per receipt | ✅ implemented |
| Web application — landing, workspace, player, chat, history, settings | ✅ implemented |
| Google sign-in over a signed, server-verified session | ✅ implemented |
| Per-user daily limits and a deployment-wide ceiling | ✅ implemented |
| 30-day retention, enforced by a scheduled sweep | ✅ implemented |
| Content Security Policy and security headers | ✅ implemented |
| Structured logging, health endpoint, deployment smoke test | ✅ implemented |
| Data deletion | ✅ implemented |
| Notes and bookmarks | ✅ implemented |
| Takeout watch-history import | ✅ implemented |
| Entailment gate — does a citation *support* its claim? | ✅ implemented, off by default |
| Cross-video search, embeddings, App Check, published eval set | ✖ not built — see [Known limitations](#known-limitations) |

---

## What makes it different

Most tools turn a video into an answer. VidSense aims to turn it into a **record**: an answer whose every
claim carries a verbatim quote, the moment it came from, and an honest statement of how precisely that
moment is known.

That last part is doing real work, and it is worth being specific about.

### Timestamp guarantees, and their limits

**Three different things can go wrong with a citation.**

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

**Optional — a citation that points somewhere real but does not support its claim.** A model can cite a real
passage for a statement that passage does not back, and the result looks exactly like evidence. The entailment
gate checks each claim against its own quote, with the question deliberately withheld so a verifier told what
answer was wanted cannot confirm it. A claim whose citation fails keeps its words and **loses its receipt**.

It is off by default (`VERIFY_ANSWERS=1` turns it on) because it costs roughly one extra model call per claim.
Measured on 2026-09-08 over 35 labelled pairs: **0 false positives on 15 definitively-true citations**, 100%
recall on 10 cross-video mismatches. That was the number worth blocking on — a gate that destroys correct
receipts would damage the product more than the problem it fixes. Its recall on *near-miss* pairings, where a
claim is cited to an adjacent passage that almost supports it, is **not** measured.

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
The same rule governs **Copy with link**: a citation on the clipboard says "time not established" rather than
naming a moment nobody can stand behind.

A transcript that never states its timing defaults to the least trustworthy source. Precision has to be
earned, not assumed.

**One exception, and it goes the other way.** Your own notes and bookmarks *are* exact. Their timestamps come
from the player's clock at the moment you pressed the button, not from a transcript, so they carry no tolerance
and always jump precisely. It is the one place in the product where a plain timestamp is the honest thing to
show.

### A refusal is a finding

When the transcript does not cover a question, VidSense says so and says what it read: *"I searched all 1,284
lines of this transcript, covering 47 minutes of video. This video does not address that question, and
nothing here is being inferred for you."* The
sentence names the corpus because "this video does not address that question" on its own is also what a model
says when it did not look, and a reader has no way to tell the two apart.

---

## Architecture

```
  YouTube URL
      |
      v
  parse + host allowlist        rejects javascript:, data:, lookalike hosts
      |
      v
  QUOTA                         burst limit -> per-user daily budget ->
      |                         deployment-wide ceiling. Before any provider
      |                         call, because a check after one has already
      |                         spent the thing it protects
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

- **TypeScript**, Node ≥ 20
- **Next.js 16** (App Router) + **Tailwind CSS 4** — one deployable, server secrets never reach the browser
- **Firebase** — Cloud Firestore for storage, Firebase Auth (Google) for sign-in
- **Gemini** — transcript acquisition from a YouTube URL, and answering
- **YouTube Data API v3** — public metadata and comments
- **Vitest** — the whole test suite, offline by default

No animation library, no component library, no state library, no vector database, no queue, no cache tier.
Each of those is an absence with a reason behind it rather than a gap.

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
| `GEMINI_API_KEY` | Transcript acquisition and answering. Server-side only | yes |
| `YOUTUBE_API_KEY` | Video metadata and comments. Server-side only | yes |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Firebase web config | for sign-in |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | Firebase web config | for sign-in |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | Firebase web config | for sign-in |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | Firebase web config | for sign-in |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | Admin SDK — a path, or the JSON inline | for storage and sign-in |
| `USE_FIREBASE_EMULATOR` | Route local traffic to the emulator | local dev only |
| `NEXT_PUBLIC_SITE_URL` | The public origin, for link previews and `robots.txt` | when deployed |
| `CRON_SECRET` | Authorises the daily retention sweep | when deployed |
| `GEMINI_MODEL` | Override the default model | no |
| `VERIFY_ANSWERS` | `1` turns on the entailment gate | no |
| `INGESTS_PER_DAY` | Videos one user may analyse per day (default 5) | no |
| `ASKS_PER_DAY` | Questions one user may ask per day (default 50) | no |
| `VIDEO_SECONDS_PER_DAY` | Video one user may send per day (default 5 hours) | no |
| `INGESTS_PER_MINUTE` | Burst limit on analysing (default 3) | no |
| `ASKS_PER_MINUTE` | Burst limit on asking (default 12) | no |
| `DEPLOYMENT_VIDEO_SECONDS_PER_DAY` | Video the whole deployment may send per day (default 7 hours) | no |
| `DEPLOYMENT_INGESTS_PER_DAY` | Videos the whole deployment may analyse per day (default 100) | no |
| `DEPLOYMENT_ASKS_PER_DAY` | Questions the whole deployment may answer per day (default 1000) | no |

The `NEXT_PUBLIC_FIREBASE_*` values are publishable by design — Firebase web config is not a secret, and
safety comes from Security Rules and App Check rather than from hiding it. `GEMINI_API_KEY`,
`YOUTUBE_API_KEY`, `FIREBASE_SERVICE_ACCOUNT_PATH` and `CRON_SECRET` are secrets and must never be exposed to
a browser. `npm run scan:secrets` runs in CI as the last gate before anything is pushed.

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
npm run scan:secrets    # no credentials in tracked files
npm run smoke -- https://your-deployment   # against a live deployment
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
  api/           ingest (streamed), ask, comments, export, session, account,
                 annotations, watch-history, health, maintenance/sweep
components/      the workspace: player, transcript, chat, receipts, viewers
  ui.tsx         the shared primitives — button, notice, skeleton, empty state
lib/
  security-headers.ts  the CSP and the headers that carry no per-request part
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
    takeout.ts       Google Takeout history parsing, client-side
    source.ts        the TranscriptSource port and degraded modes
    chain.ts         the fallback chain
    orchestrator.ts  cache, single-flight, provenance, storage
    sources/         Gemini, user-supplied, YouTube metadata adapters
  retrieval/
    lexical.ts       phrase search that spans cue boundaries
  answer/
    contract.ts      what a model may say, and how claims become receipts
    ask.ts           prompt construction and the question loop
    verify.ts        the entailment gate
  quota/           burst limiter and the daily budget arithmetic
  export/
    evidence-pack.ts the takeaway artifact, with a verbatim ceiling
    citation.ts      one receipt, on the clipboard
  data/
    schema.ts        Firestore document shapes and collection paths
    firestore.ts     the storage adapters
    annotations.ts   notes and bookmarks, whose timestamps are exact
    watch-history.ts an imported history, as one compressed document
    usage.ts         the per-user daily ledger
    deployment.ts    the deployment-wide ceiling, with reservations
    retention.ts     deleting what the 30-day window has closed on
proxy.ts         visitor identity and the per-request CSP nonce
scripts/         experiments, the secret scanner, the deployment smoke test
tests/           offline suite, plus tests/emulator and tests/rules
```

---

## Security

Third-party text — transcripts, titles, descriptions, comments — is treated as data and never as instruction.

- **Sanitised at the boundary.** Zero-width characters, bidi overrides and the Unicode tag block are stripped
  where every transcript is built, so a payload that renders as nothing cannot reach storage or a model.
- **Fenced in context.** Untrusted text enters a prompt inside a delimited block carrying a per-call random
  nonce. A fixed delimiter is one the text can simply contain; a nonce it cannot guess is one it cannot close.
- **A nonce-based Content Security Policy**, with no `unsafe-inline` for scripts and an explicit host list —
  the YouTube player and Google sign-in, and nothing else. `frame-ancestors 'none'`, so a signed-in session
  can never be framed. `npm run smoke` asserts the policy is present, that its nonce changes per request, and
  that every script Next emits carries it.
- **Sessions are signed.** Signing in exchanges a Firebase ID token for a session cookie the Admin SDK mints
  and verifies. The cookie never holds a bare uid, and the anonymous visitor id is accepted only in the shape
  this server mints, so it cannot name a Firebase account.
- **Deny-by-default storage.** Firestore rules are closed by default, user data is reachable only by its
  owner, shared video knowledge is readable by signed-in users but writable only by the server, and the
  deployment's own quota ledger is denied to every client for reading as well as writing.
- **Secrets stay server-side.** `GEMINI_API_KEY` and `YOUTUBE_API_KEY` are never `NEXT_PUBLIC_*`, a scanner
  runs over every tracked file in CI, and the smoke test checks the deployed page source too.
- **Logs carry no user content.** One JSON line per event to stdout, with identities as a short non-reversible
  hash and no question, transcript, comment or title in any field.

Homoglyphs are deliberately **not** folded. Confusable letters across scripts are a real trick, but rewriting
one script into another corrupts every legitimate comment not written in English — that is a detection
problem, not a normalisation one.

---

## Cost

VidSense is built to run on free tiers during development and early use.

- One document per video, not one per cue — the difference between roughly 6,600 and 13 videos per day on
  Firestore's free quota. An imported watch history is stored the same way, for the same reason: a year of
  viewing is tens of thousands of entries against a budget of 20,000 writes a day.
- The `videos/{id}` document **is** the cache. No separate cache tier.
- `videos.list` costs 1 quota unit and is the only metadata call; `search.list` costs 100 and is never used.
- No vector database, no object storage, no queue, no media pipeline.
- `MAX_DURATION_SEC` is set from a measured token rate (~103 prompt tokens per second of video against a
  1,048,576-token limit), so a video that could only fail at the provider is refused before it is paid for.
- **Per-user daily limits are enforced before any provider call.** The free tiers are shared across every
  user at once — Gemini's YouTube-URL path allows roughly 8 hours of video a day for the whole project, not
  per person — so one person in a loop would otherwise end everybody's day. Counted in videos, in questions
  and in seconds of video, because a count of videos cannot bound hours of video on its own. A cache hit is
  refunded; so is a failed ingest, and a question that could not be answered. Settings shows what is left.
- **A deployment-wide ceiling sits behind those**, because a signed-out identity is a cookie and per-user
  caps therefore bound one honest person rather than ten arrivals. Because a video's length is unknown until
  its metadata has been fetched, an ingest reserves the worst case up front and settles to the real duration
  the moment a provider call becomes certain — measured at 259 ms, rather than holding it for the length of
  a transcription. So what the deployment has promised can never exceed the ceiling, however many requests
  arrive together, without the ceiling filling up with videos that turned out to be short. Reservations
  expire, so a request that dies mid-flight cannot hold the budget until midnight.
- **Only what the provider actually watched is billed as hours.** A pasted transcript is parsed locally, so
  it counts as an ingest and costs no video time; a video refused for being too long, or one that does not
  exist, never reaches a source and costs nothing at all. A provider call that failed *is* charged, because
  it was still made.

---

## Deployment

**One Next.js deployment on Vercel, in `bom1` (Mumbai), plus the Firebase project.** There is no separate
backend, and the reason is arithmetic rather than preference:

| Constraint | Requirement | Hobby plan |
|---|---|---|
| Ingest waits on a provider transcribing a video | `maxDuration = 300` | 300 s default **and** maximum |
| The retention sweep runs on a schedule | once a day | 100 cron jobs, minimum interval once a day |
| Takeout import posts ids and timestamps | ~200 KB | 4.5 MB body limit |
| Card required | none | none |

*(Vercel limits verified 2026-09-12.)* Cloud Run remains the plan for later scale: its always-free tier
requires an active billing account, so choosing it now would end the zero-cost constraint to buy nothing the
Hobby plan does not already provide. `bom1` rather than the default US region because Firestore is in
`asia-south1` and every request makes several round trips to it.

`vercel.json` carries the region and the daily cron. Deploying is: import the repository, set the environment
variables above, add the deployment's hostname to Firebase's authorized domains, and
`firebase deploy --only firestore:rules`. Then:

```bash
npm run smoke -- https://your-deployment
```

Nine checks against the live URL — health, the security headers, the CSP nonce reaching Next's scripts, the
404, the sweep refusing an unauthenticated caller, `robots.txt`, and no secret in the page source. It
analyses nothing, so it spends no provider quota and is safe to run repeatedly.

**Vercel's Hobby plan is non-commercial.** VidSense must move to a paid plan before it charges anyone.

---

## Known limitations

- **Timestamps are approximate.** See the guarantees section above. Receipts state their own precision, and
  refuse to offer a jump link when they cannot support one.
- **The entailment gate is off by default** and its recall on near-miss pairings is unmeasured. It is proven
  not to destroy correct citations, which is a different and weaker claim than being proven to catch bad ones.
- **Generator and verifier are the same model family.** A cross-vendor verifier would be stronger; the
  architecture rules v1 to a single provider, so this is noted rather than solved.
- **There is no published accuracy number.** Measuring one honestly needs a labelled evaluation set built by
  hand across dozens of videos, and that has not been done. Nothing here claims a percentage.
- **Cross-video search does not exist.** Everything is scoped to one video, which is what makes the
  no-embeddings design correct rather than lazy.
- **App Check is not enabled.** The Firestore rules already deny a client everything it should not reach, so
  this is defence in depth rather than a hole — but it is not on.
- **The burst limiter is per process.** Across several instances each gets its own window. It shapes traffic;
  the daily budget and the deployment ceiling are what bound spend, and both are persisted.
- **Two deployments sharing one Gemini key would each get a full allowance.** The ceiling is per Firestore
  project. Nothing in code can see that; it is a deployment rule, not a mechanism.
- **Watch history comes from Takeout, not an API.** YouTube's history playlist has returned empty since 2016,
  and the Data Portability API is EU/Switzerland/UK only. The import reads your archive **in the browser** and
  sends only video ids and watch times; it stores no titles, so the watched list shows ids until you open one.
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
