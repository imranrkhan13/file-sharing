const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

// ── TURN credential generation ────────────────────────
// If TURN_SECRET + TURN_HOST env vars are set on Render,
// server mints short-lived HMAC credentials.
// Otherwise falls back to multiple public servers.
function getIceServers() {
  const secret = process.env.TURN_SECRET;
  const host   = process.env.TURN_HOST;

  if (secret && host) {
    const ttl      = 24 * 3600;
    const username = `${Math.floor(Date.now() / 1000) + ttl}:vault`;
    const hmac     = crypto.createHmac('sha1', secret);
    hmac.update(username);
    const credential = hmac.digest('base64');
    console.log('Using self-hosted TURN:', host);
    return [
      { urls: `stun:${host}:3478` },
      { urls: `turn:${host}:3478`, username, credential },
      { urls: `turn:${host}:3478?transport=tcp`, username, credential },
      { urls: `turns:${host}:5349`, username, credential },
    ];
  }

  // freestun.net has real static free credentials that work
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:freestun.net:3478' },
    { urls: 'turn:freestun.net:3478',      username: 'free', credential: 'free' },
    { urls: 'turn:freestun.net:5349',      username: 'free', credential: 'free' },
    { urls: 'turn:openrelay.metered.ca:80',                username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443',               username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ];
}

const app = express();
const server = http.createServer(app);

// Render needs explicit upgrade handling for WebSockets
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// Serve frontend
app.use(express.static(path.join(__dirname, 'public')));

// Send ICE servers to client on request
app.get('/ice', (req, res) => {
  res.json(getIceServers());
});

// rooms[code] = { sender: ws, receiver: ws, createdAt }
const rooms = {};

// Expire rooms older than 1 hour
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const code in rooms) {
    if (rooms[code].createdAt < cutoff) delete rooms[code];
  }
}, 10 * 60 * 1000);

wss.on('connection', (ws) => {
  let currentRoom = null;
  let currentRole = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, room, ...rest } = msg;

    // SENDER registers a room
    if (type === 'register') {
      if (!room || room.length < 4) return;
      const code = room.toUpperCase();
      if (rooms[code]?.sender?.readyState === 1) {
        ws.send(JSON.stringify({ type: 'error', message: 'code-taken' }));
        return;
      }
      rooms[code] = rooms[code] || { createdAt: Date.now() };
      rooms[code].sender = ws;
      currentRoom = code;
      currentRole = 'sender';
      ws.send(JSON.stringify({ type: 'registered', code }));
      console.log(`Room registered: ${code}`);
    }

    // RECEIVER joins a room
    if (type === 'join') {
      if (!room) return;
      const code = room.toUpperCase();
      const r = rooms[code];
      if (!r?.sender || r.sender.readyState !== 1) {
        ws.send(JSON.stringify({ type: 'room-not-found' }));
        return;
      }
      r.receiver = ws;
      currentRoom = code;
      currentRole = 'receiver';
      r.sender.send(JSON.stringify({ type: 'receiver-joined' }));
      ws.send(JSON.stringify({ type: 'joined', code }));
      console.log(`Receiver joined room: ${code}`);
    }

    // Relay signaling messages
    if (type === 'offer' || type === 'answer' || type === 'ice') {
      const r = rooms[currentRoom];
      if (!r) return;
      if (currentRole === 'sender' && r.receiver?.readyState === 1)
        r.receiver.send(JSON.stringify({ type, from: 'sender', ...rest }));
      if (currentRole === 'receiver' && r.sender?.readyState === 1)
        r.sender.send(JSON.stringify({ type, from: 'receiver', ...rest }));
    }
  });

  ws.on('close', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const r = rooms[currentRoom];
    if (currentRole === 'sender' && r.receiver?.readyState === 1)
      r.receiver.send(JSON.stringify({ type: 'peer-left' }));
    if (currentRole === 'receiver' && r.sender?.readyState === 1)
      r.sender.send(JSON.stringify({ type: 'peer-left' }));
    if (currentRole === 'sender') delete r.sender;
    if (currentRole === 'receiver') delete r.receiver;
    if (!r.sender && !r.receiver) delete rooms[currentRoom];
    console.log(`${currentRole} left room: ${currentRoom}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Vault running on port ${PORT}`));
