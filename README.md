# Vault — P2P File Transfer

Direct browser-to-browser file transfer. Share a 6-letter code, files fly over encrypted. Works worldwide across any network.

## How it works
- Your server handles **signaling only** (tiny WebSocket messages to connect the two browsers)
- Actual file data goes **directly** between browsers via WebRTC — never touches your server
- Works across different Wi-Fi, mobile data, different countries

---

## Deploy on Vercel

> ⚠️ **Important:** Vercel's free tier does NOT support WebSockets (serverless functions time out).
> Use Render or Glitch instead for free hosting, or upgrade to Vercel Pro.

If you have Vercel Pro or want to try anyway:
```bash
npm i -g vercel
vercel
```

---

## Deploy on Render (Recommended — Free & Works)

1. Push this folder to a GitHub repo
2. Go to https://render.com → New → Web Service
3. Connect your GitHub repo
4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment:** Node
   - **Plan:** Free
5. Click Deploy
6. Your URL will be something like `https://vault-xyz.onrender.com`

Done. Share that URL with anyone — it works worldwide.

---

## Deploy on Glitch (Easiest — Free)

1. Go to https://glitch.com → New Project → Import from GitHub
2. Paste your GitHub repo URL
   
   **OR** manually:
   1. New Project → "glitch-hello-node"
   2. Delete the default files
   3. Upload/paste `server.js`, `package.json`, and the `public/` folder
3. Glitch auto-starts it. Your URL: `https://your-project.glitch.me`

---

## Run locally (for testing)

```bash
npm install
npm start
# Open http://localhost:3000
# Open another tab/device on same network: http://YOUR-LOCAL-IP:3000
```

---

## Project structure

```
vault/
├── server.js          ← WebSocket signaling server + Express static server
├── package.json
├── vercel.json        ← Vercel config (needs Pro for WebSockets)
└── public/
    └── index.html     ← Full frontend (HTML + CSS + JS, single file)
```

## How the signaling works

```
Sender                  Server                  Receiver
  |                       |                        |
  |── register(CODE) ────>|                        |
  |<── registered ────────|                        |
  |                       |<──── join(CODE) ────────|
  |<── receiver-joined ───|──── joined ────────────>|
  |── offer(SDP) ────────>|──── offer(SDP) ────────>|
  |                       |<──── answer(SDP) ────────|
  |<── answer(SDP) ───────|                        |
  |── ice ───────────────>|──── ice ───────────────>|
  |<── ice ───────────────|<──── ice ────────────────|
  |                                                 |
  |<════════ WebRTC DataChannel (direct P2P) ════════|
  |              Files stream directly               |
```
# file-sharing
