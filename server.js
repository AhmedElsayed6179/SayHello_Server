const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');

const app = express();
app.set('trust proxy', true);

const server = http.createServer(app);
const sessions = new Map(); // token => name
let waitingUser = null;
let connectedUsers = 0;
const messages = [];

const allowedOrigin = 'https://sayhello-production-988b.up.railway.app';

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', allowedOrigin);
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

// Multer للرفع
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname))
});
const upload = multer({ storage });

app.post('/upload-voice', upload.single('voice'), (req, res) => {
  const fileUrl = `https://${req.get('host')}/uploads/${req.file.filename}`;
  res.json({ url: fileUrl });
});

app.use('/uploads', express.static('uploads'));

// إنشاء جلسة جديدة
app.post('/start-chat', (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || name.trim().length < 3 || name.trim().length > 20) {
    return res.status(400).json({ error: 'Invalid name' });
  }
  const token = crypto.randomUUID();
  sessions.set(token, name.trim());
  res.json({ token });
});

// Socket.IO
const io = new Server(server, { cors: { origin: allowedOrigin, methods: ['GET', 'POST'], credentials: true } });

function removeUser(socket) {
  if (waitingUser && waitingUser.id === socket.id) waitingUser = null;
  if (socket.counted) {
    connectedUsers--;
    socket.counted = false;
    io.emit('user_count', connectedUsers);
  }
}

io.on('connection', socket => {
  socket.emit('user_count', connectedUsers);

  socket.on('join', token => {
    const name = sessions.get(token);
    if (!name) return socket.disconnect();

    socket.userName = name;
    sessions.delete(token);

    socket.counted = true;
    connectedUsers++;
    io.emit('user_count', connectedUsers);

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
    if (socket.room && msg.id && msg.text && msg.senderName) {
      const chatMsg = {
        id: msg.id,
        sender: msg.senderName, // الاسم الحقيقي للآخرين
        text: msg.text,
        time: new Date().toISOString(),
        reactions: {}
      };
      messages.push(chatMsg);
      io.to(socket.room).emit('newMessage', chatMsg);
    }
  });

  socket.on('sendVoice', data => {
    if (socket.room && data.id) {
      const chatMsg = {
        id: data.id,
        sender: socket.userName,
        url: data.url,
        duration: data.duration,
        time: new Date().toISOString(),
        reactions: {}
      };
      messages.push(chatMsg);
      io.to(socket.room).emit('newVoice', chatMsg);
    }
  });

  socket.on('react', data => {
    if (!socket.room || !data.messageId) return;

    const msg = messages.find(m => m.id === data.messageId);
    if (!msg) return;

    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[data.reaction]) msg.reactions[data.reaction] = [];
    const idx = msg.reactions[data.reaction].indexOf(data.sender);

    if (idx === -1) msg.reactions[data.reaction].push(data.sender);
    else msg.reactions[data.reaction].splice(idx, 1);

    if (msg.reactions[data.reaction].length === 0) delete msg.reactions[data.reaction];
    io.to(socket.room).emit('newReaction', { messageId: data.messageId, reactions: msg.reactions });
  });

  socket.on('typing', () => { if (socket.room) socket.to(socket.room).emit('typing'); });
  socket.on('startRecording', () => { if (socket.room) socket.to(socket.room).emit('partnerRecording', true); });
  socket.on('stopRecording', () => { if (socket.room) socket.to(socket.room).emit('partnerRecording', false); });

  socket.on('leave', () => {
    if (socket.room) {
      socket.to(socket.room).emit('partner_left');
      socket.leave(socket.room);
      socket.room = null;
    }
    removeUser(socket);
  });

  socket.on('disconnect', () => {
    if (socket.room) socket.to(socket.room).emit('partner_left');
    removeUser(socket);
  });
});

server.listen(process.env.PORT || 8080, () => console.log('Server running'));
