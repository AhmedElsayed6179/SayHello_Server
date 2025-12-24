const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: 'https://sayhello-production-988b.up.railway.app', methods:['GET','POST'], credentials:true }});

app.use(express.json());
app.use(cors({ origin: 'https://sayhello-production-988b.up.railway.app', credentials: true }));

const sessions = new Map();
let waitingUser = null;

app.post('/start-chat', (req, res) => {
  const { name } = req.body;
  if (!name || typeof name!=='string' || name.trim().length<3 || name.trim().length>20) return res.status(400).json({ error:'Invalid name' });

  const token = crypto.randomUUID();
  sessions.set(token, name.trim());
  res.json({ token });
});

io.on('connection', socket => {
  console.log('User connected:', socket.id);

  socket.on('join', token => {
    const name = sessions.get(token);
    if (!name) { socket.emit('error','Invalid token'); return socket.disconnect(); }

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
    if (typeof msg!=='string'||!msg.trim()) return;
    if (socket.room) io.to(socket.room).emit('newMessage',{ sender:socket.userName,text:msg.trim(),time:new Date().toISOString() });
    else socket.emit('waiting');
  });

  socket.on('typing', () => { if(socket.room) socket.to(socket.room).emit('typing'); });
  socket.on('leave', () => { if(socket.room) { socket.to(socket.room).emit('partner_left'); socket.leave(socket.room); socket.room=null; }});
  socket.on('disconnect', () => { if(waitingUser && waitingUser.id===socket.id) waitingUser=null; if(socket.room) socket.to(socket.room).emit('partner_left'); });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log('Server running on port', PORT);
});
