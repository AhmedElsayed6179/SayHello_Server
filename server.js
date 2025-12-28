const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const multer = require('multer');

const app = express();
app.set('trust proxy', true);

const server = http.createServer(app);

let waitingUser = null;
let connectedUsers = 0;
const messages = [];

// إعدادات CORS
const allowedOrigin = 'https://sayhello-production-988b.up.railway.app';
const corsOptions = {
  origin: allowedOrigin,
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true
};

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', allowedOrigin);
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    cb(null, crypto.randomUUID() + '.webm');
  }
});
const upload = multer({ storage });

app.post('/upload-voice', upload.single('voice'), (req, res) => {
  const fileUrl = `https://${req.get('host')}/uploads/${req.file.filename}`;
  res.json({ url: fileUrl });
});
app.use('/uploads', express.static('uploads'));

// تسجيل المستخدم بالاسم مباشرة بدون أي تحقق
app.post('/start-chat', (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || name.trim().length < 3 || name.trim().length > 20) {
    return res.status(400).json({ error: 'Invalid name' });
  }
  const trimmedName = name.trim();
  res.json({ name: trimmedName });
});

// إعداد Socket.IO
const io = new Server(server, { cors: corsOptions });

function decreaseUserCount(socket) {
  if (waitingUser && waitingUser.id === socket.id) waitingUser = null;
  if (socket.counted) {
    connectedUsers--;
    socket.counted = false;
    io.emit('user_count', connectedUsers);
  }
}

io.on('connection', socket => {
  console.log('User connected:', socket.id);
  socket.emit('user_count', connectedUsers);

  socket.on('join', name => {
    if (!name || typeof name !== 'string') {
      socket.emit('error', 'Invalid name');
      return socket.disconnect();
    }

    const trimmedName = name.trim();
    socket.userName = trimmedName;
    socket.counted = true;
    connectedUsers++;
    io.emit('user_count', connectedUsers);

    // غرف الدردشة الثنائية
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

  // الرسائل النصية
  socket.on('sendMessage', msg => {
    if (socket.room && msg.text) {
      const chatMsg = {
        id: crypto.randomUUID(),
        sender: socket.userName,
        text: msg.text,
        time: new Date().toISOString(),
        reactions: {}
      };
      messages.push(chatMsg);
      io.to(socket.room).emit('newMessage', chatMsg);
    }
  });

  // الرسائل الصوتية
  socket.on('sendVoice', data => {
    if (socket.room && data.url) {
      const chatMsg = {
        id: crypto.randomUUID(),
        sender: socket.userName,
        url: data.url,
        duration: data.duration || 0,
        time: new Date().toISOString(),
        reactions: {}
      };
      messages.push(chatMsg);
      io.to(socket.room).emit('newVoice', chatMsg);
    }
  });

  socket.on('react', data => {
    if (!socket.room || !data.messageId) return;

    const { messageId, reaction, sender } = data;
    const msg = messages.find(m => m.id === messageId);
    if (!msg) return;

    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[reaction]) msg.reactions[reaction] = [];
    const idx = msg.reactions[reaction].indexOf(sender);
    if (idx === -1) msg.reactions[reaction].push(sender);
    else {
      msg.reactions[reaction].splice(idx, 1);
      if (msg.reactions[reaction].length === 0) delete msg.reactions[reaction];
    }
    io.to(socket.room).emit('newReaction', { messageId, reactions: msg.reactions });
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
    decreaseUserCount(socket);
  });

  socket.on('disconnect', () => {
    if (waitingUser && waitingUser.id === socket.id) waitingUser = null;
    if (socket.room) socket.to(socket.room).emit('partner_left');
    decreaseUserCount(socket);
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log('Server running on port', PORT));
