const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();

app.set('trust proxy', true);

const server = http.createServer(app);

const sessions = new Map();
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

// Middleware للتعامل مع CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', allowedOrigin);
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

// إعداد multer لتخزين الملفات
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    cb(null, crypto.randomUUID() + '.webm');
  }
});
const upload = multer({ storage });

// خريطة لتخزين الملفات حسب الغرفة
const roomFiles = new Map();

// رفع الصوت
app.post('/upload-voice', upload.single('voice'), (req, res) => {
  const room = req.body.room; // يجب إرسال room مع الفورم
  if (!room) return res.status(400).json({ error: 'Room is required' });

  const filePath = path.join('uploads', req.file.filename);
  if (!roomFiles.has(room)) roomFiles.set(room, []);
  roomFiles.get(room).push(filePath);

  const fileUrl = `https://${req.get('host')}/uploads/${req.file.filename}`;
  res.json({ url: fileUrl });
});

// مسح ملفات الغرفة عند انتهاء الشات
function clearRoomFiles(room) {
  const files = roomFiles.get(room);
  if (!files) return;

  files.forEach(file => {
    fs.unlink(file, err => {
      if (err) console.error('Failed to delete file', file, err);
    });
  });

  roomFiles.delete(room);
}

app.use('/uploads', express.static('uploads'));

// إنشاء توكن للمستخدم
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

function decreaseUserCount(socket) {
  if (waitingUser && waitingUser.id === socket.id) {
    waitingUser = null;
  }

  if (socket.counted) {
    connectedUsers--;
    socket.counted = false;
    io.emit('user_count', connectedUsers);
  }
}

io.on('connection', socket => {
  console.log('User connected:', socket.id);

  // لا تزيد connectedUsers هنا
  socket.emit('user_count', connectedUsers);

  socket.on('join', async token => {
    const name = sessions.get(token);
    if (!name) { socket.emit('error', 'Invalid token'); return socket.disconnect(); }

    socket.userId = socket.id;
    socket.userName = name;
    sessions.delete(token);

    // فقط عند انضمام المستخدم الفعلي
    socket.counted = true; // فلاغ جديد
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

  socket.on('sendMessage', msg => {
    if (socket.room && msg.id && msg.text) {
      const chatMsg = {
        id: msg.id,
        sender: socket.userName,
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

    const { messageId, reaction, sender } = data;
    const msg = messages.find(m => m.id === messageId);
    if (!msg) return;

    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[reaction]) msg.reactions[reaction] = [];

    const idx = msg.reactions[reaction].indexOf(sender);

    if (idx === -1) {
      msg.reactions[reaction].push(sender);
    } else {
      msg.reactions[reaction].splice(idx, 1);
      if (msg.reactions[reaction].length === 0) {
        delete msg.reactions[reaction];
      }
    }

    io.to(socket.room).emit('newReaction', {
      messageId,
      reactions: msg.reactions
    });
  });

  socket.on('typing', () => {
    if (socket.room) socket.to(socket.room).emit('typing');
  });

  socket.on('startRecording', () => {
    if (!socket.room) return;

    socket.to(socket.room).emit('partnerRecording', true);
  });

  socket.on('stopRecording', () => {
    if (!socket.room) return;

    socket.to(socket.room).emit('partnerRecording', false);
  });

  socket.on('leave', async () => {
    if (socket.room) {
      socket.to(socket.room).emit('partner_left');
      socket.leave(socket.room);
      socket.room = null;
      clearRoomFiles(socket.room);
    }

    decreaseUserCount(socket);
  });

  socket.on('disconnect', async () => {
    if (waitingUser && waitingUser.id === socket.id) waitingUser = null;
    if (socket.room) {
      const room = socket.room;
      socket.to(room).emit('partner_left');
      clearRoomFiles(socket.room);
    }

    decreaseUserCount(socket);
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log('Server running on port', PORT));
