const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

const corsOptions = {
  origin: 'https://sayhello-production-988b.up.railway.app',
  methods: ['GET','POST','OPTIONS'],
  credentials: true
};

// السماح بالـ CORS لكل الطلبات
app.use(cors(corsOptions));
app.use(express.json());

// preflight request handler
app.options('/start-chat', (req, res) => {
  res.header('Access-Control-Allow-Origin', corsOptions.origin);
  res.header('Access-Control-Allow-Methods', 'POST,GET,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(200); // مهم جداً
});

// Route: start chat
app.post('/start-chat', (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || name.trim().length < 3 || name.trim().length > 20) {
    return res.status(400).json({ error: 'Invalid name' });
  }
  const token = crypto.randomUUID();
  res.json({ token });
});

// Socket.IO setup
const io = new Server(server, { cors: corsOptions });

io.on('connection', socket => {
  console.log('User connected:', socket.id);

  socket.on('join', token => {
    const name = sessions.get(token);
    if (!name) { socket.emit('error', 'Invalid token'); return socket.disconnect(); }

    socket.userName = name;
    sessions.delete(token);

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
  socket.on('leave', () => { if (socket.room) { socket.to(socket.room).emit('partner_left'); socket.leave(socket.room); socket.room = null; } });
  socket.on('disconnect', () => { if (waitingUser && waitingUser.id === socket.id) waitingUser = null; if (socket.room) socket.to(socket.room).emit('partner_left'); });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log('Server running on port', PORT);
});
