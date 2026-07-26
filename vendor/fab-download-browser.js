// Bounded Fab downloader and TAR writer for extension pages.
import {
  parseManifestFromBytes,
  decodeChunkPayload,
  chunkUrl,
  IncrementalSHA1,
} from '../lib/browser-manifest-parser.js';
import { debug } from '../lib/debug.js';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const MAX_CONCURRENT_CHUNKS = 6;
const CHUNK_LOOKAHEAD = MAX_CONCURRENT_CHUNKS * 2;
const MAX_LOOKAHEAD_INSPECTED_PARTS = 128;
const MAX_DECODED_CHUNK_BYTES = 128 * MiB;
const MAX_MANIFEST_RESPONSE_BYTES = 64 * MiB;
const MAX_CHUNK_RESPONSE_BYTES = 128 * MiB + 64 * 1024;
const LARGE_DOWNLOAD_CONFIRM_BYTES = 32 * GiB;
const MAX_TOTAL_PAYLOAD_BYTES = 512 * GiB;
const MAX_TOTAL_ARCHIVE_BYTES = 520 * GiB;
const MAX_TOTAL_NETWORK_BYTES = 512 * GiB;
const MANIFEST_TIMEOUT_MS = 30_000;
const CHUNK_TIMEOUT_MS = 60_000;
const FILE_CLEANUP_TIMEOUT_MS = 5_000;
const MAX_URL_LENGTH = 16 * 1024;
const MAX_QUERY_LENGTH = 16 * 1024;
const MAX_CDN_CANDIDATES = 4;
const MAX_TAR_PATH_BYTES = 32 * 1024;
const USTAR_MAX_SIZE = 8 * GiB - 1;
const ZERO512 = new Uint8Array(512);
const UTF8 = new TextEncoder();
const OUTPUT_RESERVATIONS = new WeakMap();
const STATIC_CDN_ORIGINS = new Set([
  'https://egdownload.fastly-edge.com',
  'https://epicgames-download1.akamaized.net',
  'https://egs-cloudfront-chunks.epicgamescdn.com',
]);
const WINDOWS_RESERVED_NAME =
  /^(con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/;

function abortError(message = 'Download cancelled') {
  return new DOMException(message, 'AbortError');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}

function checkedAdd(a, b, label) {
  const result = a + b;
  if (!Number.isSafeInteger(result)) {
    throw new Error(`${label} exceeds JavaScript's safe integer range`);
  }
  return result;
}

function checkedMultiply(a, b, label) {
  const result = a * b;
  if (!Number.isSafeInteger(result)) {
    throw new Error(`${label} exceeds JavaScript's safe integer range`);
  }
  return result;
}

function assertSafeInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is out of range`);
  }
  return value;
}

function reportProgress(callback, update) {
  if (!callback) return;
  try {
    callback(update);
  } catch (error) {
    debug.warn('Progress callback failed:', error?.message || String(error));
  }
}

async function downloadCheckpoint(signal, index) {
  throwIfAborted(signal);
  if (index > 0 && index % 2_048 === 0) {
    await new Promise(resolve => setTimeout(resolve, 0));
    throwIfAborted(signal);
  }
}

function normalizeAllowedOrigins(values) {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.length > MAX_CDN_CANDIDATES
  ) {
    throw new Error('At least one allowed CDN origin is required');
  }

  const result = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) {
      throw new Error('Allowed CDN origin is malformed');
    }
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error('Allowed CDN origin is malformed');
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      throw new Error('Allowed CDN origins must use HTTPS without credentials');
    }
    if (!STATIC_CDN_ORIGINS.has(parsed.origin)) {
      throw new Error('Allowed CDN origin is outside the extension static allowlist');
    }
    result.add(parsed.origin);
  }
  return result;
}

function validateDownloadUrl(value, allowedOrigins, label, { base = false } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) {
    throw new Error(`${label} is malformed`);
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is malformed`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`${label} must use HTTPS`);
  if (parsed.username || parsed.password) throw new Error(`${label} must not contain credentials`);
  if (parsed.hash) throw new Error(`${label} must not contain a fragment`);
  if (!allowedOrigins.has(parsed.origin)) throw new Error(`${label} uses an unapproved origin`);
  if (base && parsed.search) throw new Error(`${label} must provide its query separately`);
  return parsed;
}

function validateFinalResponseUrl(response, requestedUrl, allowedOrigins, label) {
  const finalValue = response.url || requestedUrl.href;
  return validateDownloadUrl(finalValue, allowedOrigins, `${label} final URL`);
}

function validateContentLength(response, maxBytes, label) {
  const value = response.headers?.get?.('content-length');
  if (value === null || value === undefined) return;
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error(`${label} has an invalid Content-Length`);
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes`);
  }
}

async function readResponseBytes(response, maxBytes, label) {
  validateContentLength(response, maxBytes, label);
  if (!response.body) {
    const result = new Uint8Array(await response.arrayBuffer());
    if (result.byteLength > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
    return result;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error(`${label} returned invalid binary data`);
      total = checkedAdd(total, value.byteLength, `${label} response size`);
      if (total > maxBytes) {
        await reader.cancel(`${label} is too large`).catch(() => {});
        throw new Error(`${label} exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function fetchBytesLimited(url, {
  allowedOrigins,
  maxBytes,
  timeoutMs,
  signal,
  label,
}) {
  throwIfAborted(signal);
  const requestedUrl = validateDownloadUrl(url, allowedOrigins, label);
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => controller.abort();
  signal?.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(requestedUrl.href, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    validateFinalResponseUrl(response, requestedUrl, allowedOrigins, label);
    if (!response.ok) {
      if (response.body && typeof response.body.cancel === 'function') {
        await response.body.cancel().catch(() => {});
      }
      throw new Error(`${label} returned HTTP ${response.status}`);
    }
    return await readResponseBytes(response, maxBytes, label);
  } catch (error) {
    controller.abort();
    if (signal?.aborted) throw abortError();
    if (timedOut) throw new Error(`${label} timed out after ${timeoutMs} ms`);
    if (isAbortError(error)) throw abortError();
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

function normalizeQuery(value, index) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX_QUERY_LENGTH || value.includes('#')) {
    throw new Error(`CDN query ${index + 1} is malformed`);
  }
  return value;
}

class BoundedChunkStore {
  constructor({
    chunkById,
    baseUrls,
    baseUrlQueries,
    manifestVersion,
    allowedOrigins,
    signal,
  }) {
    this.chunkById = chunkById;
    this.baseUrls = baseUrls;
    this.baseUrlQueries = baseUrlQueries;
    this.manifestVersion = manifestVersion;
    this.allowedOrigins = allowedOrigins;
    this.entries = new Map();
    this.queue = [];
    this.active = 0;
    this.reservedBytes = 0;
    this.clock = 0;
    this.downloadedGuids = new Set();
    this.attemptedPrefetchGuids = new Set();
    this.cancelled = false;
    this.controller = new AbortController();
    this.parentSignal = signal || null;
    this.forwardAbort = () => this.cancel();
    this.parentSignal?.addEventListener('abort', this.forwardAbort, { once: true });
    if (this.parentSignal?.aborted) this.cancel();
  }

  get stats() {
    return {
      active: this.active,
      downloaded: this.downloadedGuids.size,
      cachedBytes: this.reservedBytes,
    };
  }

  createEntry(guid) {
    if (this.cancelled) throw abortError();
    const chunk = this.chunkById.get(guid);
    if (!chunk) throw new Error(`Unknown chunk: ${guid}`);
    const decodedBytes = assertSafeInteger(
      chunk.windowSize,
      1,
      MAX_DECODED_CHUNK_BYTES,
      `Chunk ${guid} decoded size`,
    );
    const responseBytes = assertSafeInteger(
      chunk.fileSize,
      1,
      MAX_CHUNK_RESPONSE_BYTES,
      `Chunk ${guid} response size`,
    );
    const bufferedResponseBytes = checkedAdd(
      responseBytes,
      responseBytes,
      `Chunk ${guid} buffered response reservation`,
    );
    const estimate = checkedAdd(
      decodedBytes,
      bufferedResponseBytes,
      `Chunk ${guid} peak memory reservation`,
    );
    if (estimate > MAX_DECODED_CHUNK_BYTES) {
      throw new Error(`Chunk ${guid} exceeds the ${MAX_DECODED_CHUNK_BYTES} byte memory budget`);
    }

    let resolve;
    let reject;
    const promise = new Promise((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    const entry = {
      guid,
      chunk,
      estimate,
      promise,
      resolve,
      reject,
      state: 'queued',
      bytes: null,
      pins: 0,
      reserved: 0,
      lastUsed: ++this.clock,
      error: null,
    };
    this.entries.set(guid, entry);
    this.queue.push(entry);
    this.pump();
    return entry;
  }

  ensure(guid) {
    return this.entries.get(guid) || this.createEntry(guid);
  }

  prefetch(guids) {
    if (this.cancelled) return;
    for (const guid of guids) {
      if (this.attemptedPrefetchGuids.has(guid) && !this.entries.has(guid)) continue;
      this.attemptedPrefetchGuids.add(guid);
      try {
        this.ensure(guid).promise.catch(() => {});
      } catch (error) {
        if (!isAbortError(error)) debug.warn('Chunk prefetch rejected:', error.message);
      }
    }
  }

  async acquire(guid) {
    if (this.cancelled) throw abortError();
    const entry = this.ensure(guid);
    entry.pins++;
    entry.lastUsed = ++this.clock;
    try {
      const bytes = await entry.promise;
      if (this.cancelled) throw abortError();
      let released = false;
      return {
        bytes,
        release: () => {
          if (released) return;
          released = true;
          this.release(entry);
        },
      };
    } catch (error) {
      entry.pins--;
      this.pump();
      throw error;
    }
  }

  release(entry) {
    if (entry.pins <= 0) return;
    entry.pins--;
    entry.lastUsed = ++this.clock;
    this.pump();
  }

  evictOne() {
    let candidate = null;
    for (const entry of this.entries.values()) {
      if (entry.state !== 'ready' || entry.pins !== 0 || !entry.bytes) continue;
      if (!candidate || entry.lastUsed < candidate.lastUsed) candidate = entry;
    }
    if (!candidate) return false;
    this.entries.delete(candidate.guid);
    this.reservedBytes -= candidate.reserved;
    candidate.reserved = 0;
    candidate.bytes = null;
    return true;
  }

  makeRoom(requiredBytes) {
    while (this.reservedBytes + requiredBytes > MAX_DECODED_CHUNK_BYTES) {
      if (!this.evictOne()) return false;
    }
    return true;
  }

  pump() {
    if (this.cancelled) return;
    while (this.active < MAX_CONCURRENT_CHUNKS && this.queue.length > 0) {
      let selectedIndex = -1;
      for (let index = 0; index < this.queue.length; index++) {
        if (this.makeRoom(this.queue[index].estimate)) {
          selectedIndex = index;
          break;
        }
      }
      if (selectedIndex < 0) return;
      const [entry] = this.queue.splice(selectedIndex, 1);
      this.start(entry);
    }
  }

  start(entry) {
    entry.state = 'running';
    entry.reserved = entry.estimate;
    this.reservedBytes += entry.reserved;
    this.active++;

    this.downloadChunk(entry.chunk)
      .then(bytes => {
        if (this.cancelled) throw abortError();
        if (bytes.byteLength !== entry.chunk.windowSize) {
          throw new Error(
            `Chunk ${entry.guid} decoded size mismatch: expected ${entry.chunk.windowSize}, got ${bytes.byteLength}`,
          );
        }
        this.reservedBytes -= entry.reserved;
        entry.reserved = Math.max(bytes.byteLength, entry.chunk.fileSize || 0);
        this.reservedBytes += entry.reserved;
        entry.state = 'ready';
        entry.bytes = bytes;
        entry.lastUsed = ++this.clock;
        this.downloadedGuids.add(entry.guid);
        entry.resolve(bytes);
      })
      .catch(error => {
        entry.state = 'failed';
        entry.error = error;
        this.entries.delete(entry.guid);
        this.reservedBytes -= entry.reserved;
        entry.reserved = 0;
        entry.reject(error);
      })
      .finally(() => {
        this.active--;
        this.pump();
      });
  }

  async downloadChunk(chunk) {
    let lastError = null;
    for (let index = 0; index < this.baseUrls.length; index++) {
      throwIfAborted(this.controller.signal);
      try {
        const builtUrl = chunkUrl(
          chunk,
          this.baseUrls[index],
          this.manifestVersion,
          this.baseUrlQueries[index],
        );
        validateDownloadUrl(builtUrl, this.allowedOrigins, `Chunk ${chunk.guid}`);
        const raw = await fetchBytesLimited(builtUrl, {
          allowedOrigins: this.allowedOrigins,
          maxBytes: chunk.fileSize,
          timeoutMs: CHUNK_TIMEOUT_MS,
          signal: this.controller.signal,
          label: `Chunk ${chunk.guid} from CDN ${index + 1}`,
        });
        return await decodeChunkPayload(raw, chunk, { signal: this.controller.signal });
      } catch (error) {
        if (isAbortError(error) || this.controller.signal.aborted) throw abortError();
        lastError = error;
      }
    }
    throw new Error(
      `Chunk ${chunk.guid} failed on every CDN: ${lastError?.message || 'unknown error'}`,
    );
  }

  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    this.controller.abort();
    const error = abortError();
    for (const entry of this.queue) {
      entry.state = 'failed';
      this.entries.delete(entry.guid);
      entry.reject(error);
    }
    this.queue.length = 0;
    for (const entry of [...this.entries.values()]) {
      if (entry.state !== 'ready') continue;
      this.entries.delete(entry.guid);
      this.reservedBytes -= entry.reserved;
      entry.reserved = 0;
      entry.bytes = null;
    }
  }

  dispose() {
    this.cancel();
    this.parentSignal?.removeEventListener('abort', this.forwardAbort);
  }
}

function windowsNameKey(segment) {
  // NFKC + case folding is intentionally more conservative than any one host
  // filesystem. Distinct archive paths that commonly alias after extraction
  // are rejected instead of relying on platform-specific overwrite behavior.
  return segment.normalize('NFKC').toLocaleLowerCase('en-US');
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function validatePathSegment(segment, filename) {
  if (segment.length === 0 || segment === '.' || segment === '..') {
    throw new Error(`Unsafe TAR path "${filename}": empty or relative segment`);
  }
  if (/[\u0000-\u001f\u007f]/.test(segment)) {
    throw new Error(`Unsafe TAR path "${filename}": control character`);
  }
  if (/[<>:"|?*]/.test(segment)) {
    throw new Error(`Unsafe TAR path "${filename}": forbidden Windows character or NTFS ADS`);
  }
  if (/[. ]$/.test(segment)) {
    throw new Error(`Unsafe TAR path "${filename}": trailing dot or space`);
  }
  const stem = windowsNameKey(segment).split('.')[0];
  if (WINDOWS_RESERVED_NAME.test(stem)) {
    throw new Error(`Unsafe TAR path "${filename}": reserved Windows name`);
  }
}

function normalizeTarPath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Manifest contains an empty filename');
  }
  if (hasUnpairedSurrogate(value)) {
    throw new Error('Manifest filename contains invalid Unicode');
  }
  if (/^[\\/]/.test(value) || /^[/\\]{2}/.test(value) || /^[a-zA-Z]:/.test(value)) {
    throw new Error(`Unsafe TAR path "${value}": absolute, UNC, or drive path`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Unsafe TAR path "${value}": control character`);
  }

  const normalized = value.replace(/\\/g, '/').normalize('NFC');
  const segments = normalized.split('/');
  for (const segment of segments) validatePathSegment(segment, value);
  if (UTF8.encode(normalized).byteLength > MAX_TAR_PATH_BYTES) {
    throw new Error(`TAR path is longer than ${MAX_TAR_PATH_BYTES} UTF-8 bytes`);
  }
  return normalized;
}

async function preflightManifest(fileManifestList, chunkById, signal) {
  if (!Array.isArray(fileManifestList)) throw new Error('Manifest file list is malformed');
  const collisionMap = new Map();
  let payloadBytes = 0;
  let archiveBytes = 2 * ZERO512.byteLength;
  let chunkAttemptBytes = 0;
  let inspectedParts = 0;
  const referencedChunks = new Set();

  for (let fileIndex = 0; fileIndex < fileManifestList.length; fileIndex++) {
    await downloadCheckpoint(signal, fileIndex);
    const file = fileManifestList[fileIndex];
    if (!file || typeof file !== 'object') throw new Error(`File ${fileIndex} is malformed`);
    const path = normalizeTarPath(file.filename);
    const pathKey = windowsNameKey(path);
    const previous = collisionMap.get(pathKey);
    if (previous !== undefined) {
      throw new Error(`TAR paths collide on Windows: "${previous}" and "${path}"`);
    }
    collisionMap.set(pathKey, path);

    const fileSize = assertSafeInteger(
      file.fileSize,
      0,
      Number.MAX_SAFE_INTEGER,
      `File ${path} size`,
    );
    if (typeof file.fileHash !== 'string' || !/^[0-9a-fA-F]{40}$/.test(file.fileHash)
        || /^0{40}$/.test(file.fileHash)) {
      throw new Error(`File ${path} has no valid non-zero SHA-1`);
    }
    if (!Array.isArray(file.chunkParts)) throw new Error(`File ${path} chunk parts are malformed`);

    let partBytes = 0;
    for (let partIndex = 0; partIndex < file.chunkParts.length; partIndex++) {
      await downloadCheckpoint(signal, inspectedParts++);
      const part = file.chunkParts[partIndex];
      if (!part || typeof part !== 'object' || typeof part.guid !== 'string') {
        throw new Error(`File ${path} chunk part ${partIndex} is malformed`);
      }
      const chunk = chunkById.get(part.guid);
      if (!chunk) throw new Error(`File ${path} references unknown chunk ${part.guid}`);
      const offset = assertSafeInteger(
        part.offset,
        0,
        MAX_DECODED_CHUNK_BYTES,
        `File ${path} chunk part ${partIndex} offset`,
      );
      const size = assertSafeInteger(
        part.size,
        1,
        MAX_DECODED_CHUNK_BYTES,
        `File ${path} chunk part ${partIndex} size`,
      );
      const end = checkedAdd(offset, size, `File ${path} chunk part ${partIndex} range`);
      if (end > chunk.windowSize) {
        throw new Error(`File ${path} chunk part ${partIndex} exceeds chunk ${part.guid}`);
      }
      partBytes = checkedAdd(partBytes, size, `File ${path} chunk-part total`);
      chunkAttemptBytes = checkedAdd(
        chunkAttemptBytes,
        chunk.fileSize,
        'Worst-case chunk acquisition bytes',
      );
      referencedChunks.add(part.guid);
    }

    if (partBytes !== fileSize) {
      throw new Error(`File ${path} size mismatch: parts total ${partBytes}, expected ${fileSize}`);
    }
    payloadBytes = checkedAdd(payloadBytes, fileSize, 'Manifest payload size');
    if (payloadBytes > MAX_TOTAL_PAYLOAD_BYTES) {
      throw new Error(`Manifest payload exceeds the ${MAX_TOTAL_PAYLOAD_BYTES} byte safety limit`);
    }

    const split = splitUstarPath(path);
    const needsPaxPath = !split;
    const needsPaxSize = fileSize > USTAR_MAX_SIZE;
    if (needsPaxPath || needsPaxSize) {
      const fields = {};
      if (needsPaxPath) fields.path = path;
      if (needsPaxSize) fields.size = String(fileSize);
      const paxBytes = paxPayload(fields).byteLength;
      archiveBytes = checkedAdd(archiveBytes, 512, 'Estimated TAR PAX header size');
      archiveBytes = checkedAdd(archiveBytes, paxBytes, 'Estimated TAR PAX data size');
      archiveBytes = checkedAdd(
        archiveBytes,
        paddingFor(paxBytes),
        'Estimated TAR PAX padding',
      );
    }
    archiveBytes = checkedAdd(archiveBytes, 512, 'Estimated TAR header size');
    archiveBytes = checkedAdd(archiveBytes, fileSize, 'Estimated TAR payload size');
    archiveBytes = checkedAdd(
      archiveBytes,
      paddingFor(fileSize),
      'Estimated TAR file padding',
    );
    if (archiveBytes > MAX_TOTAL_ARCHIVE_BYTES) {
      throw new Error(`TAR output exceeds the ${MAX_TOTAL_ARCHIVE_BYTES} byte safety limit`);
    }

    // The parser owns this object, so normalize in place instead of cloning
    // every file and chunk part into a second multi-hundred-megabyte tree.
    file.filename = path;
    file.fileSize = fileSize;
    file.fileHash = file.fileHash.toLowerCase();
  }

  for (let fileIndex = 0; fileIndex < fileManifestList.length; fileIndex++) {
    await downloadCheckpoint(signal, fileIndex);
    const file = fileManifestList[fileIndex];
    const segments = file.filename.split('/');
    let prefix = '';
    for (let index = 0; index < segments.length - 1; index++) {
      prefix = prefix ? `${prefix}/${segments[index]}` : segments[index];
      const conflictingFile = collisionMap.get(windowsNameKey(prefix));
      if (conflictingFile !== undefined) {
        throw new Error(
          `TAR file/directory paths conflict: "${conflictingFile}" and "${file.filename}"`,
        );
      }
    }
  }

  // A prefetched chunk can be evicted before its first consumer and therefore
  // downloaded once more. attemptedPrefetchGuids ensures this extra allowance
  // is at most one request per referenced GUID.
  for (const guid of referencedChunks) {
    chunkAttemptBytes = checkedAdd(
      chunkAttemptBytes,
      chunkById.get(guid).fileSize,
      'Worst-case chunk prefetch bytes',
    );
  }

  return { files: fileManifestList, payloadBytes, archiveBytes, chunkAttemptBytes };
}

function splitUstarPath(path) {
  if (UTF8.encode(path).byteLength <= 100) return { name: path, prefix: '' };
  for (let slash = path.lastIndexOf('/'); slash > 0; slash = path.lastIndexOf('/', slash - 1)) {
    const prefix = path.slice(0, slash);
    const name = path.slice(slash + 1);
    if (UTF8.encode(prefix).byteLength <= 155 && UTF8.encode(name).byteLength <= 100) {
      return { name, prefix };
    }
  }
  return null;
}

function writeUtf8(buffer, offset, value, length, label) {
  const encoded = UTF8.encode(value);
  if (encoded.byteLength > length) throw new Error(`${label} does not fit in a TAR header`);
  buffer.set(encoded, offset);
}

function writeOctal(buffer, offset, value, length, label) {
  assertSafeInteger(value, 0, Number.MAX_SAFE_INTEGER, label);
  const octal = value.toString(8);
  if (octal.length > length - 1) throw new Error(`${label} does not fit in a TAR header`);
  writeUtf8(buffer, offset, `${octal.padStart(length - 1, '0')}\0`, length, label);
}

function tarHeader(path, size, typeflag = '0', mtime = Math.floor(Date.now() / 1000)) {
  const split = splitUstarPath(path);
  if (!split) throw new Error(`TAR header path is too long: ${path}`);
  const buffer = new Uint8Array(512);
  writeUtf8(buffer, 0, split.name, 100, 'TAR filename');
  writeOctal(buffer, 100, 0o644, 8, 'TAR mode');
  writeOctal(buffer, 108, 0, 8, 'TAR uid');
  writeOctal(buffer, 116, 0, 8, 'TAR gid');
  writeOctal(buffer, 124, size, 12, 'TAR size');
  writeOctal(buffer, 136, mtime, 12, 'TAR timestamp');
  buffer.fill(0x20, 148, 156);
  buffer[156] = typeflag.charCodeAt(0);
  writeUtf8(buffer, 257, 'ustar\0', 6, 'TAR magic');
  writeUtf8(buffer, 263, '00', 2, 'TAR version');
  writeUtf8(buffer, 345, split.prefix, 155, 'TAR prefix');

  let checksum = 0;
  for (const byte of buffer) checksum += byte;
  const encodedChecksum = `${checksum.toString(8).padStart(6, '0')}\0 `;
  writeUtf8(buffer, 148, encodedChecksum, 8, 'TAR checksum');
  return buffer;
}

function paxRecord(key, value) {
  const body = `${key}=${value}\n`;
  const bodyBytes = UTF8.encode(body).byteLength;
  let length = bodyBytes + 2;
  while (true) {
    const next = String(length).length + 1 + bodyBytes;
    if (next === length) return `${length} ${body}`;
    length = next;
  }
}

function paxPayload(values) {
  return UTF8.encode(Object.entries(values).map(([key, value]) => paxRecord(key, value)).join(''));
}

function paddingFor(size) {
  return (512 - (size % 512)) % 512;
}

function collectLookahead(files, fileIndex, partIndex) {
  const result = [];
  const seen = new Set();
  let inspectedParts = 0;
  for (
    let fi = fileIndex;
    fi < files.length &&
      result.length < CHUNK_LOOKAHEAD &&
      inspectedParts < MAX_LOOKAHEAD_INSPECTED_PARTS;
    fi++
  ) {
    const parts = files[fi].chunkParts;
    const start = fi === fileIndex ? partIndex : 0;
    for (
      let pi = start;
      pi < parts.length &&
        result.length < CHUNK_LOOKAHEAD &&
        inspectedParts < MAX_LOOKAHEAD_INSPECTED_PARTS;
      pi++
    ) {
      inspectedParts++;
      const guid = parts[pi].guid;
      if (seen.has(guid)) continue;
      seen.add(guid);
      result.push(guid);
    }
  }
  return result;
}

function sanitizeOutputBaseName(value) {
  let result = typeof value === 'string' ? value : '';
  if (hasUnpairedSurrogate(result)) result = 'asset';
  result = result.replace(/\.tar$/i, '');
  result = result.normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_');
  result = result.replace(/[. ]+$/g, '').trim();
  if (!result) result = 'asset';
  if (WINDOWS_RESERVED_NAME.test(windowsNameKey(result).split('.')[0])) result = `_${result}`;
  if (UTF8.encode(result).byteLength > 180) {
    const codePoints = Array.from(result);
    while (codePoints.length > 0 && UTF8.encode(codePoints.join('')).byteLength > 180) {
      codePoints.pop();
    }
    result = codePoints.join('');
  }
  return result || 'asset';
}

function isNotFoundError(error) {
  return error?.name === 'NotFoundError' || error?.name === 'NotFound';
}

function reservationSet(dirHandle) {
  let reservations = OUTPUT_RESERVATIONS.get(dirHandle);
  if (!reservations) {
    reservations = new Set();
    OUTPUT_RESERVATIONS.set(dirHandle, reservations);
  }
  return reservations;
}

function randomOutputToken() {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('Secure random output naming is unavailable in this browser');
  }
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

async function createUniqueOutput(dirHandle, outputBaseName, signal) {
  const base = sanitizeOutputBaseName(outputBaseName);
  const reservations = reservationSet(dirHandle);

  for (let attempt = 0; attempt < 32; attempt++) {
    throwIfAborted(signal);
    // File System Access has no exclusive-create primitive. An unpredictable
    // 96-bit suffix makes cross-tab/external check-then-create collisions
    // negligible, while the in-page reservation prevents duplicate jobs.
    const name = `${base}__${randomOutputToken()}.tar`;
    const key = windowsNameKey(name);
    if (reservations.has(key)) continue;
    reservations.add(key);
    try {
      let exists = false;
      try {
        await dirHandle.getFileHandle(name);
        exists = true;
      } catch (error) {
        if (error?.name === 'TypeMismatchError') {
          exists = true;
        } else if (!isNotFoundError(error)) {
          throw error;
        }
      }
      if (exists) {
        reservations.delete(key);
        continue;
      }
      const fileHandle = await dirHandle.getFileHandle(name, { create: true });
      return {
        fileHandle,
        filename: name,
        release: () => reservations.delete(key),
      };
    } catch (error) {
      reservations.delete(key);
      throw error;
    }
  }
  throw new Error('Could not reserve a unique output filename');
}

async function withOperationTimeout(operation, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function removeNewOutput(dirHandle, filename) {
  try {
    await withOperationTimeout(
      dirHandle.removeEntry(filename),
      FILE_CLEANUP_TIMEOUT_MS,
      `Removing incomplete output ${filename}`,
    );
    return null;
  } catch (error) {
    return error;
  }
}

async function writeTar({
  files,
  chunkStore,
  dirHandle,
  outputBaseName,
  signal,
  onProgress,
}) {
  throwIfAborted(signal);
  const output = await createUniqueOutput(dirHandle, outputBaseName, signal);
  let writer = null;
  let closed = false;
  let archiveBytes = 0;
  let payloadBytes = 0;
  const mtime = Math.floor(Date.now() / 1000);

  const write = async bytes => {
    throwIfAborted(signal);
    await writer.write(bytes);
    archiveBytes = checkedAdd(archiveBytes, bytes.byteLength, 'TAR output size');
  };

  try {
    writer = await output.fileHandle.createWritable();
    reportProgress(onProgress, {
      phase: 'downloading',
      current: 0,
      total: files.length,
      totalWritten: archiveBytes,
      payloadWritten: payloadBytes,
      filename: output.filename,
    });

    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const file = files[fileIndex];
      throwIfAborted(signal);

      const split = splitUstarPath(file.filename);
      const needsPaxPath = !split;
      const needsPaxSize = file.fileSize > USTAR_MAX_SIZE;
      if (needsPaxPath || needsPaxSize) {
        const fields = {};
        if (needsPaxPath) fields.path = file.filename;
        if (needsPaxSize) fields.size = String(file.fileSize);
        const payload = paxPayload(fields);
        const paxName = `PaxHeaders.X/${fileIndex.toString(36)}`;
        await write(tarHeader(paxName, payload.byteLength, 'x', mtime));
        await write(payload);
        const paxPad = paddingFor(payload.byteLength);
        if (paxPad) await write(ZERO512.subarray(0, paxPad));
      }

      const storedPath = needsPaxPath ? `PaxFiles/${fileIndex.toString(36)}` : file.filename;
      const storedSize = needsPaxSize ? 0 : file.fileSize;
      await write(tarHeader(storedPath, storedSize, '0', mtime));

      const hasher = new IncrementalSHA1();
      let fileBytes = 0;
      for (let partIndex = 0; partIndex < file.chunkParts.length; partIndex++) {
        throwIfAborted(signal);
        chunkStore.prefetch(collectLookahead(files, fileIndex, partIndex));
        const part = file.chunkParts[partIndex];
        const lease = await chunkStore.acquire(part.guid);
        try {
          const end = checkedAdd(part.offset, part.size, `File ${file.filename} chunk range`);
          if (end > lease.bytes.byteLength) {
            throw new Error(`File ${file.filename} chunk part exceeds decoded chunk ${part.guid}`);
          }
          const slice = lease.bytes.subarray(part.offset, end);
          if (slice.byteLength !== part.size) {
            throw new Error(`File ${file.filename} chunk part was truncated`);
          }
          await hasher.updateAsync(slice, { signal });
          await write(slice);
        } finally {
          lease.release();
        }
        fileBytes = checkedAdd(fileBytes, part.size, `File ${file.filename} bytes`);
        payloadBytes = checkedAdd(payloadBytes, part.size, 'Written payload bytes');
        reportProgress(onProgress, {
          phase: 'file_progress',
          current: fileIndex,
          total: files.length,
          filename: file.filename,
          fileBytes,
          fileSize: file.fileSize,
          totalWritten: archiveBytes,
          payloadWritten: payloadBytes,
          chunkDownloaded: chunkStore.stats.downloaded,
          totalChunks: chunkStore.chunkById.size,
        });
      }

      if (fileBytes !== file.fileSize) {
        throw new Error(`File ${file.filename} wrote ${fileBytes} bytes, expected ${file.fileSize}`);
      }
      const actualHash = await hasher.digest();
      if (actualHash !== file.fileHash) throw new Error(`SHA-1 mismatch: ${file.filename}`);

      const pad = paddingFor(file.fileSize);
      if (pad) await write(ZERO512.subarray(0, pad));
      reportProgress(onProgress, {
        phase: 'downloading',
        current: fileIndex + 1,
        total: files.length,
        filename: file.filename,
        totalWritten: archiveBytes,
        payloadWritten: payloadBytes,
        chunkDownloaded: chunkStore.stats.downloaded,
        totalChunks: chunkStore.chunkById.size,
      });
    }

    reportProgress(onProgress, {
      phase: 'finalizing',
      current: files.length,
      total: files.length,
      filename: output.filename,
      totalWritten: archiveBytes,
      payloadWritten: payloadBytes,
    });
    await write(ZERO512);
    await write(ZERO512);
    throwIfAborted(signal);
    await writer.close();
    closed = true;
    reportProgress(onProgress, {
      phase: 'done',
      current: files.length,
      total: files.length,
      filename: output.filename,
      totalWritten: archiveBytes,
      payloadWritten: payloadBytes,
    });
    return {
      filename: output.filename,
      files: files.length,
      totalBytes: archiveBytes,
      payloadBytes,
    };
  } catch (error) {
    chunkStore.cancel();
    const cleanupFailures = [];
    if (writer && !closed) {
      try {
        await withOperationTimeout(
          writer.abort(),
          FILE_CLEANUP_TIMEOUT_MS,
          `Aborting incomplete output ${output.filename}`,
        );
      } catch (abortFailure) {
        cleanupFailures.push(abortFailure);
      }
    }
    const removalFailure = await removeNewOutput(dirHandle, output.filename);
    if (removalFailure) cleanupFailures.push(removalFailure);
    if (cleanupFailures.length > 0) {
      const details = cleanupFailures
        .map(failure => failure?.message || String(failure))
        .join('; ');
      throw new Error(
        `${error?.message || String(error)}. Incomplete output "${output.filename}" may remain; remove it manually. Cleanup error: ${details}`,
        { cause: error },
      );
    }
    if (signal?.aborted && !isAbortError(error)) throw abortError();
    throw error;
  } finally {
    output.release();
  }
}

function validateDownloadInputs({
  manifestUrls,
  baseUrls,
  baseUrlQueries,
  allowedOrigins,
  dirHandle,
  outputBaseName,
  signal,
  onProgress,
  confirmLargeDownload,
}) {
  const origins = normalizeAllowedOrigins(allowedOrigins);
  if (
    !Array.isArray(manifestUrls) ||
    manifestUrls.length === 0 ||
    manifestUrls.length > MAX_CDN_CANDIDATES
  ) {
    throw new Error('At least one manifest URL is required');
  }
  if (
    !Array.isArray(baseUrls) ||
    baseUrls.length === 0 ||
    baseUrls.length > MAX_CDN_CANDIDATES
  ) {
    throw new Error('At least one chunk base URL is required');
  }
  if (baseUrlQueries !== undefined && !Array.isArray(baseUrlQueries)) {
    throw new Error('CDN queries must be an array');
  }
  if (baseUrlQueries && baseUrlQueries.length > baseUrls.length) {
    throw new Error('There are more CDN queries than base URLs');
  }
  if (!dirHandle || typeof dirHandle.getFileHandle !== 'function'
      || typeof dirHandle.removeEntry !== 'function') {
    throw new Error('A writable directory handle is required');
  }
  if (
    typeof outputBaseName !== 'string' ||
    outputBaseName.length === 0 ||
    outputBaseName.length > 4_096
  ) {
    throw new Error('An output base name is required');
  }
  if (signal !== undefined && signal !== null
      && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function')) {
    throw new Error('signal must be an AbortSignal');
  }
  if (onProgress !== undefined && onProgress !== null && typeof onProgress !== 'function') {
    throw new Error('onProgress must be a function');
  }
  if (
    confirmLargeDownload !== undefined &&
    confirmLargeDownload !== null &&
    typeof confirmLargeDownload !== 'function'
  ) {
    throw new Error('confirmLargeDownload must be a function');
  }

  const validatedManifestUrls = manifestUrls.map((url, index) =>
    validateDownloadUrl(url, origins, `Manifest URL ${index + 1}`).href);
  const validatedBaseUrls = baseUrls.map((url, index) =>
    validateDownloadUrl(url, origins, `Chunk base URL ${index + 1}`, { base: true }).href.replace(/\/$/, ''));
  const queries = validatedBaseUrls.map((_, index) =>
    normalizeQuery(baseUrlQueries?.[index], index));

  return {
    manifestUrls: validatedManifestUrls,
    baseUrls: validatedBaseUrls,
    baseUrlQueries: queries,
    allowedOrigins: origins,
  };
}

async function validateParsedManifest(manifest, signal) {
  const { chunkDataList, fileManifestList, version } = manifest || {};
  if (!Array.isArray(chunkDataList) || !Array.isArray(fileManifestList)) {
    throw new Error('Parsed manifest is incomplete');
  }

  const chunkById = new Map();
  for (let chunkIndex = 0; chunkIndex < chunkDataList.length; chunkIndex++) {
    await downloadCheckpoint(signal, chunkIndex);
    const chunk = chunkDataList[chunkIndex];
    if (!chunk || typeof chunk.guid !== 'string') throw new Error('Manifest chunk is malformed');
    if (chunkById.has(chunk.guid)) throw new Error(`Manifest contains duplicate chunk ${chunk.guid}`);
    assertSafeInteger(
      chunk.windowSize,
      1,
      MAX_DECODED_CHUNK_BYTES,
      `Chunk ${chunk.guid} decoded size`,
    );
    assertSafeInteger(
      chunk.fileSize,
      1,
      MAX_CHUNK_RESPONSE_BYTES,
      `Chunk ${chunk.guid} response size`,
    );
    chunkById.set(chunk.guid, chunk);
  }

  const preflight = await preflightManifest(fileManifestList, chunkById, signal);
  return { chunkById, preflight, version };
}

/**
 * Download an Epic manifest and its chunks directly into a unique TAR file.
 *
 * Required input:
 *   manifestUrls, baseUrls, allowedOrigins, dirHandle, outputBaseName
 * Optional input:
 *   baseUrlQueries (parallel to baseUrls), signal, onProgress
 *
 * Resolves to:
 *   { filename, files, totalBytes, payloadBytes }
 */
export async function downloadAsset({
  manifestUrls,
  baseUrls,
  baseUrlQueries = [],
  allowedOrigins,
  dirHandle,
  outputBaseName,
  signal = null,
  onProgress = null,
  confirmLargeDownload = null,
}) {
  const validated = validateDownloadInputs({
    manifestUrls,
    baseUrls,
    baseUrlQueries,
    allowedOrigins,
    dirHandle,
    outputBaseName,
    signal,
    onProgress,
    confirmLargeDownload,
  });
  throwIfAborted(signal);
  reportProgress(onProgress, {
    phase: 'manifest',
    current: 0,
    total: 0,
    totalWritten: 0,
    payloadWritten: 0,
  });

  let parsed = null;
  let manifestError = null;
  for (let index = 0; index < validated.manifestUrls.length; index++) {
    throwIfAborted(signal);
    try {
      const manifestBytes = await fetchBytesLimited(validated.manifestUrls[index], {
        allowedOrigins: validated.allowedOrigins,
        maxBytes: MAX_MANIFEST_RESPONSE_BYTES,
        timeoutMs: MANIFEST_TIMEOUT_MS,
        signal,
        label: `Manifest from CDN ${index + 1}`,
      });
      reportProgress(onProgress, {
        phase: 'parsing',
        current: index,
        total: validated.manifestUrls.length,
        totalWritten: 0,
        payloadWritten: 0,
      });
      parsed = await validateParsedManifest(
        await parseManifestFromBytes(manifestBytes, { signal }),
        signal,
      );
      break;
    } catch (error) {
      if (isAbortError(error)) throw error;
      manifestError = error;
    }
  }
  if (!parsed) {
    throw new Error(
      `Manifest failed on every CDN: ${manifestError?.message || 'unknown error'}`,
    );
  }

  const { chunkById, preflight, version } = parsed;
  const {
    files,
    payloadBytes: expectedPayloadBytes,
    archiveBytes: expectedArchiveBytes,
    chunkAttemptBytes,
  } = preflight;
  const expectedNetworkBytes = checkedMultiply(
    chunkAttemptBytes,
    validated.baseUrls.length,
    'Worst-case chunk transfer bytes across CDN candidates',
  );
  if (expectedNetworkBytes > MAX_TOTAL_NETWORK_BYTES) {
    throw new Error(`Chunk transfer estimate exceeds the ${MAX_TOTAL_NETWORK_BYTES} byte safety limit`);
  }
  if (
    expectedArchiveBytes > LARGE_DOWNLOAD_CONFIRM_BYTES ||
    expectedNetworkBytes > LARGE_DOWNLOAD_CONFIRM_BYTES
  ) {
    throwIfAborted(signal);
    const confirmed = confirmLargeDownload
      ? await confirmLargeDownload({
        payloadBytes: expectedPayloadBytes,
        archiveBytes: expectedArchiveBytes,
        networkBytes: expectedNetworkBytes,
      })
      : false;
    throwIfAborted(signal);
    if (confirmed !== true) {
      throw new DOMException('Large download was not confirmed.', 'AbortError');
    }
  }
  debug.log(
    'Validated manifest:',
    files.length,
    'files,',
    chunkById.size,
    'chunks, version:',
    version,
    'expected payload/archive bytes:',
    expectedPayloadBytes,
    expectedArchiveBytes,
    'worst-case chunk transfer bytes:',
    expectedNetworkBytes,
  );

  const chunkStore = new BoundedChunkStore({
    chunkById,
    baseUrls: validated.baseUrls,
    baseUrlQueries: validated.baseUrlQueries,
    manifestVersion: version,
    allowedOrigins: validated.allowedOrigins,
    signal,
  });
  try {
    return await writeTar({
      files,
      chunkStore,
      dirHandle,
      outputBaseName,
      signal,
      onProgress,
    });
  } finally {
    chunkStore.dispose();
  }
}
