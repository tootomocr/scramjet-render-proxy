"use strict";
/* Frontend controller: Scramjet + BareMux + epoxy/libcurl -> Wisp */

const form = document.getElementById("sj-form");
const address = document.getElementById("sj-address");
const searchEngine = document.getElementById("sj-search-engine");
const transportSelect = document.getElementById("sj-transport");
const ytLiteForm = document.getElementById("yt-lite-form");
const ytLiteInput = document.getElementById("yt-lite-input");
const error = document.getElementById("sj-error");
const errorCode = document.getElementById("sj-error-code");
const wispStatus = document.getElementById("wisp-status");

function resolveWispUrl() {
  const override = (window.__WISP_URL__ || "").trim();
  if (override) return override;
  return (location.protocol === "https:" ? "wss" : "ws") + "://" + location.host + "/wisp/";
}

function extractYouTubeId(input) {
  const s = (input || "").trim();
  if (!s) return null;
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s.includes("://") ? s : "https://" + s);
    if (u.hostname.includes("youtu.be")) {
      const id = u.pathname.split("/").filter(Boolean)[0];
      if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) return id;
    }
    if (u.hostname.includes("youtube.com") || u.hostname.includes("youtube-nocookie.com")) {
      const v = u.searchParams.get("v");
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
      const m = u.pathname.match(/\/(embed|shorts|live)\/([A-Za-z0-9_-]{11})/);
      if (m) return m[2];
    }
  } catch {}
  return null;
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

  async function ensureTransport() {
    const want = (transportSelect && transportSelect.value) || "epoxy";
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
        return null;
      } catch (err) {
        lastErr = err;
      }
    }
    return lastErr;
  }

  function openUrl(url) {
    let frame = document.getElementById("sj-frame");
    if (frame) frame.remove();
    const created = scramjet.createFrame();
    created.frame.id = "sj-frame";
    document.body.appendChild(created.frame);
    created.go(url);
  }

  async function prepareOrError() {
    error.textContent = "";
    errorCode.textContent = "";
    try {
      await registerSW();
    } catch (err) {
      error.textContent = "Service Worker の登録に失敗しました (https が必要です)。";
      errorCode.textContent = String((err && err.stack) || err);
      throw err;
    }
    const tErr = await ensureTransport();
    if (tErr) {
      error.textContent = "Wisp への接続設定に失敗しました。transportを切り替えて再試行してください。";
      errorCode.textContent = String((tErr && tErr.stack) || tErr) + "\nWISP=" + wispUrl;
      throw tErr;
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await prepareOrError();
    } catch {
      return;
    }
    openUrl(search(address.value, searchEngine.value));
  });

  if (ytLiteForm) {
    ytLiteForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const id = extractYouTubeId(ytLiteInput.value);
      if (!id) {
        error.textContent = "動画IDを認識できませんでした。watch URLか11桁IDを入力してください。";
        errorCode.textContent = "";
        return;
      }
      try {
        await prepareOrError();
      } catch {
        return;
      }
      openUrl("https://www.youtube-nocookie.com/embed/" + id);
    });
  }
}

main().catch((err) => {
  error.textContent = "初期化に失敗しました。";
  errorCode.textContent = String((err && err.stack) || err);
});
