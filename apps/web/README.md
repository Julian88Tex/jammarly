# Jammarly web app

The companion web app for the Jammarly Chrome extension: owner login, device pairing, profile sync, suggestion
tuning, the voice-learning job and a small dashboard. Next.js 16 App Router on Vercel (Node, Fluid Compute), one
private Vercel Blob store, no database. Design: [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) section 4.

```
src/app/api/**            route handlers (every one is nodejs + force-dynamic, answers JSON with CORS headers)
src/app/(dashboard)/**    Overview, Tuning, Voice, Learning, Privacy and data (server components + client islands)
src/lib/env.ts            zod-validated environment, parsed at request time (never at import)
src/lib/blob.ts           BlobStore interface: VercelBlobStore (private store, ifMatch CAS, useCache:false) and MemoryBlobStore
src/lib/store.ts          profile CAS (3 retries), version cache, snapshots, ops allowlist + clock skew + quota, quota.json
src/lib/devices.ts        devices.json: token hashes, revoke, rotate (5 min grace)
src/lib/pairing.ts        pairing start / redeem (10 min, single use)
src/lib/events.ts         events/<day>/<device>.jsonl + samples/… + events/index.json (never list() on the hot path)
src/lib/learning/job.ts   idempotent, resumable learning job with checkpoints in runs/<date>-<ctx>.json
src/lib/learning/data.ts  summary, export, delete-all
src/proxy.ts              redirects dashboard paths to /login when the session cookie is missing
scripts/hash-password.mjs prints OWNER_PASSWORD_HASH for a password
tests/**                  vitest (node) against the in-memory blob store
```

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `SESSION_SECRET` | yes, ≥ 32 chars | Seals the `jammarly_session` cookie (iron-session v9) and derives the AES-256-GCM key that protects the server-side API key at rest. |
| `OWNER_PASSWORD_HASH` | yes | `scrypt$N=16384,r=8,p=1$<base64url salt>$<base64url 32-byte hash>`, produced by `scripts/hash-password.mjs`. |
| `CRON_SECRET` | yes, ≥ 16 chars | Vercel sends it as `Authorization: Bearer …` on cron invocations; `/api/cron/synthesize` accepts nothing else. |
| `APP_ORIGIN` | yes | The production **domain alias**, e.g. `https://jammarly-web.vercel.app` (never `VERCEL_URL`). Used for cookie settings, same-origin checks and the pairing message's `appOrigin`. |
| `EXTENSION_IDS` | yes (may be empty locally) | Comma-separated extension ids allowed as CORS origins (`chrome-extension://<id>`), e.g. `hkobmhfcoefpipbfkihdbbkgblckhkae`. |
| `ANTHROPIC_API_KEY` | optional | Server-side key for the learning job. A key entered on the Tuning page (stored encrypted) takes precedence. Devices never receive either. |
| `BLOB_READ_WRITE_TOKEN` | optional | Only outside Vercel. On Vercel the `@vercel/blob` SDK uses OIDC for the private store bound to the project. Without a token or OIDC the app uses an in-memory store (local dev, tests). |

Missing or malformed variables fail at request time with a `500 { error: { code: 'internal', message: 'Missing or invalid environment variables: …' } }`; nothing is read at import or build time.

### Hashing the owner password

```bash
node scripts/hash-password.mjs 'my long password'          # argument
printf '%s' 'my long password' | node scripts/hash-password.mjs   # or stdin
# scrypt$N=16384,r=8,p=1$Xk...$9f...
```

Paste the output into `OWNER_PASSWORD_HASH`. To change the password, run the script again and redeploy.

### Local development

```bash
cd apps/web
export SESSION_SECRET="$(openssl rand -base64 48)"
export OWNER_PASSWORD_HASH="$(node scripts/hash-password.mjs 'dev password')"
export CRON_SECRET="$(openssl rand -hex 16)"
export APP_ORIGIN=http://localhost:3000
export EXTENSION_IDS=hkobmhfcoefpipbfkihdbbkgblckhkae
npm run dev        # in-memory blob store unless BLOB_READ_WRITE_TOKEN is set
npm test           # vitest, 80 tests
npm run typecheck
npm run build
```

## API

All bodies are JSON; errors are `{ error: { code, message } }` with `ApiErrorCode` from `@jammarly/shared/api`.
Auth legend: **S** owner session cookie (same-origin only, extension origins rejected with 403), **D** device bearer
token `jm1.<deviceId>.<secret>` (browser origins other than an allowed extension rejected with 403), **C** `Bearer CRON_SECRET`.

| Route | Auth | Notes |
|---|---|---|
| `POST /api/auth/login` `{ password }` | – | ≥ 400 ms, 5 failures per IP → 60 s lockout (the WAF rule is the real limiter). Sets the cookie. |
| `POST /api/auth/logout` | S | Clears the cookie. |
| `GET /api/devices` | S | `DevicesListResponse` |
| `POST /api/devices/pair/start` | S | `PairStartResponse` (16-hex id, 6-digit code, 10 min) |
| `POST /api/devices/pair/redeem` | – | `PairRedeemRequest` → `PairRedeemResponse`, single use; 400 `pairing_invalid`, 410 `pairing_expired` |
| `POST /api/devices/[id]/revoke` | S | next device request → 401 `device_revoked` |
| `POST /api/devices/[id]/rotate` | D (own id) | `RotateResponse`; previous token valid 5 min |
| `GET /api/profile` | S or D | `If-None-Match` → 304 (served from a 60 s cache when the ETag was just written or read), else `ProfileGetResponse` + `ETag` + `X-Profile-Version` |
| `PUT /api/profile` | S or D | full document with `If-Match` → 200, or 412 `ProfilePutConflict` with `current`. Devices cannot overwrite `voice.profiles` or `learning`. |
| `POST /api/profile/ops` | S or D | `ProfileOpsRequest` → `ProfileOpsResponse`; allowlist (devices: `set`/`add`/`remove` on `LwwPath`/`SetPath` only), `hlc_skew` (> 5 min ahead), `schema_invalid`, 10 writes/hour/device → 429 `quota_exceeded`; 412 `conflict_retry` after 3 lost CAS races |
| `GET /api/profile/version` | S or D | `ProfileVersionResponse`, `Cache-Control: private, max-age=60`, 60 s module cache |
| `POST /api/events` | D | `EventsUploadRequest` (≤ 500 events) → `EventsUploadResponse`; snippets stripped and samples dropped server-side when `privacy.storeSnippets` is false; 6 batches/device/day → 429 |
| `GET /api/learning/summary` | S | `LearningSummary` over the last 28 days (previous 28 for trends) |
| `POST /api/learning/run` | S | `LearningRunRequest` → `LearningRunResponse`; ≤ 3 manual runs/day; runs after the response with `after()` |
| `GET /api/learning/status` | S | `LearningRunStatus` of the latest run (404 before the first) |
| `DELETE /api/learning/data` | S | `LearningDataDeleteResponse`: events, samples, snapshots, runs, dictionary candidates, voice profiles (replaced by empty higher-version profiles so devices adopt the deletion), learning counters reset with a new `updatedHlc` |
| `GET /api/export` | S | `ExportResponse` |
| `GET` / `PUT { apiKey }` / `DELETE /api/server-key` | S | `ServerKeyStatusResponse` (hint = last 4 characters) |
| `GET /api/cron/synthesize?ctx=messages\|documents` | C | runs the learning job for that context, returns `LearningRunStatus` |
| `GET /api/health` | – | `{ ok, version }`; with an owner cookie also `{ blob: { month, advancedOps, simpleOps, limits, perDevice } }` |

### Blob layout (private store)

```
users/owner/profile.json                 the profile document (ETag CAS)
users/owner/version.json                 { version, etag }, rewritten after every profile write
users/owner/snapshots/profile.v<N>.json  every 10th version and after each synthesis
users/owner/devices.json                 { devices: DeviceInfo & { tokenHash, revoked?, prevTokenHash?, prevValidUntil? }[] }
users/owner/events/<YYYY-MM-DD>/<deviceId>.jsonl   one append per upload (read + concat + put)
users/owner/events/index.json            batches with day, device, offset, count, uploadedAt
users/owner/samples/<YYYY-MM-DD>/<deviceId>.jsonl
users/owner/runs/<date>-<ctx>.json       learning-job checkpoints (the persistent log); runs/latest.json points at the newest
users/owner/server-key.json              AES-256-GCM box (HKDF of SESSION_SECRET)
users/owner/quota.json                   { month, advancedOps, simpleOps, perDevice }
auth/pairings/<pairingId>.json           { codeHash, expiresAt, used } (deleted on redeem)
```

## Pairing flow

1. Owner signs in and presses **Pair a device** on Overview. The page calls `POST /api/devices/pair/start` and shows the
   6-digit code.
2. The page calls `chrome.runtime.sendMessage(id, { type: 'jammarly.pair', pairingId, code, appOrigin })` for every id in
   `EXTENSION_IDS`. The extension's service worker accepts the message only when `sender.origin` equals its compiled
   `APP_ORIGIN`, then calls `POST /api/devices/pair/redeem` itself and stores the returned token in
   `chrome.storage.local`. The page polls `GET /api/devices` and shows "Paired".
3. Fallback (extension not installed in this browser, or the call errors): the user types the code into the extension's
   options page, which performs the same redeem.
4. The pairing record is single use and expires after 10 minutes. The server stores only `sha256(secret)`; the token is
   returned exactly once, together with the current profile, ETag and version.

## Learning job

`GET /api/cron/synthesize?ctx=messages` at 03:00 UTC and `?ctx=documents` at 04:00 UTC (see `vercel.json`; Hobby runs
once a day, ±59 min). Stages, each checkpointed in `runs/<date>-<ctx>.json` and skipped on resume: **fold** (events
since `learning.lastEventCursor` → counters, rule states, dictionary candidates; purge past `retentionDays`),
**synthesize** (`nothing_new` below 20 new events and 1,500 new sampled words; `server_key_missing` without a key;
`claude-opus-5-5`, structured output, effort medium, `max_tokens` 8000, `maxRetries 0`, timeout from `getDeadline()`
minus 20 s; a refusal or `max_tokens` stop keeps the previous version and lands in `learning.history`), **lint** (regex
plus a `claude-haiku-5-5` yes/no classifier), **store** (`voice` op, snapshot, history capped at 30). With under 20 s
left a stage records `partial` and the next invocation resumes. **Run now** on the Learning page is the manual retry.

## Deployment checklist (architecture §4)

1. Create the Vercel project `jammarly-web` linked to `Julian88Tex/jammarly` with root directory `apps/web`, Fluid
   Compute on, Node 24. `npm install` at the repo root (workspaces) and `outputFileTracingRoot` are already configured.
2. Create the **private** Blob store and bind it to the project (OIDC; no token needed on Vercel).
3. Set the environment variables: `SESSION_SECRET`, `OWNER_PASSWORD_HASH`, `CRON_SECRET` (sensitive, production +
   preview), `APP_ORIGIN` (the production alias), `EXTENSION_IDS` (plain), optionally `ANTHROPIC_API_KEY` (sensitive;
   the Tuning page can store a key instead).
4. Add one WAF rate-limit rule covering `/api/auth/login` and `/api/devices/pair/*` (e.g. 20 requests per 60 s per IP,
   deny). Keep Deployment Protection at Standard so the production alias stays public and cron reaches it.
5. Deploy from the branch; the push registers the two crons from `vercel.json`. Verify the cron log after the first
   night and `GET /api/health`.
6. Build the extension with `JAMMARLY_APP_ORIGIN` set to the same alias and record its id in `EXTENSION_IDS`; the
   extension's `externally_connectable.matches` must equal exactly `[APP_ORIGIN + '/*']`.
7. Sign in, pair the first device from Overview, confirm the extension shows "paired", then watch Overview's Blob
   usage meters (warning at 80 % of the Hobby budget).
