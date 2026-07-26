// Content script injected into Epic's OAuth redirect response.
(function () {
  "use strict";

  const DEBUG = false;
  const MAX_OAUTH_BODY_CHARS = 16 * 1024;
  const dbg = (...args) => { if (DEBUG) console.log("[Fab]", ...args); };

  if (window.__fabOAuthProcessed) return;
  window.__fabOAuthProcessed = true;

  function extractResult() {
    try {
      const bodyText = document.body?.textContent || "";
      if (bodyText.length > MAX_OAUTH_BODY_CHARS) return null;
      const trimmed = bodyText.trim();
      if (!trimmed.startsWith("{")) return null;

      const data = JSON.parse(trimmed);
      const code = typeof data.authorizationCode === "string" ? data.authorizationCode.trim() : "";
      const state = typeof data.state === "string" ? data.state : "";
      if (code.length >= 10 && code.length <= 512 && state.length <= 512) {
        return { code, state };
      }
    } catch {
      dbg("OAuth response is not ready yet");
    }
    return null;
  }

  function renderResult({ success, title, message, detail }) {
    const container = document.createElement("main");
    Object.assign(container.style, {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      minHeight: "100vh",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      background: "#16161a",
      color: "#d4d4d8",
      textAlign: "center",
      padding: "2rem",
      boxSizing: "border-box",
    });

    const icon = document.createElement("div");
    icon.textContent = success ? "✓" : "⚠";
    icon.style.cssText = "font-size:4rem;margin-bottom:1rem";

    const heading = document.createElement("h1");
    heading.textContent = title;
    heading.style.cssText = `color:${success ? "#5ad8a0" : "#e08888"};margin-bottom:.5rem`;

    const body = document.createElement("p");
    body.textContent = message;
    body.style.cssText = "font-size:1.1rem;color:#88889a";

    const footer = document.createElement("p");
    footer.textContent = detail;
    footer.style.cssText = "color:#6a6a7e;margin-top:2rem";

    container.append(icon, heading, body, footer);
    document.body.replaceChildren(container);
  }

  function notifyBackground(result) {
    chrome.runtime.sendMessage({ action: "auth:code", ...result }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn("Fab Extension: Failed to finish OAuth:", chrome.runtime.lastError.message);
        renderResult({
          success: false,
          title: "Authentication Failed",
          message: "The extension could not finish the login transaction.",
          detail: "Please try again from the Fab Downloader popup.",
        });
        return;
      }

      if (response?.status === "ok") {
        renderResult({
          success: true,
          title: "Login Successful!",
          message: `Logged in as ${response.displayName || "Epic user"}`,
          detail: "You can close this tab and return to the Fab Downloader extension.",
        });
      } else {
        renderResult({
          success: false,
          title: "Authentication Failed",
          message: response?.message || "Unknown error",
          detail: "Please try again from the Fab Downloader popup.",
        });
      }
    });
  }

  const initialResult = extractResult();
  if (initialResult) {
    notifyBackground(initialResult);
    return;
  }

  const observer = new MutationObserver(() => {
    const result = extractResult();
    if (!result) return;
    observer.disconnect();
    notifyBackground(result);
  });

  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  setTimeout(() => observer.disconnect(), 5 * 60 * 1000);
})();
