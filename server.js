const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

// المتغيرات الأساسية
const sessions = new Map();
let waitingUser = null;

// إعدادات CORS
const allowedOrigin = 'https://sayhello-production-988b.up.railway.app';
const corsOptions = {
  origin: allowedOrigin,
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true
};

// Middleware للتعامل مع CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', allowedOrigin);
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') return res.sendStatus(200); // preflight
  next();
});

app.use(express.json());

// نقطة نهاية إنشاء التوكن
app.post('/start-chat', (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || name.trim().length < 3 || name.trim().length > 20) {
    return res.status(400).json({ error: 'Invalid name' });
  }
  const token = crypto.randomUUID();
  sessions.set(token, name.trim());
  res.json({ token });
});

// إعداد Socket.IO
const io = new Server(server, { cors: corsOptions });

async function broadcastRoomUsers() {
  try {
    const clients = await io.in('main-room').allSockets();
    const count = clients.size;
    io.in('main-room').emit('roomUsersCount', count);
  } catch (err) {
    console.error(err);
  }
}

io.on('connection', socket => {
  console.log('User connected:', socket.id);

  socket.on('join', async token => {
    const name = sessions.get(token);
    if (!name) { socket.emit('error', 'Invalid token'); return socket.disconnect(); }

    socket.userName = name;
    sessions.delete(token);

    socket.join('main-room');   // ادخل الغرفة أولاً
    await broadcastRoomUsers(); // ثم حدث العدد

    if (waitingUser && waitingUser.id !== socket.id) {
      const room = `room-${socket.id}-${waitingUser.id}`;
      socket.join(room);
      waitingUser.join(room);
      socket.room = room;
      waitingUser.room = room;
      io.to(room).emit('connected');
      waitingUser = null;
    } else {
      waitingUser = socket;
      socket.emit('waiting');
    }
  });

  socket.on('sendMessage', msg => {
    if (typeof msg !== 'string' || !msg.trim()) return;
    if (socket.room) io.to(socket.room).emit('newMessage', { sender: socket.userName, text: msg.trim(), time: new Date().toISOString() });
    else socket.emit('waiting');
  });

  socket.on('typing', () => { if (socket.room) socket.to(socket.room).emit('typing'); });
  socket.on('leave', async () => {
    if (socket.room) {
      socket.to(socket.room).emit('partner_left');
      socket.leave(socket.room);
      socket.leave('main-room');
      await broadcastRoomUsers(); // <-- هنا
      socket.room = null;
    }
  });
  socket.on('disconnect', async () => {
    if (waitingUser && waitingUser.id === socket.id) waitingUser = null;
    if (socket.room) {
      socket.to(socket.room).emit('partner_left');
      socket.leave('main-room');
      await broadcastRoomUsers(); // <-- هنا
    }
  });
});

// تشغيل السيرفر
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log('Server running on port', PORT));
