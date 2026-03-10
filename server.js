const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// rooms[code] = { sender: ws, receiver: ws }
const rooms = {};

// Clean up old empty rooms every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const code in rooms) {
    const room = rooms[code];
    if (room.createdAt && (now - room.createdAt) > 60 * 60 * 1000) {
      delete rooms[code]; // expire after 1 hour
    }
  }
}, 10 * 60 * 1000);

wss.on('connection', (ws) => {
  let currentRoom = null;
  let currentRole = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const { type, room, ...rest } = msg;

    // ── SENDER registers a room ──────────────────────────
    if (type === 'register') {
      if (!room || room.length < 4) return;
      const code = room.toUpperCase();

      if (rooms[code] && rooms[code].sender && rooms[code].sender.readyState === 1) {
        ws.send(JSON.stringify({ type: 'error', message: 'code-taken' }));
        return;
      }

      rooms[code] = rooms[code] || { createdAt: Date.now() };
      rooms[code].sender = ws;
      currentRoom = code;
      currentRole = 'sender';

      ws.send(JSON.stringify({ type: 'registered', code }));
    }

    // ── RECEIVER joins a room ────────────────────────────
    if (type === 'join') {
      if (!room) return;
      const code = room.toUpperCase();
      const r = rooms[code];

      if (!r || !r.sender || r.sender.readyState !== 1) {
        ws.send(JSON.stringify({ type: 'room-not-found' }));
        return;
      }

      r.receiver = ws;
      currentRoom = code;
      currentRole = 'receiver';

      // Tell sender that receiver joined
      r.sender.send(JSON.stringify({ type: 'receiver-joined' }));
      ws.send(JSON.stringify({ type: 'joined', code }));
    }

    // ── RELAY: offer / answer / ice candidate ────────────
    if (type === 'offer' || type === 'answer' || type === 'ice') {
      const r = rooms[currentRoom];
      if (!r) return;

      if (currentRole === 'sender' && r.receiver?.readyState === 1) {
        r.receiver.send(JSON.stringify({ type, from: 'sender', ...rest }));
      }
      if (currentRole === 'receiver' && r.sender?.readyState === 1) {
        r.sender.send(JSON.stringify({ type, from: 'receiver', ...rest }));
      }
    }
  });

  ws.on('close', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const r = rooms[currentRoom];

    // Notify the other side
    if (currentRole === 'sender' && r.receiver?.readyState === 1) {
      r.receiver.send(JSON.stringify({ type: 'peer-left' }));
    }
    if (currentRole === 'receiver' && r.sender?.readyState === 1) {
      r.sender.send(JSON.stringify({ type: 'peer-left' }));
    }

    // Clean up
    if (currentRole === 'sender') delete r.sender;
    if (currentRole === 'receiver') delete r.receiver;
    if (!r.sender && !r.receiver) delete rooms[currentRoom];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Vault running on http://localhost:${PORT}`);
});
