"use strict";
/* Frontend controller: Scramjet + BareMux + epoxy/libcurl -> Wisp */

const form = document.getElementById("sj-form");
const address = document.getElementById("sj-address");
const searchEngine = document.getElementById("sj-search-engine");
const transportSelect = document.getElementById("sj-transport");
const error = document.getElementById("sj-error");
const errorCode = document.getElementById("sj-error-code");
const wispStatus = document.getElementById("wisp-status");

function resolveWispUrl() {
  // Server-injected override (Vercel-static mode). Empty on normal Render deploy.
  const override = (window.__WISP_URL__ || "").trim();
  if (override) return override;
  return (location.protocol === "https:" ? "wss" : "ws") + "://" + location.host + "/wisp/";
}

async function main() {
  const { ScramjetController } = $scramjetLoadController();

  const scramjet = new ScramjetController({
    files: {
      wasm: "/scram/scramjet.wasm.wasm",
      all: "/scram/scramjet.all.js",
      sync: "/scram/scramjet.sync.js",
    },
  });
  scramjet.init();

  const connection = new BareMux.BareMuxConnection("/baremux/worker.js");
  const wispUrl = resolveWispUrl();
  if (wispStatus) wispStatus.textContent = "wisp: " + wispUrl;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    errorCode.textContent = "";

    try {
      await registerSW();
    } catch (err) {
      error.textContent = "Service Worker の登録に失敗しました (https が必要です)。";
      errorCode.textContent = String(err && err.stack || err);
      throw err;
    }

    const url = search(address.value, searchEngine.value);
    const want = (transportSelect && transportSelect.value) || "epoxy";

    // Chrome -> Epoxy first (YouTube/อย่างไร video streaming needs it).
    // Firefox -> Libcurl first. Fall back to the other on failure.
    const attempts =
      want === "epoxy"
        ? [
            ["/epoxy/index.mjs", [{ wisp: wispUrl }]],
            ["/libcurl/index.mjs", [{ websocket: wispUrl }]],
          ]
        : [
            ["/libcurl/index.mjs", [{ websocket: wispUrl }]],
            ["/epoxy/index.mjs", [{ wisp: wispUrl }]],
          ];

    let lastErr = null;
    for (const [mod, args] of attempts) {
      try {
        await connection.setTransport(mod, args);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr) {
      error.textContent = "Wisp への接続設定に失敗しました。transportを切り替えて再試行してください。";
      errorCode.textContent = String(lastErr && lastErr.stack || lastErr) + "\nWISP=" + wispUrl;
      return;
    }

    // Reuse single frame
    let frame = document.getElementById("sj-frame");
    if (!frame) {
      const created = scramjet.createFrame();
      created.frame.id = "sj-frame";
      document.body.appendChild(created.frame);
      created.frame.classList.add("sj-frame-ready");
      created.go(url);
    } else {
      // createFrame each navigation is simplest & leak-free enough for v1
      frame.remove();
      const created = scramjet.createFrame();
      created.frame.id = "sj-frame";
      document.body.appendChild(created.frame);
      created.go(url);
    }
  });
}

main().catch((err) => {
  error.textContent = "初期化に失敗しました。";
  errorCode.textContent = String(err && err.stack || err);
});
