// Storage boundary for authentication state and the per-account library cache.
//
// Persistent chrome.storage.local data is deliberately limited to the refresh
// credential. Access credentials and in-progress OAuth state live only in
// chrome.storage.session. Library data is kept in IndexedDB so a large library
// does not exhaust chrome.storage.local's small quota.

export const LIBRARY_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const LIBRARY_CACHE_SCHEMA_VERSION = 1;
export const OAUTH_TRANSACTION_MAX_AGE_MS = 5 * 60 * 1000;

const REFRESH_AUTH_KEY = "refreshAuth";
const ACCESS_AUTH_KEY = "accessAuth";
const AUTH_EPOCH_KEY = "authEpoch";
const PENDING_OAUTH_KEY = "pendingOAuth";

const LEGACY_AUTH_KEY = "auth";
const LEGACY_LIBRARY_CACHE_KEY = "libraryCache";

const LIBRARY_DB_NAME = "fab-library-cache";
const LIBRARY_DB_VERSION = 1;
const LIBRARY_ITEMS_STORE = "libraryItems";
const LIBRARY_META_STORE = "libraryMeta";
const LIBRARY_ACCOUNT_INDEX = "byAccount";

const MAX_TOKEN_LENGTH = 16 * 1024;
const MAX_ACCOUNT_ID_LENGTH = 256;
const MAX_DISPLAY_NAME_LENGTH = 512;
const MAX_OAUTH_VALUE_LENGTH = 16 * 1024;
const MAX_LIBRARY_ITEMS = 50_000;

let initializationPromise = null;
let databasePromise = null;
let authOperationTail = Promise.resolve();

function assertStorageAvailable() {
  if (!globalThis.chrome?.storage?.local || !globalThis.chrome?.storage?.session) {
    throw new Error("Chrome local and session storage are required.");
  }
}

function nonEmptyString(value, name, maxLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`${name} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value;
}

function optionalString(value, name, maxLength) {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new TypeError(`${name} must be a string of at most ${maxLength} characters.`);
  }
  return value;
}

function sanitizeRefreshAuth(value) {
  if (!value || typeof value !== "object") return null;

  try {
    const refresh = {
      refreshToken: nonEmptyString(value.refreshToken, "refreshToken", MAX_TOKEN_LENGTH),
      accountId: nonEmptyString(value.accountId, "accountId", MAX_ACCOUNT_ID_LENGTH),
    };
    const refreshExpiresAt = optionalString(
      value.refreshExpiresAt,
      "refreshExpiresAt",
      MAX_OAUTH_VALUE_LENGTH,
    );
    if (refreshExpiresAt !== undefined) refresh.refreshExpiresAt = refreshExpiresAt;
    return refresh;
  } catch {
    return null;
  }
}

function sanitizeAccessAuth(value, authEpoch) {
  if (!value || typeof value !== "object") return null;

  try {
    const access = {
      accessToken: nonEmptyString(value.accessToken, "accessToken", MAX_TOKEN_LENGTH),
      accountId: nonEmptyString(value.accountId, "accountId", MAX_ACCOUNT_ID_LENGTH),
      authEpoch,
    };
    const expiresAt = optionalString(value.expiresAt, "expiresAt", MAX_OAUTH_VALUE_LENGTH);
    const displayName = optionalString(value.displayName, "displayName", MAX_DISPLAY_NAME_LENGTH);
    if (expiresAt !== undefined) access.expiresAt = expiresAt;
    if (displayName !== undefined) access.displayName = displayName;
    return access;
  } catch {
    return null;
  }
}

function normalizeEpoch(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function expectedEpochMatches(expectedEpoch, currentEpoch) {
  return (
    expectedEpoch === undefined ||
    (Number.isSafeInteger(expectedEpoch) && expectedEpoch >= 0 && expectedEpoch === currentEpoch)
  );
}

function nextEpoch(value) {
  const current = normalizeEpoch(value);
  return current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1;
}

function queueAuthOperation(operation) {
  const result = authOperationTail.then(operation, operation);
  authOperationTail = result.catch(() => {});
  return result;
}

async function migrateLegacyStorage() {
  const [localData, sessionData] = await Promise.all([
    chrome.storage.local.get([LEGACY_AUTH_KEY, LEGACY_LIBRARY_CACHE_KEY, REFRESH_AUTH_KEY]),
    chrome.storage.session.get([AUTH_EPOCH_KEY, ACCESS_AUTH_KEY]),
  ]);

  const authEpoch = normalizeEpoch(sessionData[AUTH_EPOCH_KEY]);
  if (sessionData[AUTH_EPOCH_KEY] !== authEpoch) {
    await chrome.storage.session.set({ [AUTH_EPOCH_KEY]: authEpoch });
  }

  // Rewrite even a current-format record through the sanitizer. This prevents
  // accidentally persisting access tokens or display data in local storage.
  const currentRefresh = sanitizeRefreshAuth(localData[REFRESH_AUTH_KEY]);
  const legacyRefresh = sanitizeRefreshAuth(localData[LEGACY_AUTH_KEY]);
  const refreshToKeep = currentRefresh || legacyRefresh;

  if (refreshToKeep) {
    await chrome.storage.local.set({ [REFRESH_AUTH_KEY]: refreshToKeep });
  } else if (localData[REFRESH_AUTH_KEY] !== undefined) {
    await chrome.storage.local.remove(REFRESH_AUTH_KEY);
  }

  const currentAccess = sanitizeAccessAuth(sessionData[ACCESS_AUTH_KEY], authEpoch);
  const legacyAccess = sanitizeAccessAuth(localData[LEGACY_AUTH_KEY], authEpoch);
  const accessToKeep = currentAccess || legacyAccess;

  if (accessToKeep) {
    await chrome.storage.session.set({ [ACCESS_AUTH_KEY]: accessToKeep });
  } else if (sessionData[ACCESS_AUTH_KEY] !== undefined) {
    await chrome.storage.session.remove(ACCESS_AUTH_KEY);
  }

  // The old cache cannot be associated with a verified account, so carrying it
  // forward would reintroduce the cross-account leak.
  await chrome.storage.local.remove([LEGACY_AUTH_KEY, LEGACY_LIBRARY_CACHE_KEY]);
}

/**
 * Restrict storage access to trusted extension pages and migrate legacy keys.
 * Safe to call repeatedly; concurrent callers share the same attempt.
 */
export function initializeStorage() {
  if (initializationPromise) return initializationPromise;

  const attempt = (async () => {
    assertStorageAvailable();
    await Promise.all([
      chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
      chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
    ]);
    await migrateLegacyStorage();
  })();

  initializationPromise = attempt;
  attempt.catch(() => {
    if (initializationPromise === attempt) initializationPromise = null;
  });
  return attempt;
}

async function readAuthEpochRaw() {
  const data = await chrome.storage.session.get(AUTH_EPOCH_KEY);
  return normalizeEpoch(data[AUTH_EPOCH_KEY]);
}

export async function getAuthEpoch() {
  await initializeStorage();
  return readAuthEpochRaw();
}

export async function bumpAuthEpoch() {
  await initializeStorage();
  return queueAuthOperation(async () => {
    const value = nextEpoch(await readAuthEpochRaw());
    await chrome.storage.session.set({ [AUTH_EPOCH_KEY]: value });
    return value;
  });
}

export async function getRefreshAuth() {
  await initializeStorage();
  const data = await chrome.storage.local.get(REFRESH_AUTH_KEY);
  return sanitizeRefreshAuth(data[REFRESH_AUTH_KEY]);
}

export async function getAccessAuth() {
  await initializeStorage();
  const [data, authEpoch] = await Promise.all([
    chrome.storage.session.get(ACCESS_AUTH_KEY),
    readAuthEpochRaw(),
  ]);
  const access = sanitizeAccessAuth(data[ACCESS_AUTH_KEY], authEpoch);
  if (!access || data[ACCESS_AUTH_KEY]?.authEpoch !== authEpoch) return null;
  return access;
}

/**
 * Compatibility aggregate for callers that previously loaded one "auth"
 * object. After a browser restart it can contain only the refresh credential;
 * callers must refresh before requiring an accessToken.
 */
export async function getAuth() {
  await initializeStorage();
  return queueAuthOperation(async () => {
    // Read the epoch and both halves inside one queued operation. Otherwise a
    // concurrent login/logout can interleave between independent storage reads
    // and produce a credential assembled from two authentication generations.
    const [localData, sessionData] = await Promise.all([
      chrome.storage.local.get(REFRESH_AUTH_KEY),
      chrome.storage.session.get([AUTH_EPOCH_KEY, ACCESS_AUTH_KEY]),
    ]);
    const authEpoch = normalizeEpoch(sessionData[AUTH_EPOCH_KEY]);
    const access = sanitizeAccessAuth(sessionData[ACCESS_AUTH_KEY], authEpoch);
    const refresh = sanitizeRefreshAuth(localData[REFRESH_AUTH_KEY]);

    if (!access || sessionData[ACCESS_AUTH_KEY]?.authEpoch !== authEpoch) {
      return refresh ? { ...refresh, authEpoch } : null;
    }
    if (!refresh) return access;
    if (access.accountId !== refresh.accountId) return { ...refresh, authEpoch };
    return { ...refresh, ...access };
  });
}

/**
 * Store a complete token response, split across local and session storage.
 * Returns false rather than writing if expectedEpoch is no longer current.
 */
export async function setAuth(tokens, { expectedEpoch } = {}) {
  await initializeStorage();
  return queueAuthOperation(async () => {
    const authEpoch = await readAuthEpochRaw();
    if (!expectedEpochMatches(expectedEpoch, authEpoch)) return false;

    const refresh = sanitizeRefreshAuth(tokens);
    const access = sanitizeAccessAuth(tokens, authEpoch);
    if (!refresh || !access || refresh.accountId !== access.accountId) {
      throw new TypeError("A complete, internally consistent Epic token response is required.");
    }

    // Persist the refresh credential first. If the session write subsequently
    // fails, the next worker instance can still recover by refreshing it.
    await chrome.storage.local.set({ [REFRESH_AUTH_KEY]: refresh });
    await chrome.storage.session.set({ [ACCESS_AUTH_KEY]: access });
    return true;
  });
}

/**
 * Atomically commit a completed interactive login as a new authentication
 * generation. Refresh operations started from the pre-login credential retain
 * the old expectedEpoch and therefore cannot overwrite this result.
 *
 * The refresh credential is written first while the old epoch is still
 * current. The session epoch and matching access credential are then replaced
 * together. Concurrent auth writes are serialized by queueAuthOperation.
 */
export async function commitAuth(tokens, { expectedEpoch } = {}) {
  await initializeStorage();
  return queueAuthOperation(async () => {
    const currentEpoch = await readAuthEpochRaw();
    if (!expectedEpochMatches(expectedEpoch, currentEpoch)) return false;
    const authEpoch = nextEpoch(currentEpoch);

    const refresh = sanitizeRefreshAuth(tokens);
    const access = sanitizeAccessAuth(tokens, authEpoch);
    if (!refresh || !access || refresh.accountId !== access.accountId) {
      throw new TypeError("A complete, internally consistent Epic token response is required.");
    }

    await chrome.storage.local.set({ [REFRESH_AUTH_KEY]: refresh });
    await chrome.storage.session.set({
      [AUTH_EPOCH_KEY]: authEpoch,
      [ACCESS_AUTH_KEY]: access,
    });
    return authEpoch;
  });
}

export async function setAccessAuth(tokens, { expectedEpoch } = {}) {
  await initializeStorage();
  return queueAuthOperation(async () => {
    const authEpoch = await readAuthEpochRaw();
    if (!expectedEpochMatches(expectedEpoch, authEpoch)) return false;

    const access = sanitizeAccessAuth(tokens, authEpoch);
    if (!access) throw new TypeError("A valid access credential is required.");
    await chrome.storage.session.set({ [ACCESS_AUTH_KEY]: access });
    return true;
  });
}

export async function setRefreshAuth(tokens, { expectedEpoch } = {}) {
  await initializeStorage();
  return queueAuthOperation(async () => {
    const authEpoch = await readAuthEpochRaw();
    if (!expectedEpochMatches(expectedEpoch, authEpoch)) return false;

    const refresh = sanitizeRefreshAuth(tokens);
    if (!refresh) throw new TypeError("A valid refresh credential is required.");
    await chrome.storage.local.set({ [REFRESH_AUTH_KEY]: refresh });
    return true;
  });
}

export async function clearAccessAuth({ expectedEpoch } = {}) {
  await initializeStorage();
  return queueAuthOperation(async () => {
    const authEpoch = await readAuthEpochRaw();
    if (!expectedEpochMatches(expectedEpoch, authEpoch)) return false;
    await chrome.storage.session.remove(ACCESS_AUTH_KEY);
    return true;
  });
}

/**
 * Clear all authentication material. Bumping the epoch first makes results
 * from older in-flight login/refresh operations ineligible for storage.
 */
export async function clearAuth({ bumpEpoch = true, expectedEpoch } = {}) {
  await initializeStorage();
  return queueAuthOperation(async () => {
    const currentEpoch = await readAuthEpochRaw();
    if (!expectedEpochMatches(expectedEpoch, currentEpoch)) return false;
    const authEpoch = bumpEpoch ? nextEpoch(currentEpoch) : currentEpoch;
    if (bumpEpoch) {
      await chrome.storage.session.set({ [AUTH_EPOCH_KEY]: authEpoch });
    }
    await Promise.all([
      chrome.storage.session.remove([ACCESS_AUTH_KEY, PENDING_OAUTH_KEY]),
      chrome.storage.local.remove(REFRESH_AUTH_KEY),
    ]);
    return authEpoch;
  });
}

function sanitizePendingOAuth(transaction, authEpoch, ttlMs) {
  if (!transaction || typeof transaction !== "object" || Array.isArray(transaction)) {
    throw new TypeError("OAuth transaction must be an object.");
  }

  const tabId = transaction.tabId;
  if (!Number.isInteger(tabId) || tabId < 0) {
    throw new TypeError("OAuth transaction tabId must be a non-negative integer.");
  }

  const now = Date.now();
  const boundedTtl = Math.min(
    OAUTH_TRANSACTION_MAX_AGE_MS,
    Math.max(1_000, Number.isFinite(ttlMs) ? ttlMs : OAUTH_TRANSACTION_MAX_AGE_MS),
  );
  const pending = {
    id: nonEmptyString(transaction.id, "OAuth transaction id", MAX_OAUTH_VALUE_LENGTH),
    tabId,
    createdAt: now,
    expiresAt: now + boundedTtl,
    authEpoch,
  };

  if (transaction.frameId !== undefined) {
    if (!Number.isInteger(transaction.frameId) || transaction.frameId < 0) {
      throw new TypeError("OAuth transaction frameId must be a non-negative integer.");
    }
    pending.frameId = transaction.frameId;
  }

  for (const field of ["state", "codeVerifier", "redirectUri"]) {
    const value = optionalString(
      transaction[field],
      `OAuth transaction ${field}`,
      MAX_OAUTH_VALUE_LENGTH,
    );
    if (value !== undefined) pending[field] = value;
  }
  return pending;
}

function pendingOAuthMatches(pending, expected) {
  if (expected.id !== undefined && pending.id !== expected.id) return false;
  if (expected.tabId !== undefined && pending.tabId !== expected.tabId) return false;
  if (expected.state !== undefined && pending.state !== expected.state) return false;
  return true;
}

function validPendingOAuth(value, authEpoch, now = Date.now()) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.id === "string" &&
      Number.isInteger(value.tabId) &&
      value.authEpoch === authEpoch &&
      Number.isFinite(value.createdAt) &&
      Number.isFinite(value.expiresAt) &&
      value.expiresAt > now &&
      value.expiresAt - value.createdAt <= OAUTH_TRANSACTION_MAX_AGE_MS,
  );
}

export async function setPendingOAuth(
  transaction,
  { expectedEpoch, ttlMs = OAUTH_TRANSACTION_MAX_AGE_MS } = {},
) {
  await initializeStorage();
  return queueAuthOperation(async () => {
    const authEpoch = await readAuthEpochRaw();
    if (!expectedEpochMatches(expectedEpoch, authEpoch)) return false;
    const pending = sanitizePendingOAuth(transaction, authEpoch, ttlMs);
    await chrome.storage.session.set({ [PENDING_OAUTH_KEY]: pending });
    return true;
  });
}

export async function getPendingOAuth() {
  await initializeStorage();
  return queueAuthOperation(async () => {
    const [data, authEpoch] = await Promise.all([
      chrome.storage.session.get(PENDING_OAUTH_KEY),
      readAuthEpochRaw(),
    ]);
    const pending = data[PENDING_OAUTH_KEY];
    if (validPendingOAuth(pending, authEpoch)) return pending;
    if (pending !== undefined) await chrome.storage.session.remove(PENDING_OAUTH_KEY);
    return null;
  });
}

/**
 * Atomically validate and consume the pending OAuth transaction. A mismatched
 * callback does not destroy the legitimate pending transaction.
 */
export async function consumePendingOAuth(expected = {}) {
  await initializeStorage();
  return queueAuthOperation(async () => {
    const [data, authEpoch] = await Promise.all([
      chrome.storage.session.get(PENDING_OAUTH_KEY),
      readAuthEpochRaw(),
    ]);
    const pending = data[PENDING_OAUTH_KEY];
    if (!validPendingOAuth(pending, authEpoch)) {
      if (pending !== undefined) await chrome.storage.session.remove(PENDING_OAUTH_KEY);
      return null;
    }
    if (!pendingOAuthMatches(pending, expected)) return null;
    await chrome.storage.session.remove(PENDING_OAUTH_KEY);
    return pending;
  });
}

export async function clearPendingOAuth({ id } = {}) {
  await initializeStorage();
  return queueAuthOperation(async () => {
    if (id !== undefined) {
      const data = await chrome.storage.session.get(PENDING_OAUTH_KEY);
      if (data[PENDING_OAUTH_KEY]?.id !== id) return false;
    }
    await chrome.storage.session.remove(PENDING_OAUTH_KEY);
    return true;
  });
}

function requestAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
  });
}

function transactionAsPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error || new Error("IndexedDB transaction was aborted."));
    transaction.onerror = () => {
      // onabort carries the final transaction error.
    };
  });
}

function openLibraryDatabase() {
  if (databasePromise) return databasePromise;
  if (!globalThis.indexedDB) {
    return Promise.reject(new Error("IndexedDB is unavailable."));
  }

  const attempt = new Promise((resolve, reject) => {
    const request = indexedDB.open(LIBRARY_DB_NAME, LIBRARY_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(LIBRARY_ITEMS_STORE)) {
        const items = database.createObjectStore(LIBRARY_ITEMS_STORE, {
          keyPath: ["accountId", "assetId"],
        });
        items.createIndex(LIBRARY_ACCOUNT_INDEX, "accountId", { unique: false });
      }
      if (!database.objectStoreNames.contains(LIBRARY_META_STORE)) {
        database.createObjectStore(LIBRARY_META_STORE, { keyPath: "accountId" });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        if (databasePromise === attempt) databasePromise = null;
      };
      resolve(database);
    };
    request.onerror = () =>
      reject(request.error || new Error("Unable to open the library cache database."));
  });

  databasePromise = attempt;
  attempt.catch(() => {
    if (databasePromise === attempt) databasePromise = null;
  });
  return attempt;
}

function deleteAccountItems(itemsStore, accountId, onReady) {
  const request = itemsStore
    .index(LIBRARY_ACCOUNT_INDEX)
    .openKeyCursor(IDBKeyRange.only(accountId));

  request.onerror = () => {
    try {
      itemsStore.transaction.abort();
    } catch {
      // The transaction may already have aborted because of the request error.
    }
  };
  request.onsuccess = () => {
    const cursor = request.result;
    if (cursor) {
      itemsStore.delete(cursor.primaryKey);
      cursor.continue();
      return;
    }
    onReady();
  };
}

function validateAccountId(accountId) {
  return nonEmptyString(accountId, "accountId", MAX_ACCOUNT_ID_LENGTH);
}

function validateLibraryItems(items) {
  if (!Array.isArray(items)) throw new TypeError("Library items must be an array.");
  if (items.length > MAX_LIBRARY_ITEMS) {
    throw new RangeError(`Library cache cannot contain more than ${MAX_LIBRARY_ITEMS} items.`);
  }

  const seen = new Set();
  return items.map((item, position) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError(`Library item ${position} must be an object.`);
    }
    const assetId = nonEmptyString(
      item.assetId,
      `Library item ${position} assetId`,
      MAX_OAUTH_VALUE_LENGTH,
    );
    if (seen.has(assetId)) throw new TypeError(`Duplicate library assetId: ${assetId}`);
    seen.add(assetId);
    return { assetId, position, item };
  });
}

async function accountIdFromCurrentAuth() {
  const auth = await getAuth();
  return auth?.accountId || null;
}

function parseCacheReadArguments(accountIdOrOptions, maybeOptions) {
  if (accountIdOrOptions === undefined) {
    return {
      accountId: undefined,
      options: maybeOptions || {},
    };
  }
  if (
    accountIdOrOptions &&
    typeof accountIdOrOptions === "object" &&
    !Array.isArray(accountIdOrOptions)
  ) {
    return {
      accountId: undefined,
      options: accountIdOrOptions || {},
    };
  }
  return { accountId: accountIdOrOptions, options: maybeOptions || {} };
}

/**
 * Read a complete cache snapshot. By default stale data is returned with
 * stale:true so callers can use it as a network-failure fallback.
 */
export async function getLibraryCache(accountIdOrOptions, maybeOptions) {
  await initializeStorage();
  const { accountId: suppliedAccountId, options } = parseCacheReadArguments(
    accountIdOrOptions,
    maybeOptions,
  );
  const resolvedAccountId = suppliedAccountId ?? (await accountIdFromCurrentAuth());
  if (!resolvedAccountId) return null;
  const accountId = validateAccountId(resolvedAccountId);
  const allowStale = options.allowStale !== false;
  const now = Number.isFinite(options.now) ? options.now : Date.now();

  const database = await openLibraryDatabase();
  const transaction = database.transaction(
    [LIBRARY_ITEMS_STORE, LIBRARY_META_STORE],
    "readonly",
  );
  const completed = transactionAsPromise(transaction);
  const itemRequest = transaction
    .objectStore(LIBRARY_ITEMS_STORE)
    .index(LIBRARY_ACCOUNT_INDEX)
    .getAll(IDBKeyRange.only(accountId));
  const metaRequest = transaction.objectStore(LIBRARY_META_STORE).get(accountId);
  const [records, meta] = await Promise.all([
    requestAsPromise(itemRequest),
    requestAsPromise(metaRequest),
  ]);
  await completed;

  if (
    !meta ||
    meta.schemaVersion !== LIBRARY_CACHE_SCHEMA_VERSION ||
    meta.complete !== true ||
    !Number.isFinite(meta.cachedAt) ||
    !Number.isSafeInteger(meta.totalCount) ||
    meta.totalCount < 0 ||
    records.length !== meta.totalCount
  ) {
    return null;
  }

  records.sort((left, right) => left.position - right.position);
  for (let position = 0; position < records.length; position++) {
    const record = records[position];
    if (
      record.accountId !== accountId ||
      record.position !== position ||
      record.item?.assetId !== record.assetId
    ) {
      return null;
    }
  }

  const stale = now - meta.cachedAt < 0 || now - meta.cachedAt >= LIBRARY_CACHE_MAX_AGE_MS;
  if (stale && !allowStale) return null;

  return {
    accountId,
    items: records.map((record) => record.item),
    schemaVersion: meta.schemaVersion,
    cachedAt: new Date(meta.cachedAt).toISOString(),
    totalCount: meta.totalCount,
    complete: true,
    current: !stale,
    stale,
  };
}

export async function getCurrentLibraryCache(accountId, options = {}) {
  return getLibraryCache(accountId, { ...options, allowStale: false });
}

function parseCacheWriteArguments(accountIdOrItems, itemsOrOptions, maybeOptions) {
  if (Array.isArray(accountIdOrItems)) {
    return {
      accountId: undefined,
      items: accountIdOrItems,
      options: itemsOrOptions || {},
    };
  }
  return {
    accountId: accountIdOrItems,
    items: itemsOrOptions,
    options: maybeOptions || {},
  };
}

/**
 * Atomically replace one account's complete cache snapshot.
 *
 * Supports the old setLibraryCache(items) signature by resolving accountId
 * from current auth, but new callers should pass setLibraryCache(accountId, items).
 */
export async function setLibraryCache(accountIdOrItems, itemsOrOptions, maybeOptions) {
  await initializeStorage();
  const parsed = parseCacheWriteArguments(accountIdOrItems, itemsOrOptions, maybeOptions);
  const resolvedAccountId = parsed.accountId ?? (await accountIdFromCurrentAuth());
  if (!resolvedAccountId) {
    throw new Error("Cannot cache a library without an authenticated accountId.");
  }
  const accountId = validateAccountId(resolvedAccountId);
  const records = validateLibraryItems(parsed.items);
  const cachedAt = Number.isFinite(parsed.options.cachedAt)
    ? parsed.options.cachedAt
    : Date.now();
  if (cachedAt < 0) throw new RangeError("cachedAt must be a non-negative timestamp.");

  const database = await openLibraryDatabase();
  const transaction = database.transaction(
    [LIBRARY_ITEMS_STORE, LIBRARY_META_STORE],
    "readwrite",
  );
  const completed = transactionAsPromise(transaction);
  const itemsStore = transaction.objectStore(LIBRARY_ITEMS_STORE);
  const metaStore = transaction.objectStore(LIBRARY_META_STORE);

  deleteAccountItems(itemsStore, accountId, () => {
    try {
      for (const record of records) {
        itemsStore.put({
          accountId,
          assetId: record.assetId,
          position: record.position,
          item: record.item,
        });
      }
      metaStore.put({
        accountId,
        schemaVersion: LIBRARY_CACHE_SCHEMA_VERSION,
        cachedAt,
        totalCount: records.length,
        complete: true,
      });
    } catch {
      transaction.abort();
    }
  });

  await completed;
  return {
    accountId,
    schemaVersion: LIBRARY_CACHE_SCHEMA_VERSION,
    cachedAt: new Date(cachedAt).toISOString(),
    totalCount: records.length,
    complete: true,
    current: true,
    stale: false,
  };
}

/**
 * Clear one account, or all accounts when accountId is omitted.
 */
export async function clearLibraryCache(accountId) {
  await initializeStorage();
  const database = await openLibraryDatabase();
  const transaction = database.transaction(
    [LIBRARY_ITEMS_STORE, LIBRARY_META_STORE],
    "readwrite",
  );
  const completed = transactionAsPromise(transaction);
  const itemsStore = transaction.objectStore(LIBRARY_ITEMS_STORE);
  const metaStore = transaction.objectStore(LIBRARY_META_STORE);

  if (accountId === undefined) {
    itemsStore.clear();
    metaStore.clear();
  } else {
    const validatedAccountId = validateAccountId(accountId);
    deleteAccountItems(itemsStore, validatedAccountId, () => {
      metaStore.delete(validatedAccountId);
    });
  }

  await completed;
}

export function isLibraryCacheValid(cache, now = Date.now()) {
  if (
    !cache ||
    cache.schemaVersion !== LIBRARY_CACHE_SCHEMA_VERSION ||
    cache.complete !== true ||
    !cache.cachedAt
  ) {
    return false;
  }
  const cachedAt = Date.parse(cache.cachedAt);
  const age = now - cachedAt;
  return Number.isFinite(age) && age >= 0 && age < LIBRARY_CACHE_MAX_AGE_MS;
}

export async function clearAllStoredData() {
  const authEpoch = await clearAuth();
  await clearLibraryCache();
  return authEpoch;
}

// Apply the access boundary as soon as this module is loaded by the service
// worker. Public operations also await the same initialization attempt.
if (globalThis.chrome?.storage?.local && globalThis.chrome?.storage?.session) {
  void initializeStorage().catch((error) => {
    console.error("Storage initialization failed:", error);
  });
}
