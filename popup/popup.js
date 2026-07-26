// Popup UI — manages auth state display and user actions
const DEBUG = false;
const dbg = (...args) => { if (DEBUG) console.warn('[Fab]', ...args); };
const $ = (sel) => document.querySelector(sel);
const states = {
  "logged-out": $("#state-logged-out"),
  loading: $("#state-loading"),
  pending: $("#state-pending"),
  "logged-in": $("#state-logged-in"),
  error: $("#state-error"),
};

function showState(name) {
  Object.values(states).forEach(el => { if (el) el.style.display = "none"; });
  const target = states[name];
  if (target) target.style.display = "flex";
}

function showToast(message, type = "success") {
  const toast = $("#toast");
  toast.textContent = message;
  toast.className = `toast toast-${type}`;
  toast.style.display = "block";
  setTimeout(() => { toast.style.display = "none"; }, 3000);
}

async function checkAuth() {
  showState("loading");
  try {
    const resp = await chrome.runtime.sendMessage({ action: "auth:status" });
    if (resp?.status === "logged_in") {
      $("#account-name").textContent = resp.displayName || "Unknown";
      $("#account-avatar").textContent = (resp.displayName || "U")[0].toUpperCase();
      loadCacheStatus();
      showState("logged-in");
    } else if (resp?.status === "logged_out") {
      showState("logged-out");
    } else {
      throw new Error(resp?.message || "Could not check your Epic login.");
    }
  } catch (e) {
    showState("error");
    $("#error-message").textContent = e.message;
  }
}

async function loadCacheStatus() {
  try {
    const resp = await chrome.runtime.sendMessage({ action: "library:status" });
    if (resp?.status === "ok") {
      const label = resp.stale ? " (stale)" : " (cached)";
      $("#cache-status").textContent = `Library: ${resp.totalCount || 0} items${label}`;
    } else {
      $("#cache-status").textContent = "";
    }
  } catch (e) { dbg('Failed to load cache status:', e.message); $("#cache-status").textContent = ""; }
}

// ====== Button handlers ======

$("#btn-login").addEventListener("click", async () => {
  try {
    const response = await chrome.runtime.sendMessage({ action: "auth:start" });
    if (response?.status !== "pending") {
      throw new Error(response?.message || "Could not start Epic login.");
    }
    showState("pending");
  } catch (e) {
    showToast(e.message, "error");
  }
});

$("#btn-open-library").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("library/library.html") });
});

$("#btn-logout").addEventListener("click", async () => {
  try {
    const response = await chrome.runtime.sendMessage({ action: "auth:logout" });
    if (response?.status !== "logged_out") {
      throw new Error(response?.message || "Could not log out.");
    }
    showState("logged-out");
  } catch (e) {
    showToast(e.message, "error");
  }
});

$("#btn-retry").addEventListener("click", checkAuth);

// Initial check
checkAuth();
