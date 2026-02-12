require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const db = require('./db');
const { authMiddleware, generateToken, bcrypt, uuidv4 } = require('./auth');
const { tokenize, jaccard } = require('./utils');

const PORT = process.env.PORT || 4000;
const MATCH_THRESHOLD = parseFloat(process.env.MATCH_THRESHOLD || '0.2');

const app = express();
app.use(cors());
app.use(express.json());

// --- auth routes ---
app.post('/auth/register', async (req, res) => {
  const { username, password, bio = '', interests = '' } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'missing fields' });
  const id = uuidv4();
  const pwHash = await bcrypt.hash(password, 10);
  db.run(
    `INSERT INTO users (id, username, password_hash, bio, interests, last_online) VALUES (?,?,?,?,?,?)`,
    [id, username, pwHash, bio, interests, Date.now()],
    function (err) {
      if (err) return res.status(400).json({ error: err.message });
      const token = generateToken({ id, username });
      res.json({ token, user: { id, username, bio, interests } });
    }
  );
});

app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
    if (err || !user) return res.status(400).json({ error: 'invalid credentials' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(400).json({ error: 'invalid credentials' });
    const token = generateToken(user);
    db.run(`UPDATE users SET last_online = ? WHERE id = ?`, [Date.now(), user.id]);
    res.json({ token, user: { id: user.id, username: user.username, bio: user.bio, interests: user.interests } });
  });
});

// get profile
app.get('/me', authMiddleware, (req, res) => {
  db.get(`SELECT id, username, bio, interests, last_online FROM users WHERE id = ?`, [req.user.id], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'not found' });
    res.json({ user });
  });
});

// update profile
app.post('/me', authMiddleware, (req, res) => {
  const { bio = '', interests = '' } = req.body;
  db.run(`UPDATE users SET bio = ?, interests = ? WHERE id = ?`, [bio, interests, req.user.id], function (err) {
    if (err) return res.status(400).json({ error: err.message });
    res.json({ ok: true });
  });
});

// simple match endpoint — returns candidates with similarity score
app.get('/match', authMiddleware, (req, res) => {
  db.all(`SELECT id, username, bio, interests, last_online FROM users WHERE id != ? LIMIT 200`, [req.user.id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    db.get(`SELECT interests, bio FROM users WHERE id = ?`, [req.user.id], (err2, me) => {
      if (err2 || !me) return res.status(500).json({ error: err2?.message || 'no me' });
      const meText = `${me.bio} ${me.interests || ''}`;
      const meTokens = tokenize(meText);
      const results = rows.map(r => {
        const otherText = `${r.bio} ${r.interests || ''}`;
        const score = jaccard(meTokens, tokenize(otherText));
        return { id: r.id, username: r.username, bio: r.bio, interests: r.interests, last_online: r.last_online, score };
      }).filter(x => x.score >= MATCH_THRESHOLD).sort((a, b) => b.score - a.score);
      res.json({ matches: results });
    });
  });
});

// confirm match creation (one side requests, other accepts via socket events, but provide endpoint to list matches)
app.get('/matches', authMiddleware, (req, res) => {
  db.all(`SELECT * FROM matches WHERE user_a = ? OR user_b = ?`, [req.user.id, req.user.id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ matches: rows });
  });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// In-memory map id -> socketId (basic presence)
const online = new Map();

// Socket events
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next();
  try {
    const jwt = require('jsonwebtoken');
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret');
    socket.user = payload;
    return next();
  } catch (e) {
    return next();
  }
});

io.on('connection', (socket) => {
  const user = socket.user;
  if (user && user.id) {
    online.set(user.id, socket.id);
    db.run(`UPDATE users SET last_online = ? WHERE id = ?`, [Date.now(), user.id]);
    io.emit('presence', { userId: user.id, status: 'online' });
  }

  socket.on('request_match', async (payload) => {
    // payload: { targetId }
    if (!user || !user.id) return socket.emit('error', 'unauth');
    const target = payload.targetId;
    const id = uuidv4();
    const created_at = Date.now();
    db.run(
      `INSERT INTO matches (id, user_a, user_b, status, created_at) VALUES (?,?,?,?,?)`,
      [id, user.id, target, 'requested', created_at],
      (err) => {
        if (err) return socket.emit('error', err.message);
        socket.emit('match_requested', { id, target });
        const targetSocket = online.get(target);
        if (targetSocket) io.to(targetSocket).emit('incoming_match', { id, from: user.id });
      }
    );
  });

  socket.on('accept_match', (payload) => {
    // payload: { matchId }
    const matchId = payload.matchId;
    db.get(`SELECT * FROM matches WHERE id = ?`, [matchId], (err, row) => {
      if (err || !row) return socket.emit('error', 'match not found');
      if (row.user_b !== user.id && row.user_a !== user.id) return socket.emit('error', 'not permitted');
      db.run(`UPDATE matches SET status = ? WHERE id = ?`, ['accepted', matchId], function (err2) {
        if (err2) return socket.emit('error', err2.message);
        // create room id deterministic
        const roomId = `room_${matchId}`;
        // notify both
        const aSock = online.get(row.user_a);
        const bSock = online.get(row.user_b);
        if (aSock) io.to(aSock).emit('match_accepted', { matchId, roomId });
        if (bSock) io.to(bSock).emit('match_accepted', { matchId, roomId });
      });
    });
  });

  socket.on('join_room', (payload) => {
    const room = payload.roomId;
    socket.join(room);
  });

  socket.on('send_message', (payload) => {
    // payload: { roomId, text }
    if (!user || !user.id) return socket.emit('error', 'unauth');
    const { roomId, text } = payload;
    const id = uuidv4();
    const created_at = Date.now();
    db.run(
      `INSERT INTO messages (id, room_id, sender_id, text, created_at) VALUES (?,?,?,?,?)`,
      [id, roomId, user.id, text, created_at],
      (err) => {
        if (err) return socket.emit('error', err.message);
        io.to(roomId).emit('message', { id, roomId, senderId: user.id, text, created_at });
      }
    );
  });

  socket.on('disconnect', () => {
    if (user && user.id) {
      online.delete(user.id);
      io.emit('presence', { userId: user.id, status: 'offline' });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
});
