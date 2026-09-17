# Scramjet + Wisp Proxy — Render 一発デプロイ版

GitHubにそのまま置いて、Renderの **Import → Deploy** だけで動く構成です。
Scramjet (frontend rewrite) + BareMux + libcurl + Wisp (`wisp-js/server`) 内蔵。

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

> ⚠️ 重要: **Vercel単体では Wisp は動きません。**
> Vercelはサーバーレス (10秒タイムアウト・生WebSocket upgrade `/wisp/` の永続接続が保てない) のため、
> Scramjet+Wispのフル構成はRender / VPS / Fly.io等の常駐Nodeサーバーが必要です。
> 本リポジトリは **Render専用サーバー + 任意でVercelにフロントだけ置く** 両対応です。

## 使い方 (Render)

### A. Blueprint (推奨・1クリック)
1. このリポジトリをGitHubにpush
2. Render Dashboard → **New + → Blueprint** → このリポジトリを選択
3. `render.yaml` が検出される → **Apply** / **Deploy**
4. `https://<service>.onrender.com` で開く → URLを入力して利用

### B. Web Service手動
1. Render Dashboard → **New + → Web Service** → リポジトリ選択
2. 設定:
   - Runtime: `Node`
   - Build Command: `npm install --ignore-scripts`
   - Start Command: `npm start`
   - Health Check Path: `/health`
   - Plan: `Free`
3. **Deploy** → URLで開く

`npm install --ignore-scripts` にしている理由:
`@mercuryworkshop/scramjet` の `preinstall: only-allow pnpm` を回避するためです。
ビルド済みファイルを使うので `--ignore-scripts` で問題ありません。

## 動作確認

- `GET /health` → `{"ok":true,...}`
- `GET /config.js` → `window.__WISP_URL__ = ""`
- トップページでURLを開ける (内部で `wss://<host>/wisp/` + `/libcurl/index.mjs` + `/scram/*` を使用)

## 環境変数

| 変数 | 必須 | 既定 | 説明 |
|---|---|---|---|
| `PORT` | Renderが注入 | `10000` | Renderは自動設定。触らない |
| `HOST` | - | `0.0.0.0` | Renderは `0.0.0.0` 必須 |
| `DNS_SERVERS` | - | `1.1.1.3,1.0.0.3` | Wisp用DNS |
| `BLOCKED_HOSTNAMES` | - | `example.com` | カンマ区切りブロックリスト |
| `WISP_URL` | - | 空 (same-origin) | Vercel等にフロントだけ置く時に `https://xxx.onrender.com/wisp/` を指定 |

## Vercelにフロントだけ置きたい場合 (上級)

1. 先にRender側をデプロイして `https://xxx.onrender.com` を得る
2. Renderの Environment に `WISP_URL=https://xxx.onrender.com/wisp/` を設定 (またはVercel側で `/config.js` を上書き)
3. Vercelには `public/` の静的ファイル + `/scram/` `/libcurl/` `/baremux/` のアセットが必要なため、基本的には **Render1台で完結させるのが推奨** です。
   Vercel単体で `/wisp/` は動かないので、必ずRenderのWispを指してください。

## ローカル開発

```bash
npm install --ignore-scripts
npm start
# http://localhost:10000
```

## 構成

```
.
├── render.yaml        # Render Blueprint (Import→Deployの本体)
├── package.json       # npm / Node18+ / startのみ
├── src/index.js       # Fastify + Wisp + 静的配信 + /health + /config.js
└── public/
    ├── index.html     # UI
    ├── index.js       # ScramjetController + BareMux + libcurl
    ├── sw.js          # ScramjetServiceWorker
    ├── register-sw.js # SW登録
    ├── search.js      # URL/検索判定
    ├── index.css
    └── 404.html
```

`/scram/` `/libcurl/` `/baremux/` は `node_modules` から自動配信されます (ビルド不要)。

## クレジット

- [MercuryWorkshop/scramjet](https://github.com/MercuryWorkshop/scramjet)
- [MercuryWorkshop/Scramjet-App](https://github.com/MercuryWorkshop/Scramjet-App) (本リポジトリのベース)
- [MercuryWorkshop/wisp-js](https://github.com/MercuryWorkshop/wisp-js)
- [MercuryWorkshop/bare-mux](https://github.com/MercuryWorkshop/bare-mux) / libcurl-transport

License: AGPL-3.0-or-later (Wisp/Scramjet由来)
