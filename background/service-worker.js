// Fab Content Downloader — privileged extension boundary.
//
// Only this service worker may hold OAuth credentials or call authenticated Fab
// endpoints. Library pages receive a deliberately small, display-only model and
// short-lived CDN descriptors for jobs they created.

import {
  buildOAuthUrl,
  exchangeCode,
  isInvalidGrant,
  isTokenExpired,
  refreshToken,
} from "../lib/auth.js";
import {
  bumpAuthEpoch,
  clearAccessAuth,
  clearAuth,
  clearLibraryCache,
  clearPendingOAuth,
  commitAuth,
  consumePendingOAuth,
  getAuth,
  getAuthEpoch,
  getLibraryCache,
  initializeStorage,
  isLibraryCacheValid,
  setAuth,
  setLibraryCache,
  setPendingOAuth,
} from "../lib/storage.js";

const FAB_ORIGIN = "https://www.fab.com";
const EPIC_REDIRECT_ORIGIN = "https://www.epicgames.com";
const EPIC_REDIRECT_PATH = "/id/api/redirect";
const POPUP_URL = chrome.runtime.getURL("popup/popup.html");
const LIBRARY_URL = chrome.runtime.getURL("library/library.html");

const CDN_ORIGINS = new Set([
  "https://egdownload.fastly-edge.com",
  "https://epicgames-download1.akamaized.net",
  "https://egs-cloudfront-chunks.epicgamescdn.com",
]);

const OAUTH_TRANSACTION_TTL_MS = 5 * 60 * 1000;
const LIBRARY_PAGE_TIMEOUT_MS = 30 * 1000;
const LIBRARY_TOTAL_TIMEOUT_MS = 5 * 60 * 1000;
const MANIFEST_TIMEOUT_MS = 30 * 1000;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_LIBRARY_PAGES = 500;
const MAX_LIBRARY_ITEMS = 50_000;
const MAX_LIBRARY_MODEL_CHARS = 32 * 1024 * 1024;
const MAX_PAGE_RESULTS = 1_000;
const MAX_ID_LENGTH = 512;
const MAX_CURSOR_LENGTH = 4_096;
const MAX_OAUTH_CODE_LENGTH = 4_096;
const MAX_DISPLAY_LENGTH = 2_048;
const MAX_PROJECT_VERSIONS = 256;
const MAX_VERSION_VALUES = 128;
const MAX_CDN_CANDIDATES = 4;

// Epic's redirect endpoint has not yet been confirmed to round-trip OAuth
// state or accept PKCE for this launcher client. The transaction is still
// single-use and bound to the exact top-level tab. These switches are ready for
// a real-account compatibility test before either parameter is enabled.
const OAUTH_FEATURES = Object.freeze({
  state: false,
  pkce: false,
});

const storageReady = initializeStorage();
const refreshFlights = new Map();
const libraryFlights = new Map();
const manifestJobs = new Map();

function abortPrivilegedOperations() {
  const libraryPromises = [];
  for (const flight of libraryFlights.values()) {
    libraryPromises.push(flight.promise);
    flight.controller.abort(abortError());
  }
  libraryFlights.clear();
  for (const job of manifestJobs.values()) job.controller.abort(abortError());
  manifestJobs.clear();
  return Promise.allSettled(libraryPromises);
}

function notifyAuthGeneration(generation) {
  if (!Number.isSafeInteger(generation) || generation < 0) return;
  // Runtime messaging reaches already-open extension pages. A listener does
  // not need to send a response; an absent response/page is intentionally not
  // treated as an error.
  void chrome.runtime.sendMessage({
    action: "auth:generation",
    generation,
  }).catch(() => {});
}

class HttpStatusError extends Error {
  constructor(status, message = `Remote service returned HTTP ${status}.`) {
    super(message);
    this.name = "HttpStatusError";
    this.status = status;
  }
}

class AuthExpiredError extends Error {
  constructor() {
    super("Your Epic session has expired. Please log in again.");
    this.name = "AuthExpiredError";
  }
}

function randomBase64Url(byteLength = 24) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function isPlainMessage(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function assertAllowedFields(message, allowedFields) {
  if (!isPlainMessage(message)) throw new TypeError("Invalid extension message.");
  for (const key of Object.keys(message)) {
    if (!allowedFields.has(key)) throw new TypeError("Unexpected message field.");
  }
}

function requireString(value, name, { min = 1, max = MAX_ID_LENGTH } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new TypeError(`${name} is invalid.`);
  }
  return value;
}

function optionalString(value, name, max = MAX_ID_LENGTH) {
  if (value === undefined || value === null || value === "") return "";
  return requireString(value, name, { max });
}

function boundedDisplayString(value, max = MAX_DISPLAY_LENGTH) {
  if (typeof value !== "string") return "";
  const normalized = value.replaceAll("\0", "").trim();
  return normalized.length > max ? normalized.slice(0, max) : normalized;
}

function abortError() {
  return new DOMException("The operation was cancelled.", "AbortError");
}

function linkedAbortController(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => controller.abort(parentSignal?.reason || abortError());
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("The request timed out.", "TimeoutError"));
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    cleanup() {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}

async function readResponseBytes(response, maxBytes) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    if (response.body && typeof response.body.cancel === "function") {
      await response.body.cancel("Response exceeded size limit.").catch(() => {});
    }
    throw new RangeError("Remote response is too large.");
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new RangeError("Remote response is too large.");
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new TypeError("Invalid response body.");
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel("Response exceeded size limit.");
        throw new RangeError("Remote response is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchJson(url, options = {}, {
  timeoutMs,
  parentSignal,
  maxBytes = MAX_JSON_BYTES,
} = {}) {
  const linked = linkedAbortController(parentSignal, timeoutMs);
  try {
    const response = await fetch(url, {
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      ...options,
      signal: linked.signal,
    });
    const bytes = await readResponseBytes(response, maxBytes);
    let data = null;
    if (bytes.byteLength > 0) {
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        data = JSON.parse(text);
      } catch {
        if (response.ok) throw new TypeError("Remote service returned invalid JSON.");
      }
    }
    return { response, data };
  } catch (error) {
    if (linked.didTimeOut()) {
      throw new DOMException("The remote request timed out.", "TimeoutError");
    }
    throw error;
  } finally {
    linked.cleanup();
  }
}

function retryAfterMs(response) {
  const raw = response.headers.get("retry-after");
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 30_000);
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return 0;
  return Math.min(Math.max(timestamp - Date.now(), 0), 30_000);
}

function delay(ms, deadline, signal) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new DOMException("Library refresh timed out.", "TimeoutError");
  if (signal?.aborted) throw abortError();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.min(ms, remaining));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function ensureValidTokens() {
  await storageReady;
  const existing = await getAuth();
  if (!existing?.refreshToken || !existing?.accountId) return null;
  const epoch = existing.authEpoch;
  if (!Number.isSafeInteger(epoch) || epoch < 0) return null;
  if (existing.accessToken && !isTokenExpired(existing)) {
    return await getAuthEpoch() === epoch ? existing : null;
  }

  const flightKey = `${epoch}:${existing.accountId}`;
  let flight = refreshFlights.get(flightKey);
  if (!flight) {
    flight = (async () => {
      try {
        const refreshed = await refreshToken(existing.refreshToken);
        const stored = await setAuth(refreshed, { expectedEpoch: epoch });
        return stored ? { ...refreshed, authEpoch: epoch } : null;
      } catch (error) {
        if (isInvalidGrant(error)) {
          const cleared = await clearAuth({ expectedEpoch: epoch });
          if (cleared !== false) {
            void abortPrivilegedOperations();
            notifyAuthGeneration(cleared);
          }
          return null;
        }
        throw error;
      } finally {
        refreshFlights.delete(flightKey);
      }
    })();
    refreshFlights.set(flightKey, flight);
  }
  return flight;
}

async function handleAuthStart() {
  await abortPrivilegedOperations();
  const authEpoch = await bumpAuthEpoch();
  notifyAuthGeneration(authEpoch);
  await clearPendingOAuth();

  const transactionId = randomBase64Url();
  const state = OAUTH_FEATURES.state ? randomBase64Url() : "";
  const codeVerifier = OAUTH_FEATURES.pkce ? randomBase64Url(48) : "";
  const codeChallenge = codeVerifier ? await pkceChallenge(codeVerifier) : "";
  const loginUrl = buildOAuthUrl({ state, codeChallenge });
  const tab = await chrome.tabs.create({ url: "about:blank" });

  if (!Number.isInteger(tab?.id)) throw new Error("Unable to open the Epic login tab.");
  try {
    const stored = await setPendingOAuth({
      id: transactionId,
      tabId: tab.id,
      frameId: 0,
      state,
      codeVerifier,
      redirectUri: `${EPIC_REDIRECT_ORIGIN}${EPIC_REDIRECT_PATH}`,
    }, {
      expectedEpoch: authEpoch,
      ttlMs: OAUTH_TRANSACTION_TTL_MS,
    });
    if (!stored) throw new Error("The login request was superseded.");
    await chrome.tabs.update(tab.id, { url: loginUrl });
  } catch (error) {
    await clearPendingOAuth({ id: transactionId }).catch(() => {});
    await chrome.tabs.remove(tab.id).catch(() => {});
    throw error;
  }

  return { status: "pending" };
}

async function handleAuthCode(message, sender) {
  const code = requireString(message.code, "Authorization code", {
    min: 10,
    max: MAX_OAUTH_CODE_LENGTH,
  });
  const state = optionalString(message.state, "OAuth state", MAX_OAUTH_CODE_LENGTH);
  const expected = { tabId: sender.tab.id };
  if (OAUTH_FEATURES.state) expected.state = state;

  const pending = await consumePendingOAuth(expected);
  if (!pending || pending.frameId !== 0) {
    return { status: "error", message: "This login response is expired or was not requested." };
  }

  const previousAuth = await getAuth();
  try {
    const tokens = await exchangeCode(code, { codeVerifier: pending.codeVerifier || "" });
    await abortPrivilegedOperations();
    const committedEpoch = await commitAuth(tokens, { expectedEpoch: pending.authEpoch });
    if (committedEpoch === false) {
      return { status: "error", message: "This login response was superseded by a newer request." };
    }
    notifyAuthGeneration(committedEpoch);
    if (previousAuth?.accountId && previousAuth.accountId !== tokens.accountId) {
      await clearLibraryCache(previousAuth.accountId).catch(() => {});
    }
    await chrome.tabs.create({ url: LIBRARY_URL });
    return {
      status: "ok",
      displayName: boundedDisplayString(tokens.displayName, 256),
    };
  } catch (error) {
    return {
      status: "error",
      message: error?.message || "Epic login failed.",
    };
  }
}

async function handleAuthStatus() {
  const tokens = await ensureValidTokens();
  if (!tokens || await getAuthEpoch() !== tokens.authEpoch) {
    return { status: "logged_out" };
  }
  return {
    status: "logged_in",
    displayName: boundedDisplayString(tokens.displayName, 256),
  };
}

async function handleAuthLogout() {
  const current = await getAuth();
  await abortPrivilegedOperations();
  const authEpoch = await clearAuth();
  notifyAuthGeneration(authEpoch);
  await clearLibraryCache(current?.accountId).catch(() => {});
  return { status: "logged_out" };
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_VERSION_VALUES) {
    throw new TypeError("Fab library response contains too many version values.");
  }
  const result = [];
  const seen = new Set();
  for (const item of value) {
    const text = boundedDisplayString(item, 256);
    if (text && !seen.has(text)) {
      seen.add(text);
      result.push(text);
    }
  }
  return result;
}

function normalizeProjectVersion(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const artifactId = firstString(raw.artifactId, raw.artifact_id, raw.id);
  if (!artifactId || artifactId.length > MAX_ID_LENGTH) return null;
  return {
    artifactId,
    engineVersions: normalizeStringList(raw.engineVersions ?? raw.engine_versions),
    targetPlatforms: normalizeStringList(raw.targetPlatforms ?? raw.target_platforms),
  };
}

function safeHttpsUrl(value) {
  if (typeof value !== "string" || value.length > 16_384) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return "";
    return url.href;
  } catch {
    return "";
  }
}

function normalizeLibraryItem(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("Fab library response contains an invalid item.");
  }
  const assetId = firstString(raw.assetId, raw.asset_id, raw.id);
  const assetNamespace = firstString(
    raw.assetNamespace,
    raw.asset_namespace,
    raw.namespace,
  );
  if (!assetId || assetId.length > MAX_ID_LENGTH) {
    throw new TypeError("Fab library response contains an invalid asset ID.");
  }
  if (!assetNamespace || assetNamespace.length > MAX_ID_LENGTH) {
    throw new TypeError("Fab library response contains an invalid namespace.");
  }

  const sellerValue = typeof raw.seller === "object"
    ? firstString(raw.seller?.name, raw.seller?.displayName)
    : raw.seller;
  const publisherValue = typeof raw.publisher === "object"
    ? firstString(raw.publisher?.name, raw.publisher?.displayName)
    : raw.publisher;

  const imageCandidates = Array.isArray(raw.images)
    ? raw.images
    : [raw.thumbnail, raw.thumbnailUrl, raw.thumbnail_url];
  let imageUrl = "";
  for (const candidate of imageCandidates.slice(0, 32)) {
    const candidateUrl = typeof candidate === "object"
      ? firstString(candidate?.url, candidate?.src)
      : candidate;
    imageUrl = safeHttpsUrl(candidateUrl);
    if (imageUrl) break;
  }

  const rawVersions = raw.projectVersions ?? raw.project_versions ?? raw.versions;
  const projectVersions = [];
  if (Array.isArray(rawVersions)) {
    if (rawVersions.length > MAX_PROJECT_VERSIONS) {
      throw new TypeError("Fab library response contains too many project versions.");
    }
    for (const version of rawVersions) {
      const normalized = normalizeProjectVersion(version);
      if (normalized) projectVersions.push(normalized);
    }
  }

  return {
    assetId,
    assetNamespace,
    title: boundedDisplayString(firstString(raw.title, raw.name)) || "Untitled asset",
    seller: boundedDisplayString(firstString(sellerValue, publisherValue), 512),
    listingType: boundedDisplayString(
      firstString(raw.listingType, raw.listing_type, raw.type),
      128,
    ),
    distributionMethod: boundedDisplayString(
      firstString(raw.distributionMethod, raw.distribution_method),
      128,
    ),
    images: imageUrl ? [{ url: imageUrl }] : [],
    projectVersions,
  };
}

function parseLibraryPage(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new TypeError("Fab library response is not an object.");
  }
  if (!Array.isArray(data.results) || data.results.length > MAX_PAGE_RESULTS) {
    throw new TypeError("Fab library response has an invalid results list.");
  }
  const next = data.cursors?.next;
  if (next != null && (typeof next !== "string" || next.length > MAX_CURSOR_LENGTH)) {
    throw new TypeError("Fab library response has an invalid cursor.");
  }
  return {
    items: data.results.map(normalizeLibraryItem),
    next: next || "",
  };
}

async function fetchLibraryPage(tokens, cursor, deadline, signal) {
  const params = new URLSearchParams({ count: "100" });
  if (cursor) params.set("cursor", cursor);
  const url = `${FAB_ORIGIN}/e/accounts/${encodeURIComponent(tokens.accountId)}/ue/library?${params}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (Date.now() >= deadline) {
      throw new DOMException("Library refresh timed out.", "TimeoutError");
    }
    const { response, data } = await fetchJson(url, {
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        Accept: "application/json",
      },
    }, {
      timeoutMs: Math.min(LIBRARY_PAGE_TIMEOUT_MS, deadline - Date.now()),
      parentSignal: signal,
      maxBytes: MAX_JSON_BYTES,
    });

    if (response.ok) return parseLibraryPage(data);
    if (response.status === 401) throw new HttpStatusError(401);
    if (response.status !== 429 && response.status < 500) {
      throw new HttpStatusError(response.status);
    }
    if (attempt === 2) throw new HttpStatusError(response.status);
    await delay(retryAfterMs(response) || (500 * (2 ** attempt)), deadline, signal);
  }
  throw new Error("Fab library request failed.");
}

async function fetchCompleteLibrary(tokens, signal) {
  const deadline = Date.now() + LIBRARY_TOTAL_TIMEOUT_MS;
  const items = [];
  const assetIds = new Set();
  const cursors = new Set();
  let cursor = "";
  let modelChars = 0;

  for (let page = 0; page < MAX_LIBRARY_PAGES; page++) {
    if (signal?.aborted) throw abortError();
    const result = await fetchLibraryPage(tokens, cursor, deadline, signal);
    let additions = 0;
    for (const item of result.items) {
      if (assetIds.has(item.assetId)) continue;
      if (items.length >= MAX_LIBRARY_ITEMS) {
        throw new RangeError("Fab library exceeds the supported item limit.");
      }
      modelChars += JSON.stringify(item).length;
      if (modelChars > MAX_LIBRARY_MODEL_CHARS) {
        throw new RangeError("Fab library exceeds the supported response size.");
      }
      assetIds.add(item.assetId);
      items.push(item);
      additions++;
    }

    if (!result.next) return items;
    if (additions === 0) {
      throw new TypeError("Fab library pagination stopped making progress.");
    }
    if (cursors.has(result.next)) {
      throw new TypeError("Fab library pagination returned a repeated cursor.");
    }
    cursors.add(result.next);
    cursor = result.next;
  }
  throw new RangeError("Fab library exceeds the supported page limit.");
}

async function safeLibraryCache(accountId) {
  try {
    return await getLibraryCache(accountId, { allowStale: true });
  } catch {
    return null;
  }
}

async function fetchLibraryWithOneAuthRetry(tokens, signal) {
  try {
    return { tokens, items: await fetchCompleteLibrary(tokens, signal) };
  } catch (error) {
    if (!(error instanceof HttpStatusError) || error.status !== 401) throw error;
    if (Number.isSafeInteger(tokens.authEpoch)) {
      await clearAccessAuth({ expectedEpoch: tokens.authEpoch });
    }
    const refreshed = await ensureValidTokens();
    if (!refreshed) throw new AuthExpiredError();
    if (signal?.aborted) throw abortError();
    return { tokens: refreshed, items: await fetchCompleteLibrary(refreshed, signal) };
  }
}

async function refreshLibrary(tokens, staleCache, signal) {
  try {
    const result = await fetchLibraryWithOneAuthRetry(tokens, signal);
    const expectedEpoch = result.tokens.authEpoch;
    if (
      signal?.aborted ||
      !Number.isSafeInteger(expectedEpoch) ||
      await getAuthEpoch() !== expectedEpoch
    ) {
      throw new AuthExpiredError();
    }

    let cacheSaved = true;
    try {
      await setLibraryCache(result.tokens.accountId, result.items);
    } catch {
      cacheSaved = false;
    }
    if (signal?.aborted || await getAuthEpoch() !== expectedEpoch) {
      throw new AuthExpiredError();
    }
    return {
      status: "ok",
      source: "network",
      cacheSaved,
      items: result.items,
      totalCount: result.items.length,
      displayName: boundedDisplayString(result.tokens.displayName, 256),
    };
  } catch (error) {
    if (error instanceof AuthExpiredError || error?.name === "AbortError") {
      return { status: "auth_expired", message: error.message };
    }
    if (staleCache?.complete) {
      return {
        status: "ok",
        source: "stale",
        cacheSaved: true,
        items: staleCache.items,
        totalCount: staleCache.totalCount,
        displayName: boundedDisplayString(tokens.displayName, 256),
        warning: "Refresh failed; showing the last complete cache.",
      };
    }
    throw error;
  }
}

async function handleLibraryList({ forceRefresh = false } = {}) {
  const tokens = await ensureValidTokens();
  if (!tokens) return { status: "auth_expired", message: "Please log in again." };

  const cache = await safeLibraryCache(tokens.accountId);
  if (await getAuthEpoch() !== tokens.authEpoch) {
    return { status: "auth_expired", message: "Please log in again." };
  }
  if (!forceRefresh && cache && isLibraryCacheValid(cache)) {
    return {
      status: "ok",
      source: "cache",
      cacheSaved: true,
      items: cache.items,
      totalCount: cache.totalCount,
      displayName: boundedDisplayString(tokens.displayName, 256),
    };
  }

  let flight = libraryFlights.get(tokens.accountId);
  if (!flight) {
    const controller = new AbortController();
    const promise = refreshLibrary(tokens, cache, controller.signal).finally(() => {
      if (libraryFlights.get(tokens.accountId)?.promise === promise) {
        libraryFlights.delete(tokens.accountId);
      }
    });
    flight = { controller, promise };
    libraryFlights.set(tokens.accountId, flight);
  }
  return flight.promise;
}

async function handleLibraryStatus() {
  await storageReady;
  const auth = await getAuth();
  if (!auth?.accountId) return { status: "logged_out" };
  const cache = await safeLibraryCache(auth.accountId);
  if (!cache) return { status: "empty" };
  return {
    status: "ok",
    totalCount: cache.totalCount,
    stale: !isLibraryCacheValid(cache),
  };
}

function validateCdnUrl(value, { stripQuery = false } = {}) {
  const raw = requireString(value, "CDN URL", { max: 16_384 });
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !CDN_ORIGINS.has(url.origin)
  ) {
    throw new TypeError("Fab returned an unsupported CDN URL.");
  }
  url.hash = "";
  if (stripQuery) url.search = "";
  return url;
}

function extractManifestDescriptor(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new TypeError("Fab manifest response is invalid.");
  }
  const downloadInfo = data.downloadInfo ?? data.download_info;
  if (!Array.isArray(downloadInfo) || downloadInfo.length === 0 || downloadInfo.length > 16) {
    throw new TypeError("Fab manifest response has no supported download entry.");
  }

  const manifestUrls = [];
  const baseUrls = [];
  const baseUrlQueries = [];
  const allowedOrigins = new Set();
  const seen = new Set();
  let buildVersion = "";
  let manifestHash = "";

  for (const artifact of downloadInfo) {
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) continue;
    buildVersion ||= boundedDisplayString(
      firstString(artifact.buildVersion, artifact.build_version, data.buildVersion),
      512,
    );
    manifestHash ||= boundedDisplayString(
      firstString(artifact.manifestHash, artifact.manifest_hash, data.manifestHash),
      512,
    );

    const points = artifact.distributionPoints ?? artifact.distribution_points;
    const bases = artifact.distributionPointBaseUrls ?? artifact.distribution_point_base_urls;
    if (!Array.isArray(points) || !Array.isArray(bases) || points.length > 32 || bases.length > 32) {
      continue;
    }

    const pointsByOrigin = new Map();
    for (const point of points) {
      const rawManifest = firstString(point?.manifestUrl, point?.manifest_url);
      if (!rawManifest) continue;
      const manifestUrl = validateCdnUrl(rawManifest);
      if (!pointsByOrigin.has(manifestUrl.origin)) {
        pointsByOrigin.set(manifestUrl.origin, manifestUrl);
      }
    }

    for (const rawBase of bases) {
      if (manifestUrls.length >= MAX_CDN_CANDIDATES) break;
      if (typeof rawBase !== "string" || !rawBase) continue;
      const baseUrl = validateCdnUrl(rawBase, { stripQuery: true });
      const manifestUrl = pointsByOrigin.get(baseUrl.origin);
      if (!manifestUrl) continue;
      const key = `${baseUrl.href}\0${manifestUrl.href}`;
      if (seen.has(key)) continue;
      seen.add(key);
      manifestUrls.push(manifestUrl.href);
      baseUrls.push(baseUrl.href);
      baseUrlQueries.push(manifestUrl.search ? manifestUrl.search.slice(1) : "");
      allowedOrigins.add(baseUrl.origin);
    }
    if (manifestUrls.length >= MAX_CDN_CANDIDATES) break;
  }

  if (manifestUrls.length === 0) {
    throw new TypeError("Fab manifest response contains no approved download URL.");
  }
  return {
    manifestUrls,
    baseUrls,
    baseUrlQueries,
    allowedOrigins: [...allowedOrigins],
    buildVersion,
    manifestHash,
  };
}

function manifestOwner(sender) {
  if (sender.documentId) return `document:${sender.documentId}`;
  return `tab:${sender.tab?.id ?? -1}:frame:${sender.frameId ?? -1}:url:${sender.url || ""}`;
}

async function handleManifestPrepare(message, sender) {
  const jobId = requireString(message.jobId, "Download job ID", { max: 256 });
  const assetId = requireString(message.assetId, "Asset ID");
  const assetNamespace = requireString(message.assetNamespace, "Asset namespace");
  const artifactId = requireString(message.artifactId, "Artifact ID");
  const owner = manifestOwner(sender);
  if (manifestJobs.has(jobId)) {
    return { status: "error", message: "A download job with this ID already exists." };
  }

  const controller = new AbortController();
  manifestJobs.set(jobId, { owner, controller });
  try {
    let tokens = await ensureValidTokens();
    if (!tokens) return { status: "auth_expired", message: "Please log in again." };

    const url = `${FAB_ORIGIN}/e/artifacts/${encodeURIComponent(artifactId)}/manifest`;
    const requestBody = JSON.stringify({
      item_id: assetId,
      namespace: assetNamespace,
      platform: "Windows",
    });
    let result;
    for (let attempt = 0; attempt < 2; attempt++) {
      result = await fetchJson(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: requestBody,
      }, {
        timeoutMs: MANIFEST_TIMEOUT_MS,
        parentSignal: controller.signal,
        maxBytes: MAX_JSON_BYTES,
      });
      if (result.response.status !== 401) break;
      if (Number.isSafeInteger(tokens.authEpoch)) {
        await clearAccessAuth({ expectedEpoch: tokens.authEpoch });
      }
      if (attempt === 0) {
        tokens = await ensureValidTokens();
        if (tokens) continue;
      }
      return { status: "auth_expired", message: "Your Epic session has expired. Please retry." };
    }
    const { response, data } = result;
    if (!response.ok) throw new HttpStatusError(response.status);
    return {
      status: "ok",
      jobId,
      ...extractManifestDescriptor(data),
    };
  } finally {
    const current = manifestJobs.get(jobId);
    if (current?.controller === controller) manifestJobs.delete(jobId);
  }
}

async function handleManifestCancel(message, sender) {
  const jobId = requireString(message.jobId, "Download job ID", { max: 256 });
  const job = manifestJobs.get(jobId);
  if (!job || job.owner !== manifestOwner(sender)) return { status: "not_found" };
  job.controller.abort(abortError());
  manifestJobs.delete(jobId);
  return { status: "cancelled" };
}

function senderRole(sender) {
  if (sender?.id !== chrome.runtime.id || typeof sender.url !== "string") return "";
  if (!sender.tab && sender.frameId === undefined && sender.url === POPUP_URL) return "popup";
  if (
    sender.frameId === 0 &&
    Number.isInteger(sender.tab?.id) &&
    sender.url === LIBRARY_URL
  ) {
    return "library";
  }

  try {
    const url = new URL(sender.url);
    if (
      sender.frameId === 0 &&
      Number.isInteger(sender.tab?.id) &&
      url.origin === EPIC_REDIRECT_ORIGIN &&
      url.pathname === EPIC_REDIRECT_PATH
    ) {
      return "oauth";
    }
  } catch {
    // An invalid sender URL never receives privileges.
  }
  return "";
}

async function dispatchMessage(message, sender) {
  if (!isPlainMessage(message) || typeof message.action !== "string") {
    throw new TypeError("Invalid extension message.");
  }
  const role = senderRole(sender);

  if (role === "popup") {
    if (message.action === "auth:start") {
      assertAllowedFields(message, new Set(["action"]));
      return handleAuthStart();
    }
    if (message.action === "auth:status") {
      assertAllowedFields(message, new Set(["action"]));
      return handleAuthStatus();
    }
    if (message.action === "auth:logout") {
      assertAllowedFields(message, new Set(["action"]));
      return handleAuthLogout();
    }
    if (message.action === "library:status") {
      assertAllowedFields(message, new Set(["action"]));
      return handleLibraryStatus();
    }
  }

  if (role === "library") {
    if (message.action === "library:list") {
      assertAllowedFields(message, new Set(["action"]));
      return handleLibraryList();
    }
    if (message.action === "library:refresh") {
      assertAllowedFields(message, new Set(["action"]));
      return handleLibraryList({ forceRefresh: true });
    }
    if (message.action === "manifest:prepare") {
      assertAllowedFields(
        message,
        new Set(["action", "jobId", "assetId", "assetNamespace", "artifactId"]),
      );
      return handleManifestPrepare(message, sender);
    }
    if (message.action === "manifest:cancel") {
      assertAllowedFields(message, new Set(["action", "jobId"]));
      return handleManifestCancel(message, sender);
    }
  }

  if (role === "oauth" && message.action === "auth:code") {
    assertAllowedFields(message, new Set(["action", "code", "state"]));
    return handleAuthCode(message, sender);
  }

  throw new Error("This page is not allowed to perform that action.");
}

function publicErrorMessage(error) {
  if (error?.name === "AbortError") return "The operation was cancelled.";
  if (error?.name === "TimeoutError") return "The remote request timed out.";
  if (
    error instanceof TypeError ||
    error instanceof RangeError ||
    error instanceof HttpStatusError ||
    error instanceof AuthExpiredError
  ) {
    return error.message;
  }
  return "The extension could not complete this request.";
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  Promise.resolve()
    .then(() => dispatchMessage(message, sender))
    .then(sendResponse)
    .catch((error) => {
      sendResponse({ status: "error", message: publicErrorMessage(error) });
    });
  return true;
});
