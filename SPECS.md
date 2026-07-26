# Fab Content Downloader — Technical Specification

## 1. System boundaries

Fab Content Downloader is a Chrome Manifest V3 extension with four execution contexts:

```text
Popup ───────────────┐
                     │ authenticated runtime messages
Library page ────────┼────────► Service Worker ─────► Epic OAuth / Fab API
        │            │
        │            │
        └────────────┘
        │
        └──── validated HTTPS fetch ────────────────► Epic CDN

Epic OAuth redirect page
        └──── top-frame Content Script ─────────────► Service Worker
```

The Service Worker is the only context that handles OAuth token exchange, refresh credentials, and Bearer-authenticated Fab API calls. The Library page downloads public or signed Manifest/chunk URLs directly under extension host permissions. No generic URL-fetch proxy is exposed through runtime messaging.

The extension has no developer backend, analytics or telemetry code/endpoint, externally connectable messaging surface, or Chrome Web Store integration.

Asset authorization remains controlled by Epic/Fab. The extension only presents artifacts returned for the authenticated account; it does not grant ownership or access to additional content.

Library cards may embed HTTPS thumbnail URLs returned by the Fab API, including hosts such as `media.fab.com`. These are ordinary `<img>` requests with `referrerPolicy: no-referrer`, not authenticated API or downloadable-content requests. Thumbnail URLs are accepted only when they use HTTPS and contain no user information. They do not require an extension host permission, are not covered by the download descriptor origin allowlist, and are never read through canvas or another pixel-access API.

## 2. Components

| Component | Responsibility |
| --- | --- |
| `manifest.json` | MV3 entry points, Chrome 103 minimum version, storage and HTTPS host permissions |
| `popup/` | Login status, starting OAuth, logout, and opening the Library |
| `content/oauth-capture.js` | Reads an Epic redirect result in the expected top-level OAuth tab and submits one authorization code |
| `background/service-worker.js` | Message authorization, OAuth lifecycle, account-scoped Library synchronization, authenticated Fab API calls, and download descriptor creation |
| `library/` | Library rendering, filters, immutable download jobs, directory selection, direct Manifest/CDN requests, cancellation, and user-visible status |
| `lib/auth.js` | OAuth request construction, code exchange, refresh, and token validation |
| `lib/storage.js` | Trusted-context token storage, OAuth transaction state, authentication generation, and IndexedDB Library cache |
| `lib/browser-manifest-parser.js` | Bounded JSON/binary Manifest parsing, chunk decoding, metadata validation, and streaming file hashing |
| `vendor/fab-download-browser.js` | Bounded chunk scheduler and TAR/PAX writer |

## 3. Trust model and message ACL

Every runtime request is treated as untrusted input. The router validates:

- `sender.id` equals the current extension ID;
- the sender context and exact extension page path;
- the OAuth sender URL, tab ID, and top-frame `frameId`;
- action-specific field types, lengths, counts, and unknown fields;
- the current authentication epoch and pending transaction where applicable.

The action allowlist is:

| Sender | Allowed actions |
| --- | --- |
| Popup page | `auth:start`, `auth:status`, `auth:logout`, `library:status` |
| Library page | `library:list`, `library:refresh`, `manifest:prepare`, `manifest:cancel` |
| Expected Epic OAuth top-frame Content Script | `auth:code` for the current pending transaction |
| Any other sender | None |

Responses never include an access token, refresh token, OAuth verifier, client secret, or authorization code. Logs omit Bearer credentials and URL query strings. The OAuth callback receives only the display name needed for its success message; no account identifier or credential is broadcast.

## 4. OAuth and authentication lifecycle

### 4.1 Login transaction

Starting login creates a cryptographically random transaction ID and an OAuth tab. The pending transaction is stored in `chrome.storage.session` with:

- transaction ID;
- OAuth tab ID and top-frame ID;
- creation and expiry timestamps;
- current authentication epoch;
- optional OAuth `state`;
- optional PKCE code verifier.

The transaction expires after at most five minutes. The callback must come from the bound Epic redirect URL, the exact tab, and frame `0`. A matching callback atomically consumes the transaction before code exchange; it cannot be replayed. A callback that fails sender, transaction, expiry, or optional state validation is rejected without consuming a different valid transaction.

Two independent compatibility switches govern Epic endpoint capabilities:

- **State switch:** adds a random `state` to the authorization request and requires an exact callback match.
- **PKCE switch:** derives an S256 code challenge from a random verifier and supplies the verifier during code exchange.

Each switch is enabled only for an endpoint behavior confirmed by the manual live compatibility test. Tab/frame binding, five-minute expiry, one-time consumption, and authentication-epoch checks apply in every configuration.

There is no manual authorization-code input or generic code-exchange message.

### 4.2 Token placement

| Record | Storage | Fields |
| --- | --- | --- |
| Refresh credential | `chrome.storage.local` | `refreshToken`, `accountId`, optional `refreshExpiresAt` |
| Access credential | `chrome.storage.session` | `accessToken`, `accountId`, optional `displayName`, `expiresAt`, `authEpoch` |
| Pending OAuth | `chrome.storage.session` | Transaction fields described above |
| Authentication epoch | `chrome.storage.session` | Non-negative safe integer |

Both storage areas use `TRUSTED_CONTEXTS`, preventing direct Content Script access. A Service Worker restart retains session storage; a browser restart can retain only the refresh credential, so the worker obtains a new access credential before authenticated API use.

Chrome extension storage is not an operating-system-backed secret vault. `TRUSTED_CONTEXTS` prevents direct Content Script reads, but software or a person with access to the operating-system account or Chrome profile may still recover the persisted refresh credential. Chrome profiles, extension storage dumps, real tokens, authorization codes, and signed URL query values must not be committed, packaged, or shared.

### 4.3 Refresh and logout

At most one refresh request is active for an account and authentication epoch; concurrent consumers share the same Promise. Each login, refresh, and code exchange captures the current authentication epoch. A completed interactive login commits its new refresh credential and atomically advances the session epoch with the matching access credential. Refresh writes use the captured epoch, so an old-account refresh cannot overwrite that login or a logout regardless of response order.

An explicit OAuth `invalid_grant` clears credentials only if the initiating epoch still matches. Network errors, timeouts, rate limits, and 5xx responses keep the refresh credential intact so the user can retry.

Logout increments the epoch before clearing access, refresh, and pending OAuth records. It also clears the Library cache for the authenticated account.

Authentication-generation changes are broadcast to open extension pages without a token or account identifier. An open Library page clears its in-memory model and DOM, invalidates pending folder-picker continuations, and aborts direct downloads before accepting work for another generation.

### 4.4 Shared OAuth client identity

The source contains the fixed `launcherAppClient2` OAuth client ID and client secret used for Epic Games Launcher-compatible token exchange. The client secret is an OAuth Basic-authentication credential, not an SSL/TLS private key, certificate, or content-encryption key. It is shared client material and does not change with the installation machine or extension installation.

Because the credential must be present in a distributed client, the design does not treat its confidentiality as a security boundary. Wider disclosure can nevertheless increase the chance of copying, abuse, rate limiting, identification, rotation, or revocation, any of which may break login compatibility. The repository should therefore remain private for normal operation, and the credential should not be repeated in logs, screenshots, release notes, or discussions.

This specification does not establish that Epic imposes an enforceable confidentiality or non-reuse obligation on this shared client identity. It is not legal advice and does not imply authorization from Epic; maintainers and users remain responsible for checking the terms and law applicable to them.

## 5. Account-scoped Library cache

Library data is stored in the `fab-library-cache` IndexedDB database.

| Object store | Key | Contents |
| --- | --- | --- |
| `libraryItems` | `[accountId, assetId]` | Account ID, asset ID, stable position, and a UI-normalized `LibraryItem` |
| `libraryMeta` | `accountId` | `schemaVersion`, `cachedAt`, `totalCount`, and `complete: true` |

`LibraryItem` contains only fields needed by the UI: asset identity and namespace, title, seller/type labels, HTTPS image references, and project-version artifact/engine/platform metadata.

Replacing a cache uses one read/write transaction across both stores:

1. remove records for the target account;
2. write the complete normalized item set;
3. write `complete: true` metadata;
4. commit atomically.

A failed transaction preserves the previous complete snapshot. A snapshot is current for 24 hours; an older complete snapshot may be returned as a visibly stale network-failure fallback. Expiry does not itself delete the account-scoped snapshot. Logout, account switch, or extension removal performs that lifecycle cleanup. Incomplete, wrong-schema, count-mismatched, duplicate-ID, or cross-account records are never displayed.

Failure to persist the cache does not turn a successful network response into a Library failure. The response carries `cacheSaved: false`, and the fresh in-memory items remain usable.

## 6. Library synchronization

The Service Worker requests pages from the authenticated account endpoint with `count=100`. One synchronization enforces:

- 30-second timeout per page;
- five-minute total deadline;
- at most 500 pages;
- at most 50,000 unique assets;
- a bounded string cursor;
- repeated-cursor detection;
- no-progress page detection;
- response-shape and safe-integer validation;
- deduplication by `assetId`.

HTTP 429 and retryable 5xx responses are retried at most twice. `Retry-After` is honored within the total deadline. A failure never stores a partial snapshot.

The Library page associates each request with a monotonically increasing UI generation. Results from an older generation are ignored. Refresh keeps the current grid visible and disables duplicate refresh requests. Search and filters evaluate the complete result set, while at most 1,000 matching cards are mounted at once; the count asks the user to narrow larger result sets.

Library results use:

```text
status: ok | auth_expired | error
source: network | cache | stale
cacheSaved: boolean
warning?: string
```

Only `source: network` produces a “refresh succeeded” message. `source: stale` explicitly tells the user that a previous complete snapshot is being displayed.

## 7. Download descriptor and network policy

### 7.1 Preparation

Directory selection is the first asynchronous operation after a download click. Cancelling the picker creates no job, network request, or output file.

After selection, the Library page creates an immutable `jobId` and sends artifact identity to `manifest:prepare`. The Service Worker:

1. obtains a valid access token;
2. calls the Bearer-authenticated Fab artifact endpoint;
3. validates the response and distribution points;
4. returns a `DownloadDescriptor` without any OAuth credential.

The descriptor contains artifact/build identity, up to four candidate signed Manifest URLs, chunk base URLs, per-origin Manifest query values, the Fab-provided `manifestHash` field when present, and the exact allowed CDN origins for that job. The live compatibility test must establish the hash field's encoding and whether it covers raw Manifest bytes before it can be used as an additional trust anchor.

### 7.2 Direct fetch policy

The Library page fetches Manifest and chunk bytes directly. Every request must satisfy all of:

- HTTPS scheme;
- no URL user information;
- origin present in the static extension CDN allowlist;
- origin present in the current `DownloadDescriptor`;
- redirects are rejected; the requested and final `response.url` must remain on the approved origin.

The current compatibility policy pairs each base URL with the first Manifest URL returned for the same origin, then forwards that Manifest query to every derived chunk URL for that pair. Query values are never logged. The release compatibility test must confirm this same-origin pairing and whether signed and unsigned forms produce identical bytes; there is no unverified per-path policy claim.

All requests use a job-owned `AbortSignal`, an operation timeout, and a body-size limit. Cancelling a job aborts active fetches rather than only suppressing UI updates.

### 7.3 Scheduler and memory budget

The Library permits at most two simultaneous download jobs. Each job scheduler allows at most six active chunk requests. It prefetches only chunks near the next TAR write position, examines at most 128 part references per lookahead operation, deduplicates requests for the same GUID, and guarantees every queued Promise settles as success, failure, or cancellation.

Compressed, in-flight, and decompressed cached chunk data are accounted against a 128 MiB job budget. Least-recently-used data with no active consumer is evicted before starting more work. TAR entries are written in Manifest order even when network requests complete out of order.

The job state machine is:

```text
picking → preparing → parsing → downloading → finalizing → done
                                      └───────────────→ cancelled
                         any non-cancel failure ──────→ error
```

The Library page associates every progress update with its immutable job state. Final completion is never throttled and includes the actual output name and byte count.

## 8. Parsing and integrity

### 8.1 Resource limits

| Resource | Limit |
| --- | ---: |
| Raw Manifest response | 64 MiB |
| JSON Manifest | 32 MiB |
| Decompressed binary Manifest | 128 MiB |
| Manifest chunks / files / total parts | 65,536 / 65,536 / 524,288 |
| Compressed chunk payload | 64 MiB |
| Fetched chunk response | Declared `fileSize`, at most 128 MiB + 64 KiB |
| Decompressed chunk payload | 128 MiB |
| Large-work confirmation threshold | 32 GiB estimated TAR or chunk transfer |
| Total described file payload | 512 GiB |
| Estimated TAR/PAX output | 520 GiB |
| Worst-case chunk transfer across CDN fallback | 512 GiB |
| Unique Library assets | 50,000 |

Decompression uses an output-counting stream and fails closed when a limit, format check, or declared length is violated. Decompression errors are never interpreted as uncompressed input.

Manifest preflight rejects empty parts and computes payload, TAR/PAX headers, padding, terminators, and a conservative chunk-transfer upper bound before creating the output or requesting a chunk. The network bound includes one possible prefetch per GUID, one possible acquisition per part, and every CDN fallback candidate. An archive or transfer estimate above 32 GiB requires explicit user confirmation; the 512/520 GiB hard limits cannot be overridden.

### 8.2 Manifest formats

The parser auto-detects:

- Epic binary Manifest magic `0x44BEC00C`;
- JSON Manifest structures with Epic PascalCase metadata.

JSON feature levels through 13 and unencrypted binary feature levels through 21 are accepted. Known binary section versions and chunk headers v1–v3 are parsed fail closed. Binary feature 22+ introduces encryption-related semantics, and chunk header v4+ is rejected until a real format fixture and authentication rules are implemented.

Every reader is bounded to its containing section. Counts, offsets, sizes, GUIDs, hashes, strings, and section boundaries must be representable as safe integers and fit within available bytes and configured limits. Unknown versions, mandatory flags, or trailing structural contradictions reject the Manifest. Large normalization loops and streaming SHA-1 periodically yield and re-check cancellation.

Chunk paths are derived only from validated metadata:

```text
{baseUrl}/{Chunks|ChunksV2|ChunksV3|ChunksV4}/{group}/{hash}_{guid}.chunk
```

The selected layout through `ChunksV4` follows the validated unencrypted Manifest feature level.

### 8.3 Chunk and file validation

For each chunk, the downloader validates:

- expected URL origin and path;
- chunk magic, header size, storage flags, and supported compression;
- GUID against the requested chunk;
- declared compressed and uncompressed sizes against actual bytes;
- part offset and length against the decompressed payload;
- rolling-hash metadata consistency between Manifest and chunk header;
- chunk payload SHA-1 when a non-zero SHA-1 is provided by the Manifest or header.

The Epic rolling hash is not recomputed from payload bytes. Final integrity therefore does not rely on it: for each file, all referenced parts must cover exactly the declared file size, and file SHA-1 must be present, non-zero, correctly encoded, and equal the streaming SHA-1 computed while writing. Any mismatch aborts the whole job and the output writer.

## 9. TAR/PAX output

All Manifest paths are validated before the first archive byte is written. Validation rejects:

- empty, absolute, UNC, or drive-qualified paths;
- `.` or `..` segments;
- NUL and control characters;
- Windows alternate-data-stream syntax;
- Windows reserved device names;
- segments ending in a dot or space;
- collisions after slash normalization, Unicode normalization, and Windows case folding;
- file-versus-directory prefix conflicts such as `a` and `a/b`.

Regular paths use USTAR headers and 512-byte alignment. Valid UTF-8 paths that do not fit USTAR and file sizes that do not fit the octal size field use POSIX PAX extended headers. Paths and sizes are never silently truncated.

The selected directory is used to create and stream the final TAR; chunks remain in the bounded per-job memory cache rather than being staged as temporary files in that directory. A single TAR also avoids asking Chrome to create every executable, plugin, or library file such as `.dll` and `.exe` individually.

The output name is:

```text
<sanitized-title>__<build-version>__<stable-asset-artifact-hash>__<96-bit-random>.tar
```

The random suffix compensates for the File System Access API's lack of an exclusive-create primitive across tabs and external processes. The extension also checks the chosen name and reserves it within the current page. This makes accidental collision negligible but is not a formal atomic no-overwrite guarantee against a process deliberately racing the exact generated name. Cleanup targets only that job's unpredictable filename.

`FileSystemWritableFileStream.close()` is called only after two zero TAR terminator blocks and successful file verification. Network, parser, integrity, cancellation, or disk errors call `abort()`. Abort and deletion each have a bounded cleanup wait. A newly created incomplete output is removed when the API permits; if cleanup fails, the job becomes an error and names the file that may require manual deletion. It is never reported as done.

Structural and hash validation establishes that the archive matches the accepted Manifest; it does not establish that the asset is safe to execute. A TAR may contain executables, plugins, or scripts. Users should inspect archives with trusted tools, extract into an isolated directory, and avoid overwriting important projects or system paths.

## 10. Permissions and network destinations

| Permission or host | Purpose |
| --- | --- |
| `storage` | Trusted local/session authentication state and extension storage access |
| `www.epicgames.com` | Expected OAuth redirect page |
| Epic account public service | OAuth token exchange and refresh |
| `www.fab.com` | Authenticated Library and artifact Manifest metadata |
| Fastly, Akamai, and Epic CloudFront CDN hosts | Direct signed Manifest and chunk download |
| Fab-provided HTTPS thumbnail hosts | Ordinary `no-referrer` Library card image loads; no pixel read |
| User-selected directory handle | Create one non-overwriting TAR output |

Host permissions are a maximum capability, not sufficient authorization for a request. Descriptor-origin checks and validation of the locally derived chunk path remain mandatory.

Fab-provided thumbnail hosts are not extension host permissions and are not download destinations. They receive the browser's ordinary image request for the HTTPS URL supplied by Fab. Extension code does not attach an OAuth Bearer credential or explicitly attach or read cookies, although Chrome may apply its normal ambient-cookie policy to the image request.

## 11. Manual verification and release contract

### 11.1 Distribution model

The project has no automatic CI release, automatic GitHub Release, or Chrome Web Store publication. The supported distribution is a manually reviewed ZIP loaded through Chrome Developer mode. The ZIP root must directly contain `manifest.json`.

A release uses an explicit file allowlist. It contains the runtime extension files and assets plus:

- `README.md`;
- `SPECS.md`;
- `LICENSE`.

It excludes `.git`, `.github`, tests, logs, download outputs, Chrome profiles, temporary files, real tokens, authorization codes, storage dumps, and complete signed URLs. Before publication, the maintainer inspects the archive file list and performs one final **Load unpacked** smoke test from the extracted ZIP.

### 11.2 Manual Chrome smoke test

Before a manual release, use a dedicated Chrome test profile to verify:

- a clean extracted directory loads without popup, Library, Service Worker, or console startup errors;
- login succeeds, while reloading or resubmitting the same OAuth callback cannot complete login again;
- closing and reopening Chrome restores the session through the refresh credential, and `chrome.storage.local` contains no access token;
- logout returns the popup to the logged-out state, clears credentials, removes the previous account cache, clears open Library cards, and stops active downloads;
- two different accounts never display each other's cached Library data;
- a normal multi-page Library refresh completes, while a failed offline refresh visibly retains only a previous complete stale snapshot;
- cancelling the directory picker creates no job or output and sends no Manifest or chunk request;
- at least one JSON Manifest asset and one supported unencrypted binary Manifest asset download successfully, with the observed feature and chunk-header versions recorded in a redacted test note; extract each TAR, compare its file count with the accepted Manifest, and confirm the completion message reports the actual output;
- binary feature 22+ and chunk header v4+ remain fail-closed until real fixtures and authentication rules justify support;
- two versions of one asset produce different output names, and repeated downloads of one version receive different random suffixes without overwriting the previous file;
- cancelling an active download stops its network requests and never reports an incomplete archive as successful; a cleanup failure names the exact file requiring manual removal;
- a large real asset keeps active chunk requests at or below six per job and does not show unbounded chunk-memory growth in Chrome Task Manager;
- rejecting a synthetic workload above the 32 GiB confirmation threshold creates no TAR and requests no chunk;
- a redacted live compatibility check covers signed-query forwarding, redirect behavior, current Manifest/chunk versions, and the Fab `manifestHash` field.

### 11.3 Local validation boundary

JavaScript syntax checks and local synthetic fixtures cover authentication races, pagination bounds, malformed Manifest structures, decompression limits, integrity failures, dangerous TAR/PAX paths, scheduler limits, cancellation, size confirmation, and collision-resistant output naming.

Malformed Manifest data, invalid hashes, unsafe paths, and oversized responses are tested locally. Tests must not deliberately send abnormal payloads to Epic or Fab services. Live compatibility records must remove credentials, tokens, authorization codes, account identifiers, and signed query values.

No commit, tag, ZIP creation, or manual test result implies permission to push. The reviewed commit range is pushed only after explicit user approval of that exact revision.
