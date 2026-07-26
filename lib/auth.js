// Epic OAuth 2.0 client.
// Uses the launcherAppClient2 credentials used by Epic Games Launcher-compatible clients.

import { debug } from './debug.js';

const CLIENT_ID = "34a02cf8f4414e29b15921876da36f9a";
const CLIENT_SECRET = "daafbccc737745039dffe53d94fc76cf";
const TOKEN_ENDPOINT = "https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/token";
const OAUTH_REDIRECT_ENDPOINT = "https://www.epicgames.com/id/api/redirect";
const EPIC_USER_AGENT = "UELauncher/11.0.1-14907503+++Portal+Release-Live Windows/10.0.19041.1.256.64bit";
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000; // Refresh when token expires in < 5 minutes
const TOKEN_REQUEST_TIMEOUT_MS = 30 * 1000;
const MAX_TOKEN_RESPONSE_BYTES = 1024 * 1024;

export class EpicOAuthError extends Error {
  constructor(message, {
    status = 0,
    oauthError = "",
    epicErrorCode = "",
    code = "",
    retryable = false,
  } = {}) {
    super(message);
    this.name = "EpicOAuthError";
    this.status = status;
    this.oauthError = oauthError;
    this.epicErrorCode = epicErrorCode;
    // Keep the old aggregate field for callers that only display/log it. New
    // classification code uses the two unambiguous server fields above.
    this.code = code || oauthError || epicErrorCode;
    this.retryable = retryable;
  }
}

export function buildOAuthUrl({ state = "", codeChallenge = "" } = {}) {
  const url = new URL(OAUTH_REDIRECT_ENDPOINT);
  url.searchParams.set("clientId", CLIENT_ID);
  url.searchParams.set("responseType", "code");
  if (state) url.searchParams.set("state", state);
  if (codeChallenge) {
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.href;
}

function basicAuthHeader() {
  const creds = `${CLIENT_ID}:${CLIENT_SECRET}`;
  return `Basic ${btoa(creds)}`;
}

async function readBoundedJson(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TOKEN_RESPONSE_BYTES) {
    if (response.body && typeof response.body.cancel === "function") {
      await response.body.cancel("Token response exceeded size limit.").catch(() => {});
    }
    throw new EpicOAuthError("Epic token endpoint returned an oversized response.");
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_TOKEN_RESPONSE_BYTES) {
      throw new EpicOAuthError("Epic token endpoint returned an oversized response.");
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }

  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_TOKEN_RESPONSE_BYTES) {
        await reader.cancel("Token response exceeded size limit.");
        throw new EpicOAuthError("Epic token endpoint returned an oversized response.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

async function postToken(body) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Token request timed out.", "TimeoutError"));
  }, TOKEN_REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": EPIC_USER_AGENT,
        Accept: "application/json",
      },
      body: new URLSearchParams(body).toString(),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    throw new EpicOAuthError(
      timedOut ? "Epic token request timed out." : "Unable to reach the Epic token endpoint.",
      { retryable: true },
    );
  }

  try {
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      let oauthError = "";
      let epicErrorCode = "";
      try {
        const err = await readBoundedJson(response);
        const rawOAuthError = err && typeof err === "object" ? err.error : "";
        const rawEpicErrorCode = err && typeof err === "object" ? err.errorCode : "";
        const rawMessage = err && typeof err === "object"
          ? (err.errorMessage || err.error_description)
          : "";
        oauthError = typeof rawOAuthError === "string" ? rawOAuthError.slice(0, 256) : "";
        epicErrorCode = typeof rawEpicErrorCode === "string"
          ? rawEpicErrorCode.slice(0, 256)
          : "";
        const serverMessage = typeof rawMessage === "string" ? rawMessage.slice(0, 512) : "";
        if (serverMessage) {
          const labels = [...new Set([oauthError, epicErrorCode].filter(Boolean))];
          detail = `${detail} — ${labels.join(" / ") || "error"}: ${serverMessage}`;
        }
      } catch { debug.log('Error body was not JSON — using HTTP status only'); }
      throw new EpicOAuthError(`Epic token endpoint rejected request: ${detail}`, {
        status: response.status,
        oauthError,
        epicErrorCode,
        retryable: response.status === 429 || response.status >= 500,
      });
    }

    let payload;
    try {
      payload = await readBoundedJson(response);
    } catch (error) {
      if (timedOut) {
        throw new EpicOAuthError("Epic token request timed out.", { retryable: true });
      }
      if (error instanceof EpicOAuthError) throw error;
      throw new EpicOAuthError("Epic token endpoint returned invalid JSON.");
    }
    const tokens = {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      accountId: payload.account_id,
      displayName: payload.displayName,
      expiresAt: payload.expires_at,
      refreshExpiresAt: payload.refresh_expires_at,
    };
    if (!validateTokens(tokens)) {
      throw new EpicOAuthError("Epic token endpoint returned an incomplete token response.");
    }
    return tokens;
  } finally {
    clearTimeout(timer);
  }
}

export async function exchangeCode(code, { codeVerifier = "" } = {}) {
  const body = {
    grant_type: "authorization_code",
    code,
    token_type: "eg1",
  };
  if (codeVerifier) body.code_verifier = codeVerifier;
  return postToken(body);
}

export async function refreshToken(refreshToken) {
  return postToken({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    token_type: "eg1",
  });
}

export function isTokenExpired(tokens, thresholdMs = REFRESH_THRESHOLD_MS) {
  if (!tokens?.expiresAt) return true;
  const expiresMs = Date.parse(tokens.expiresAt);
  if (!Number.isFinite(expiresMs)) return true;
  return expiresMs - Date.now() < thresholdMs;
}

export function validateTokens(tokens) {
  return !!(tokens?.accessToken && tokens?.refreshToken && tokens?.accountId);
}

export function isInvalidGrant(error) {
  if (!(error instanceof EpicOAuthError)) return false;
  const isExplicitCode = (value, expected) => {
    const normalized = String(value || "").trim().toLowerCase();
    return normalized === expected || normalized.endsWith(`.${expected}`);
  };
  const identifiers = [error.oauthError, error.epicErrorCode];
  // Compatibility for an EpicOAuthError constructed by older local callers.
  if (!identifiers.some(Boolean) && error.code) identifiers.push(error.code);
  return identifiers.some((value) =>
    isExplicitCode(value, "invalid_grant") ||
    isExplicitCode(value, "invalid_refresh_token"));
}
