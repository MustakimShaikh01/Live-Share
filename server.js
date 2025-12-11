require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const cors = require('cors');
const path = require('path');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server);

// In-memory rooms: { roomCode: { sockets: [id,...], adminToken } }
const rooms = {};

function makeRoomCode() {
  return crypto.randomBytes(3).toString('hex'); // 6 hex chars
}

// Admin API to create room
app.post('/create-room', (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const code = makeRoomCode();
  const adminToken = crypto.randomBytes(12).toString('hex');
  rooms[code] = { sockets: [], adminToken };
  return res.json({ ok: true, code, adminToken });
});

// Optional API to list active rooms (admin only)
app.get('/rooms', (req, res) => {
  const { password } = req.query;
  if (!password || password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false });
  const snapshot = Object.fromEntries(Object.entries(rooms).map(([k,v]) => [k, { count: v.sockets.length }]));
  res.json({ ok: true, rooms: snapshot });
});

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  socket.on('join-room', ({ room }) => {
    if (!room) return socket.emit('error-message', 'Missing room code');
    const r = rooms[room];
    if (!r) return socket.emit('error-message', 'Room not found');
    if (r.sockets.length >= 2) return socket.emit('error-message', 'Room full');
    socket.join(room);
    r.sockets.push(socket.id);
    socket.data.room = room;
    console.log(`${socket.id} joined ${room}`);
    // notify others
    socket.to(room).emit('peer-joined', { id: socket.id });
    // inform the joiner who is already present (if any)
    const others = r.sockets.filter(id => id !== socket.id);
    socket.emit('joined', { you: socket.id, others });
  });

  socket.on('leave-room', () => {
    const room = socket.data.room;
    if (!room) return;
    socket.leave(room);
    const r = rooms[room];
    if (r) {
      r.sockets = r.sockets.filter(id => id !== socket.id);
      socket.to(room).emit('peer-left', { id: socket.id });
      // if room empty, delete it
      if (r.sockets.length === 0) delete rooms[room];
    }
    delete socket.data.room;
  });

  socket.on('signal', ({ to, data }) => {
    if (!to) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('disconnect', () => {
    const room = socket.data.room;
    if (room) {
      const r = rooms[room];
      if (r) {
        r.sockets = r.sockets.filter(id => id !== socket.id);
        socket.to(room).emit('peer-left', { id: socket.id });
        if (r.sockets.length === 0) delete rooms[room];
      }
    }
    console.log('socket disconnected', socket.id);
  });
});

server.listen(PORT, () => {
  console.log('Server listening on port', PORT);
});
