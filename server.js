const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');

// ─── JSON FILE DATABASE ───────────────────────────────────
const DB_FILE = process.env.DB_PATH || 'vault-data.json';

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[DB] Load error:', e.message);
  }
  return { transfers: [], downloads: [], nextId: 1, nextDlId: 1 };
}

function saveDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('[DB] Save error:', e.message);
  }
}

let db = loadDB();
console.log('[DB] JSON database loaded ✓ —', db.transfers.length, 'transfers,', db.downloads.length, 'downloads');

function dbAddTransfer(record) {
  const id = db.nextId++;
  db.transfers.push({ id, ...record, created_at: new Date().toISOString() });
  saveDB(db);
  return id;
}

function dbAddDownload(record) {
  const id = db.nextDlId++;
  db.downloads.push({ id, ...record, downloaded_at: new Date().toISOString() });
  saveDB(db);
  return id;
}

function dbUpdateTransfer(id, fields) {
  const t = db.transfers.find(t => t.id === id);
  if (t) { Object.assign(t, fields); saveDB(db); }
}

function dbDeleteTransfer(id) {
  db.transfers = db.transfers.filter(t => t.id !== id);
  db.downloads = db.downloads.filter(d => d.transfer_id !== id);
  saveDB(db);
}

// ─── ICE SERVERS ─────────────────────────────────────────
async function getIceServers() {
  const apiKey = process.env.METERED_API_KEY;
  const meteredUrl = (process.env.METERED_URL || '').replace(/\/+$/, '');

  if (apiKey && meteredUrl) {
    const url = `${meteredUrl}/api/v1/turn/credentials?apiKey=${apiKey}`;
    try {
      const raw = await httpGet(url);
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch (e) {
      console.log('[ICE] Fetch error:', e.message);
    }
  }

  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// ─── APP SETUP ───────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/ice', async (req, res) => {
  res.json(await getIceServers());
});

// ─── ADMIN AUTH ───────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'vault@admin123';

function adminAuth(req, res, next) {
  if (req.headers['x-admin-key'] === ADMIN_PASSWORD) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ─── ADMIN PAGE ───────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ─── ADMIN API ────────────────────────────────────────────
app.get('/api/admin/stats', adminAuth, (req, res) => {
  const now = new Date().toDateString();
  const totalTransfers = db.transfers.length;
  const totalDownloads = db.downloads.length;
  const totalSize = db.transfers.reduce((a, t) => a + (t.total_size || 0), 0);
  const p2pCount = db.transfers.filter(t => t.type === 'p2p').length;
  const linkCount = db.transfers.filter(t => t.type === 'link').length;
  const todayTransfers = db.transfers.filter(t => new Date(t.created_at).toDateString() === now).length;

  const recentActivity = db.transfers.slice(-10).reverse().map(t => ({
    ...t,
    download_count: db.downloads.filter(d => d.transfer_id === t.id).length
  }));

  res.json({ stats: { totalTransfers, totalDownloads, totalSize, p2pCount, linkCount, todayTransfers }, recentActivity });
});

app.get('/api/admin/transfers', adminAuth, (req, res) => {
  let { page = 1, limit = 20, type, search } = req.query;
  page = parseInt(page); limit = parseInt(limit);

  let rows = [...db.transfers].reverse();

  if (type && type !== 'all') rows = rows.filter(t => t.type === type);
  if (search) {
    const s = search.toLowerCase();
    rows = rows.filter(t =>
      (t.code || '').toLowerCase().includes(s) ||
      (t.token || '').toLowerCase().includes(s) ||
      (t.file_names || '').toLowerCase().includes(s) ||
      (t.sender_ip || '').toLowerCase().includes(s)
    );
  }

  const total = rows.length;
  const slice = rows.slice((page - 1) * limit, page * limit).map(t => ({
    ...t,
    download_count: db.downloads.filter(d => d.transfer_id === t.id).length
  }));

  res.json({ total, rows: slice });
});

app.get('/api/admin/downloads', adminAuth, (req, res) => {
  let { page = 1, limit = 20 } = req.query;
  page = parseInt(page); limit = parseInt(limit);

  const rows = [...db.downloads].reverse();
  const total = rows.length;
  const slice = rows.slice((page - 1) * limit, page * limit).map(d => {
    const t = db.transfers.find(t => t.id === d.transfer_id);
    return { ...d, type: t?.type, code: t?.code, token: t?.token };
  });

  res.json({ total, rows: slice });
});

app.delete('/api/admin/transfer/:id', adminAuth, (req, res) => {
  dbDeleteTransfer(parseInt(req.params.id));
  res.json({ success: true });
});

// ─── LINK STORE ───────────────────────────────────────────
const linkStore = {};
const MAX_LINK_SIZE = 100 * 1024 * 1024;

// Expire old links every 5 mins
setInterval(() => {
  const now = Date.now();
  for (const token in linkStore) {
    if (linkStore[token].expiresAt < now) {
      const entry = linkStore[token];
      if (entry.transferId) dbUpdateTransfer(entry.transferId, { status: 'expired' });
      delete linkStore[token];
      console.log('[LINK] Expired:', token);
    }
  }
}, 5 * 60 * 1000);

app.use(express.json({ limit: '110mb' }));

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
}

app.post('/upload', (req, res) => {
  const { files } = req.body;
  if (!files || !Array.isArray(files) || files.length === 0)
    return res.status(400).json({ error: 'No files provided' });

  let totalSize = 0;
  const parsed = [];
  for (const f of files) {
    if (!f.name || !f.data) return res.status(400).json({ error: 'Invalid file data' });
    const buf = Buffer.from(f.data, 'base64');
    totalSize += buf.length;
    if (totalSize > MAX_LINK_SIZE) return res.status(413).json({ error: 'Total size exceeds 100MB' });
    parsed.push({ name: f.name, type: f.type || 'application/octet-stream', data: buf, size: buf.length });
  }

  const token = crypto.randomBytes(16).toString('hex');
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
  linkStore[token] = { files: parsed, createdAt: Date.now(), expiresAt };

  const transferId = dbAddTransfer({
    type: 'link',
    code: null,
    token,
    file_names: JSON.stringify(parsed.map(f => f.name)),
    file_sizes: JSON.stringify(parsed.map(f => f.size)),
    total_size: totalSize,
    sender_ip: getClientIp(req),
    expires_at: new Date(expiresAt).toISOString(),
    status: 'active'
  });
  linkStore[token].transferId = transferId;

  console.log('[LINK] Created:', token, parsed.length, 'file(s)', totalSize, 'bytes');
  res.json({ token, url: `/dl/${token}` });
});

// ─── HTML HELPERS ─────────────────────────────────────────
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}
function getExt(name) { const p = name.lastIndexOf('.'); return p >= 0 ? name.slice(p + 1).slice(0, 4).toUpperCase() : 'FILE'; }

// ─── DOWNLOAD ROUTES ──────────────────────────────────────
app.get('/dl/:token', (req, res) => {
  const entry = linkStore[req.params.token];
  if (!entry) return res.status(404).send('<h2>Link expired or not found.</h2><a href="/">Back to Vault</a>');
  const { files, expiresAt } = entry;
  const expiresIn = Math.max(0, Math.round((expiresAt - Date.now()) / 60000));
  const filesHtml = files.map((f, i) => `
    <div class="frow">
      <div class="ficon">${getExt(f.name)}</div>
      <div class="finfo"><div class="fname">${esc(f.name)}</div><div class="fsize">${fmtSize(f.size)}</div></div>
      <a class="dlbtn" href="/dl/${req.params.token}/file/${i}" download="${esc(f.name)}">↓ Save</a>
    </div>`).join('');
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vault · Download</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',sans-serif;background:#f2f2f0;color:#0f0f0f;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:82px 20px 40px}
nav{position:fixed;top:0;left:0;right:0;height:58px;display:flex;align-items:center;padding:0 20px;background:rgba(242,242,240,.94);backdrop-filter:blur(20px);border-bottom:1px solid #e4e4e0;z-index:10}
.logo{font-size:17px;font-weight:800;display:flex;align-items:center;gap:6px;text-decoration:none;color:#0f0f0f}
.ldot{width:8px;height:8px;border-radius:50%;background:#f97316}
.wrap{max-width:480px;width:100%}.hero{text-align:center;padding:28px 0 20px}
.badge{display:inline-flex;align-items:center;gap:6px;background:#fff;border:1px solid #e4e4e0;border-radius:100px;padding:5px 12px 5px 8px;font-size:12px;font-weight:600;color:#555;margin-bottom:12px}
.bdot{width:7px;height:7px;border-radius:50%;background:#16a34a}
h1{font-size:26px;font-weight:900;letter-spacing:-.5px;margin-bottom:5px}.sub{font-size:13px;color:#555}.exp{font-size:12px;color:#999;margin-top:3px}
.card{background:#fff;border-radius:20px;padding:16px;box-shadow:0 2px 8px rgba(0,0,0,.06);margin-bottom:10px}
.frow{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid #f2f2f0}
.frow:last-child{border-bottom:none;padding-bottom:0}.frow:first-child{padding-top:0}
.ficon{width:34px;height:34px;border-radius:7px;background:#0f0f0f;color:#fff;display:flex;align-items:center;justify-content:center;font-family:'JetBrains Mono',monospace;font-size:9px;flex-shrink:0;text-transform:uppercase}
.finfo{flex:1;min-width:0}.fname{font-weight:700;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.fsize{font-size:11px;color:#999}
.dlbtn{background:#16a34a;color:#fff;border-radius:100px;padding:7px 14px;font-weight:700;font-size:12px;text-decoration:none;white-space:nowrap;flex-shrink:0}
.dlbtn:hover{background:#15803d}
.dlall{display:flex;width:100%;align-items:center;justify-content:center;padding:13px;border-radius:13px;background:#0f0f0f;color:#fff;text-decoration:none;font-weight:700;font-size:14px;margin-top:4px}
.footer{text-align:center;margin-top:16px;font-size:12px;color:#999}.footer a{color:#f97316;text-decoration:none;font-weight:600}
</style></head><body>
<nav><a class="logo" href="/"><span class="ldot"></span>Vault</a></nav>
<div class="wrap">
  <div class="hero">
    <div class="badge"><span class="bdot"></span> Ready to download</div>
    <h1>${files.length === 1 ? esc(files[0].name) : files.length + ' files'}</h1>
    <div class="sub">${files.length === 1 ? fmtSize(files[0].size) : fmtSize(files.reduce((a, f) => a + f.size, 0)) + ' · ' + files.length + ' files'}</div>
    <div class="exp">Expires in ~${expiresIn} min</div>
  </div>
  <div class="card">${filesHtml}</div>
  ${files.length > 1 ? `<a class="dlall" href="/dl/${req.params.token}/zip">↓ Download all as ZIP</a>` : ''}
  <div class="footer">Shared via <a href="/">Vault</a> · Files deleted after 24h</div>
</div></body></html>`);
});

app.get('/dl/:token/file/:index', (req, res) => {
  const entry = linkStore[req.params.token];
  if (!entry) return res.status(404).send('Not found');
  const idx = parseInt(req.params.index, 10);
  if (isNaN(idx) || idx < 0 || idx >= entry.files.length) return res.status(404).send('Not found');
  const f = entry.files[idx];

  dbAddDownload({
    transfer_id: entry.transferId || null,
    token: req.params.token,
    file_name: f.name,
    file_index: idx,
    downloader_ip: getClientIp(req)
  });

  res.setHeader('Content-Type', f.type);
  res.setHeader('Content-Disposition', `attachment; filename="${f.name}"`);
  res.setHeader('Content-Length', f.size);
  res.send(f.data);
});

app.get('/dl/:token/zip', async (req, res) => {
  const entry = linkStore[req.params.token];
  if (!entry) return res.status(404).send('Not found');
  try {
    const archiver = require('archiver');
    const archive = archiver('zip', { zlib: { level: 6 } });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="vault-files.zip"');
    archive.pipe(res);
    for (const f of entry.files) archive.append(f.data, { name: f.name });
    archive.finalize();
    dbAddDownload({ transfer_id: entry.transferId || null, token: req.params.token, file_name: 'vault-files.zip (all)', file_index: -1, downloader_ip: getClientIp(req) });
  } catch { res.redirect(`/dl/${req.params.token}/file/0`); }
});

// ─── WEBSOCKET / P2P ──────────────────────────────────────
const rooms = {};
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const code in rooms) if (rooms[code].createdAt < cutoff) delete rooms[code];
}, 10 * 60 * 1000);

wss.on('connection', (ws, req) => {
  let currentRoom = null, currentRole = null;
  const senderIp = getClientIp(req);
  const ping = setInterval(() => { if (ws.readyState === ws.OPEN) ws.ping(); }, 20000);

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const { type, room, ...rest } = msg;

    if (type === 'register') {
      if (!room || room.length < 4) return;
      const code = room.toUpperCase();
      if (rooms[code]?.sender?.readyState === 1) { ws.send(JSON.stringify({ type: 'error', message: 'code-taken' })); return; }
      rooms[code] = rooms[code] || { createdAt: Date.now() };
      rooms[code].sender = ws; currentRoom = code; currentRole = 'sender';
      rooms[code].senderIp = senderIp;
      ws.send(JSON.stringify({ type: 'registered', code }));
      console.log('[WS] Registered:', code);
    }

    if (type === 'join') {
      if (!room) return;
      const code = room.toUpperCase();
      const r = rooms[code];
      if (!r?.sender || r.sender.readyState !== 1) { ws.send(JSON.stringify({ type: 'room-not-found' })); return; }
      r.receiver = ws; currentRoom = code; currentRole = 'receiver';
      r.sender.send(JSON.stringify({ type: 'receiver-joined' }));
      ws.send(JSON.stringify({ type: 'joined', code }));
      console.log('[WS] Joined:', code);
    }

    if (type === 'offer' || type === 'answer' || type === 'ice') {
      const r = rooms[currentRoom]; if (!r) return;
      if (currentRole === 'sender' && r.receiver?.readyState === 1) r.receiver.send(JSON.stringify({ type, from: 'sender', ...rest }));
      if (currentRole === 'receiver' && r.sender?.readyState === 1) r.sender.send(JSON.stringify({ type, from: 'receiver', ...rest }));
    }
  });

  ws.on('close', () => {
    clearInterval(ping);
    if (!currentRoom || !rooms[currentRoom]) return;
    const r = rooms[currentRoom];

    // Log P2P session when sender disconnects
    if (currentRole === 'sender' && !r.dbLogged) {
      r.dbLogged = true;
      dbAddTransfer({
        type: 'p2p',
        code: currentRoom,
        token: null,
        file_names: JSON.stringify([]),
        file_sizes: JSON.stringify([]),
        total_size: 0,
        sender_ip: r.senderIp || 'unknown',
        expires_at: null,
        status: 'completed'
      });
    }

    if (currentRole === 'sender' && r.receiver?.readyState === 1) r.receiver.send(JSON.stringify({ type: 'peer-left' }));
    if (currentRole === 'receiver' && r.sender?.readyState === 1) r.sender.send(JSON.stringify({ type: 'peer-left' }));
    if (currentRole === 'sender') delete r.sender;
    if (currentRole === 'receiver') delete r.receiver;
    if (!r.sender && !r.receiver) delete rooms[currentRoom];
    console.log('[WS]', currentRole, 'left:', currentRoom);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Vault running on port ${PORT}`));
