// Fab Library Browser — account library, version selection, and bounded downloads.
import { downloadAsset } from "../vendor/fab-download-browser.js";
import { debug } from "../lib/debug.js";

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];

const TYPE_BADGES = {
  "3D":               { cls: "badge-blue", label: "3D" },
  "工具与插件":        { cls: "badge-purple", label: "Plugin" },
  COMPLETE_PROJECT:   { cls: "badge-green", label: "Project" },
  ASSET_PACK:         { cls: "badge-blue", label: "Assets" },
  CODE_PLUGIN:        { cls: "badge-purple", label: "Code Plugin" },
  "游戏系统":          { cls: "badge-indigo", label: "Game System" },
  "材质与纹理":        { cls: "badge-orange", label: "Material" },
  "视觉效果":          { cls: "badge-pink", label: "VFX" },
  "动画":             { cls: "badge-teal", label: "Anim" },
  "游戏模板":          { cls: "badge-green", label: "Template" },
  "教程和示例":        { cls: "badge-gray", label: "Tutorial" },
  Legacy:             { cls: "badge-gray", label: "Legacy" },
  ENGINE:             { cls: "badge-gray", label: "Engine" },
};
const MAX_RENDERED_CARDS = 1_000;
const MAX_ACTIVE_DOWNLOADS = 2;

let allItems = [];
let engineVersions = new Set();
let loadGeneration = 0;
let authStateRevision = 0;
let toastTimer = null;

/** One active job per asset card. */
const activeDownloads = new Map();
const pickingAssets = new Set();

function createElement(tag, { className = "", text = "", title = "" } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== "") node.textContent = String(text);
  if (title) node.title = title;
  return node;
}

function showToast(message, type = "success") {
  const toast = $("#toast");
  clearTimeout(toastTimer);
  toast.textContent = String(message || "");
  toast.className = `toast toast-${type}`;
  toast.style.display = "block";
  toastTimer = setTimeout(() => { toast.style.display = "none"; }, 4000);
}

function missingBrowserFeatures() {
  const missing = [];
  if (typeof window.showDirectoryPicker !== "function") missing.push("directory picker");
  if (!globalThis.crypto?.subtle) missing.push("Web Crypto");
  if (!chrome.storage?.session || typeof chrome.storage.local?.setAccessLevel !== "function") {
    missing.push("Chrome extension storage");
  }
  try {
    if (typeof DecompressionStream !== "function") throw new Error("missing");
    new DecompressionStream("deflate-raw");
  } catch {
    missing.push("deflate-raw decompression");
  }
  return missing;
}

function showEmptyMessage(message) {
  $("#loading-state").style.display = "none";
  $("#card-grid").style.display = "none";
  const empty = $("#empty-state");
  $("p", empty).textContent = message;
  empty.style.display = "flex";
}

function abortActiveDownloads() {
  const jobs = [...activeDownloads.values()];
  activeDownloads.clear();
  for (const state of jobs) {
    state.controller.abort();
    void chrome.runtime.sendMessage({
      action: "manifest:cancel",
      jobId: state.jobId,
    }).catch(() => {});
  }
}

function clearLibraryForAuthChange(
  message = "Authentication changed. Log in from the popup, then refresh this page.",
) {
  authStateRevision++;
  loadGeneration++;
  abortActiveDownloads();
  pickingAssets.clear();
  allItems = [];
  engineVersions = new Set();
  clearTimeout(searchTimer);
  clearTimeout(toastTimer);

  $("#search-input").value = "";
  $("#filter-type").value = "";
  $("#display-name").textContent = "";
  $("#result-count").textContent = "";
  $("#card-grid").replaceChildren();
  $("#toast").textContent = "";
  $("#toast").style.display = "none";
  rebuildEngineVersions();

  const refreshButton = $("#btn-refresh");
  refreshButton.disabled = false;
  refreshButton.removeAttribute("aria-busy");
  showEmptyMessage(message);
}

async function loadLibrary(forceRefresh = false) {
  const generation = ++loadGeneration;
  const refreshButton = $("#btn-refresh");
  refreshButton.disabled = true;
  refreshButton.setAttribute("aria-busy", "true");

  if (allItems.length === 0) {
    $("#loading-state").style.display = "flex";
    $("#card-grid").style.display = "none";
  }
  $("#empty-state").style.display = "none";

  try {
    const action = forceRefresh ? "library:refresh" : "library:list";
    const response = await chrome.runtime.sendMessage({ action });
    if (generation !== loadGeneration) return { status: "superseded" };

    if (response?.status === "auth_expired") {
      clearLibraryForAuthChange("Please log in from the Fab Downloader popup first.");
      return { status: "auth_expired" };
    }
    if (response?.status !== "ok") {
      throw new Error(response?.message || "Failed to load library");
    }

    allItems = Array.isArray(response.items) ? response.items : [];
    rebuildEngineVersions();
    $("#display-name").textContent = response.displayName || "";
    $("#loading-state").style.display = "none";
    renderCards();

    if (response.source === "stale") {
      showToast(response.warning || "Refresh failed; showing the last complete cache.", "warning");
    } else if (forceRefresh) {
      showToast(response.cacheSaved === false
        ? "Library refreshed, but the local cache could not be saved."
        : "Library refreshed");
    }
    return { status: "ok", source: response.source };
  } catch (error) {
    if (generation !== loadGeneration) return { status: "superseded" };
    debug.warn("Library load failed:", error?.message);
    $("#loading-state").style.display = "none";
    if (allItems.length > 0) {
      $("#card-grid").style.display = "grid";
      showToast(error?.message || "Failed to refresh library", "error");
    } else {
      showEmptyMessage(error?.message || "Failed to load library. Try again.");
    }
    return { status: "error" };
  } finally {
    if (generation === loadGeneration) {
      refreshButton.disabled = false;
      refreshButton.removeAttribute("aria-busy");
    }
  }
}

function rebuildEngineVersions() {
  engineVersions = new Set();
  for (const item of allItems) {
    for (const projectVersion of item.projectVersions || []) {
      for (const engineVersion of projectVersion.engineVersions || []) {
        if (typeof engineVersion === "string") engineVersions.add(engineVersion);
      }
    }
  }

  const select = $("#filter-engine");
  select.replaceChildren(createElement("option", { text: "All Engine Versions" }));
  select.firstElementChild.value = "";
  [...engineVersions]
    .sort((a, b) => parseEngineNumber(b) - parseEngineNumber(a) || a.localeCompare(b))
    .forEach((engineVersion) => {
      const option = createElement("option", { text: engineVersion });
      option.value = engineVersion;
      select.append(option);
    });
}

function parseEngineNumber(value) {
  const match = value?.match(/UE_(\d+)\.(\d+)/);
  return match ? Number(match[1]) * 100 + Number(match[2]) : 0;
}

function renderCards() {
  const grid = $("#card-grid");
  grid.replaceChildren();

  const searchTerm = $("#search-input").value.trim().toLocaleLowerCase();
  const filterType = $("#filter-type").value;
  const filterEngine = $("#filter-engine").value;

  const filtered = allItems.filter((item) => {
    const matchesSearch = !searchTerm
      || String(item.title || "").toLocaleLowerCase().includes(searchTerm)
      || String(item.seller || "").toLocaleLowerCase().includes(searchTerm);
    const matchesType = !filterType
      || item.listingType === filterType
      || item.distributionMethod === filterType;
    const matchesEngine = !filterEngine
      || (item.projectVersions || []).some((version) =>
        (version.engineVersions || []).includes(filterEngine));
    return matchesSearch && matchesType && matchesEngine;
  });

  const activeItems = filtered.filter((item) => activeDownloads.has(item.assetId));
  const visibleItems = [
    ...activeItems,
    ...filtered.filter((item) => !activeDownloads.has(item.assetId)),
  ].slice(0, MAX_RENDERED_CARDS);
  $("#result-count").textContent = filtered.length > visibleItems.length
    ? `${visibleItems.length} of ${filtered.length} matches shown · narrow search`
    : `${filtered.length} of ${allItems.length} items`;
  if (filtered.length === 0) {
    const empty = createElement("div", { className: "empty-container", text: "No matching items." });
    empty.style.gridColumn = "1 / -1";
    grid.append(empty);
  } else {
    for (const item of visibleItems) grid.append(createCard(item));
  }
  $("#empty-state").style.display = "none";
  grid.style.display = "grid";
}

function safeImageUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.username || url.password) return "";
    return url.href;
  } catch {
    return "";
  }
}

function badgesFor(item) {
  const fallback = { cls: "badge-gray", label: String(item.listingType || "Unknown") };
  const listing = TYPE_BADGES[item.listingType] || fallback;
  const distribution = TYPE_BADGES[item.distributionMethod];
  return distribution && item.distributionMethod !== item.listingType
    ? [listing, distribution]
    : [listing];
}

function createCard(item) {
  const card = createElement("article", { className: "card" });
  card.dataset.assetId = item.assetId;

  const header = createElement("div", { className: "card-header" });
  const imageUrl = safeImageUrl(item.images?.[0]?.url);
  if (imageUrl) {
    const image = createElement("img", { className: "card-thumb" });
    image.src = imageUrl;
    image.alt = "";
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => image.replaceWith(thumbnailPlaceholder(item.title)));
    header.append(image);
  } else {
    header.append(thumbnailPlaceholder(item.title));
  }

  const info = createElement("div", { className: "card-info" });
  info.append(createElement("div", {
    className: "card-title",
    text: item.title || "Untitled asset",
    title: item.title || "",
  }));
  const badges = createElement("div", { className: "card-badges" });
  for (const badge of badgesFor(item)) {
    badges.append(createElement("span", { className: `badge ${badge.cls}`, text: badge.label }));
  }
  info.append(badges);

  const engines = new Set();
  for (const version of item.projectVersions || []) {
    for (const engine of version.engineVersions || []) engines.add(engine);
  }
  const sortedEngines = [...engines].sort((a, b) => parseEngineNumber(b) - parseEngineNumber(a));
  const engineText = sortedEngines.slice(0, 8).join(", ");
  info.append(createElement("div", {
    className: "card-engines",
    text: `${engineText}${sortedEngines.length > 8 ? ` +${sortedEngines.length - 8} more` : ""}`,
  }));
  if (item.seller) info.append(createElement("div", { className: "card-seller", text: `by ${item.seller}` }));
  header.append(info);
  card.append(header);

  const detail = createElement("div", { className: "card-detail" });
  detail.append(createElement("label", {
    className: "version-select-label",
    text: "Select version to download:",
  }));
  const versionSelect = createElement("select", { className: "version-select" });
  versionSelect.append(createElement("option", { text: "Choose a version..." }));
  versionSelect.firstElementChild.value = "";
  for (const version of item.projectVersions || []) {
    const enginesLabel = (version.engineVersions || []).join(", ") || "Engine (unspecified)";
    const platforms = (version.targetPlatforms || []).join(", ") || "All";
    const option = createElement("option", {
      text: `${version.artifactId} — ${enginesLabel} [${platforms}]`,
    });
    option.value = version.artifactId;
    option.dataset.assetId = item.assetId;
    option.dataset.namespace = item.assetNamespace;
    versionSelect.append(option);
  }
  detail.append(versionSelect);

  const actions = createElement("div", { className: "card-actions" });
  const downloadButton = createElement("button", {
    className: "btn btn-primary btn-download",
    text: "Download",
  });
  downloadButton.disabled = true;
  const cancelButton = createElement("button", {
    className: "btn btn-danger btn-cancel",
    text: "Cancel",
  });
  cancelButton.style.display = "none";
  const status = createElement("span", { className: "download-status" });
  actions.append(downloadButton, cancelButton, status);
  detail.append(actions);
  card.append(detail);

  header.addEventListener("click", () => {
    if (activeDownloads.has(item.assetId) && card.classList.contains("expanded")) return;
    const wasExpanded = card.classList.contains("expanded");
    $$(".card.expanded").forEach((other) => {
      if (!activeDownloads.has(other.dataset.assetId)) other.classList.remove("expanded");
    });
    if (!wasExpanded) card.classList.add("expanded");
  });

  versionSelect.addEventListener("change", () => {
    downloadButton.disabled =
      !versionSelect.value ||
      activeDownloads.has(item.assetId) ||
      pickingAssets.has(item.assetId);
    status.replaceChildren();
  });

  downloadButton.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (activeDownloads.size + pickingAssets.size >= MAX_ACTIVE_DOWNLOADS) {
      showToast(`At most ${MAX_ACTIVE_DOWNLOADS} downloads can be active at once.`, "error");
      return;
    }
    if (
      !versionSelect.value ||
      activeDownloads.has(item.assetId) ||
      pickingAssets.has(item.assetId)
    ) {
      return;
    }

    const option = versionSelect.selectedOptions[0];
    const pickerAuthRevision = authStateRevision;
    const selection = {
      assetId: option.dataset.assetId,
      assetNamespace: option.dataset.namespace,
      artifactId: option.value,
    };
    pickingAssets.add(item.assetId);
    downloadButton.disabled = true;

    // This picker must remain the first asynchronous operation triggered by the click.
    try {
      const dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
      if (pickerAuthRevision !== authStateRevision) {
        throw new DOMException("Authentication changed.", "AbortError");
      }
      if (activeDownloads.size >= MAX_ACTIVE_DOWNLOADS) {
        throw new Error(`At most ${MAX_ACTIVE_DOWNLOADS} downloads can be active at once.`);
      }
      void startDownload({
        card,
        item,
        ...selection,
        dirHandle,
        versionSelect,
        downloadButton,
        cancelButton,
        status,
      }).catch((error) => {
        showToast(error?.message || "Could not start the download.", "error");
      });
    } catch (error) {
      if (error?.name !== "AbortError") showToast(error?.message || "Could not open the folder picker.", "error");
    } finally {
      pickingAssets.delete(item.assetId);
      if (!activeDownloads.has(item.assetId)) {
        downloadButton.disabled = !versionSelect.value;
      }
    }
  });

  cancelButton.addEventListener("click", (event) => {
    event.stopPropagation();
    const state = activeDownloads.get(item.assetId);
    if (!state) return;
    state.controller.abort();
    chrome.runtime.sendMessage({ action: "manifest:cancel", jobId: state.jobId }).catch(() => {});
    cancelButton.textContent = "Cancelling...";
    cancelButton.disabled = true;
  });

  const active = activeDownloads.get(item.assetId);
  if (active) restoreDownloadUi(card, versionSelect, downloadButton, cancelButton, status, active);
  return card;
}

function thumbnailPlaceholder(title) {
  return createElement("div", {
    className: "card-thumb-placeholder",
    text: String(title || "?").charAt(0).toLocaleUpperCase() || "?",
  });
}

async function startDownload(context) {
  const {
    card, item, assetId, assetNamespace, artifactId, dirHandle,
    versionSelect, downloadButton, cancelButton, status,
  } = context;
  const jobId = crypto.randomUUID();
  const controller = new AbortController();
  const state = {
    jobId,
    assetId,
    artifactId,
    controller,
    progress: { phase: "preparing", jobId, label: "Getting manifest..." },
    view: null,
  };
  activeDownloads.set(assetId, state);
  if (card.isConnected) {
    restoreDownloadUi(card, versionSelect, downloadButton, cancelButton, status, state);
  } else {
    renderCards();
  }

  try {
    const descriptor = await chrome.runtime.sendMessage({
      action: "manifest:prepare",
      jobId,
      assetId,
      assetNamespace,
      artifactId,
    });
    if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (descriptor?.status === "auth_expired") {
      clearLibraryForAuthChange("Please log in from the Fab Downloader popup first.");
      return;
    }
    if (descriptor?.status !== "ok") {
      throw new Error(descriptor?.message || "Failed to prepare download");
    }

    const outputBaseName = await buildOutputBaseName(
      item.title,
      descriptor.buildVersion,
      assetId,
      artifactId,
    );
    let lastUpdate = 0;
    let lastBytes = 0;
    let lastAt = performance.now();
    const result = await downloadAsset({
      manifestUrls: descriptor.manifestUrls,
      baseUrls: descriptor.baseUrls,
      baseUrlQueries: descriptor.baseUrlQueries,
      allowedOrigins: descriptor.allowedOrigins,
      dirHandle,
      outputBaseName,
      signal: controller.signal,
      confirmLargeDownload({ payloadBytes, archiveBytes, networkBytes }) {
        return window.confirm(
          `This asset describes ${formatSize(payloadBytes)} of files and an estimated ` +
          `${formatSize(archiveBytes)} TAR. CDN fallback could transfer up to ` +
          `${formatSize(networkBytes)}. Continue?`,
        );
      },
      onProgress(progress) {
        const now = performance.now();
        const terminal = ["done", "cancelled", "error"].includes(progress.phase);
        if (!terminal && now - lastUpdate < 150) return;
        const elapsed = Math.max(now - lastAt, 1);
        const totalWritten = Number(progress.totalWritten || 0);
        const speed = totalWritten > lastBytes
          ? formatSpeed((totalWritten - lastBytes) / (elapsed / 1000))
          : "";
        lastBytes = totalWritten;
        lastAt = now;
        lastUpdate = now;
        state.progress = { ...progress, jobId, speed: progress.speed || speed };
        renderDownloadProgress(state);
      },
    });

    state.progress = {
      phase: "done",
      jobId,
      filename: result.filename,
      totalWritten: result.totalBytes,
    };
    renderDownloadProgress(state);
  } catch (error) {
    const cancelled = controller.signal.aborted || error?.name === "AbortError";
    state.progress = cancelled
      ? { phase: "cancelled", jobId, message: "Cancelled." }
      : { phase: "error", jobId, message: error?.message || "Download failed." };
    renderDownloadProgress(state);
    if (!cancelled) {
      debug.warn("Download failed:", error?.message);
      showToast(error?.message || "Download failed", "error");
    }
  } finally {
    if (activeDownloads.get(assetId) === state) activeDownloads.delete(assetId);
    const view = state.view;
    if (view?.card.isConnected) {
      view.versionSelect.disabled = false;
      view.downloadButton.style.display = "";
      view.downloadButton.disabled = !view.versionSelect.value;
      view.cancelButton.style.display = "none";
      view.cancelButton.disabled = false;
      view.cancelButton.textContent = "Cancel";
      view.card.dataset.downloadActive = "0";
    }
  }
}

function restoreDownloadUi(card, select, downloadButton, cancelButton, status, state) {
  state.view = {
    card,
    versionSelect: select,
    downloadButton,
    cancelButton,
    status,
  };
  select.value = state.artifactId;
  select.disabled = true;
  downloadButton.style.display = "none";
  downloadButton.disabled = true;
  cancelButton.style.display = "";
  cancelButton.disabled = state.controller.signal.aborted;
  cancelButton.textContent = state.controller.signal.aborted ? "Cancelling..." : "Cancel";
  card.dataset.downloadActive = "1";
  card.classList.add("expanded");
  updateProgressUi(status, state.progress);
}

function renderDownloadProgress(state) {
  const status = state.view?.status;
  if (status?.isConnected) updateProgressUi(status, state.progress);
}

function updateProgressUi(status, progress) {
  status.replaceChildren();
  if (progress.phase === "done") {
    status.append(createElement("span", {
      className: "download-done",
      text: `✓ ${progress.filename || ""} (${formatSize(progress.totalWritten)})`,
    }));
    return;
  }
  if (progress.phase === "cancelled" || progress.phase === "error") {
    const message = createElement("span", { text: progress.message || progress.phase });
    message.className = progress.phase === "error" ? "download-error" : "download-cancelled";
    status.append(message);
    return;
  }

  let label = progress.label || "Preparing download...";
  let detail = "";
  if (progress.phase === "downloading") {
    label = `File ${progress.current || 0}/${progress.total || 0}`;
    detail = [progress.speed, progress.totalWritten ? formatSize(progress.totalWritten) : ""]
      .filter(Boolean).join(" · ");
  } else if (progress.phase === "file_progress") {
    const percent = progress.fileSize
      ? Math.round((progress.fileBytes || 0) / progress.fileSize * 100)
      : 0;
    label = `${String(progress.filename || "").replace(/.*\//, "")} ${percent}%`;
    detail = [progress.speed, progress.totalWritten ? formatSize(progress.totalWritten) : ""]
      .filter(Boolean).join(" · ");
  } else if (progress.phase === "finalizing") {
    label = "Finalizing archive...";
  }
  status.append(renderProgressBar(progress.current, progress.total, label, detail));
}

function renderProgressBar(current = 0, total = 0, label = "", detail = "") {
  const container = createElement("div", { className: "progress-container" });
  const background = createElement("div", { className: "progress-bar-bg" });
  const fill = createElement("div", { className: "progress-bar-fill" });
  fill.style.width = `${total ? Math.min(100, Math.round(current / total * 100)) : 0}%`;
  background.append(fill);
  const text = createElement("div", {
    className: "progress-text",
    text: detail ? `${label} · ${detail}` : label,
  });
  container.append(background, text);
  return container;
}

function sanitizeFilenamePart(value, maxLength) {
  const sanitized = String(value || "")
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/[. ]+$/g, "");
  return Array.from(sanitized).slice(0, maxLength).join("") || "unknown";
}

async function buildOutputBaseName(title, buildVersion, assetId, artifactId) {
  const identity = new TextEncoder().encode(`${assetId}\0${artifactId}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", identity));
  const suffix = [...digest.subarray(0, 6)].map((value) => value.toString(16).padStart(2, "0")).join("");
  return [
    sanitizeFilenamePart(title || "asset", 80),
    sanitizeFilenamePart(buildVersion || "version", 32),
    suffix,
  ].join("__");
}

function formatSize(bytes) {
  if (!Number.isFinite(Number(bytes)) || Number(bytes) <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = Number(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "";
  return `${formatSize(bytesPerSecond)}/s`;
}

let searchTimer;
$("#search-input").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderCards, 250);
});
$("#filter-type").addEventListener("change", renderCards);
$("#filter-engine").addEventListener("change", renderCards);
$("#btn-refresh").addEventListener("click", () => {
  const button = $("#btn-refresh");
  button.classList.add("spin-once");
  button.addEventListener("animationend", () => button.classList.remove("spin-once"), { once: true });
  loadLibrary(true);
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (
    sender?.id === chrome.runtime.id &&
    message?.action === "auth:generation" &&
    Number.isSafeInteger(message.generation) &&
    message.generation >= 0
  ) {
    clearLibraryForAuthChange();
  }
  // This notification is one-way; no response channel is kept open.
});

window.addEventListener("pagehide", () => {
  abortActiveDownloads();
});

const missing = missingBrowserFeatures();
if (missing.length > 0) {
  showEmptyMessage(`Unsupported Chrome version. Missing: ${missing.join(", ")}. Chrome 103 or newer is required.`);
  $("#btn-refresh").disabled = true;
} else {
  loadLibrary();
}
