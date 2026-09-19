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
   - Build Command: `npm install --ignore-scripts && bash scripts/install-wireproxy.sh`
   - Start Command: `bash scripts/start.sh`
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
| `DNS_SERVERS` | - | `1.1.1.1,1.0.0.1` | Wisp用DNS (フィルタなし。1.1.1.3系はアダルト等を遮断するため不使用) |
| `BLOCKED_HOSTNAMES` | - | `example.com` | カンマ区切りブロックリスト |
| `WISP_URL` | - | 空 (same-origin) | Vercel等にフロントだけ置く時に `https://xxx.onrender.com/wisp/` を指定 |
| `UPSTREAM_SOCKS` | - | 空 (直結) | `socks5://127.0.0.1:25344` を指定するとWisp上流TCPをSOCKS経由に。`start.sh` がWG設定時に自動設定 |
| `TUNNEL_BYPASS` | - | プライベート/ループバック | SOCKSを迂回するCIDR・ホスト (カンマ区切り) |
| `WISP_DNS_PASSTHROUGH` | - | `1` | トンネル時にRender側DNSを使わずホスト名をSOCKS内で解決 |

## wireproxy導入 (住宅IP経由のegress)

RenderのデータセンターIPだとYouTube (`googlevideo.com` 403) 等に弾かれるため、
自宅・VPS等のWireGuardピア経由で外に出る構成に対応しています。
仕組み: `wireproxy` (root不要のuserspace WGクライアント) がSOCKS5 (`127.0.0.1:25344`) を開き、
NodeがWisp上流TCPをすべてそこへ流します (`src/socks-tunnel.mjs`)。

1. WireGuardの設定を用意 (自宅ルーター/VPS/商用WGなど。`[Interface]` の秘密鍵と `[Peer]` が必要)
2. Render Dashboard → Environment に設定 (値はすべて秘密扱い):
   - `WG_PRIVATE_KEY`, `WG_ADDRESS` (例: `10.200.200.2/32`)
   - `WG_PEER_PUBLIC_KEY`, `WG_PEER_ENDPOINT` (例: `203.0.113.10:51820`)
   - 任意: `WG_ALLOWED_IPS` (既定 `0.0.0.0/0`), `WG_PRESHARED_KEY`, `WG_DNS`
   - 任意: `SOCKS_USERNAME` / `SOCKS_PASSWORD`
3. 再デプロイ → `GET /health` の `egress.mode` が `wireguard` になれば成功
4. `WG_PRIVATE_KEY` 未設定なら従来通り直結で動きます (デプロイは壊れません)

注意:
- TCPのみ対応 (wireproxyのSOCKS5にUDPがないため。WispのUDPは従来通り無効)
- トンネル時はDNSもWG側で解決されます (Render DNSへの漏洩なし)
- Freeプランのスリープ・帯域制限はそのままです

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
├── scripts/
│   ├── install-wireproxy.sh  # wireproxy取得 (build時)
│   └── start.sh              # WG設定→wireproxy起動→node起動
├── src/
│   ├── index.js       # Fastify + Wisp + 静的配信 + /health + /config.js
│   └── socks-tunnel.mjs  # Wisp上流TCPをSOCKS5経由化 (wireproxy用)
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
