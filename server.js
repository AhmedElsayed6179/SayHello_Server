const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');

const app = express();
app.set('trust proxy', true);
const server = http.createServer(app);

const sessions = new Map(); // token -> name
let waitingUsers = [];
let connectedUsers = 0;

// استبدل هذا الرابط برابط الفرونت إند الخاص بك
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
app.use('/uploads', express.static('uploads'));

const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    cb(null, crypto.randomUUID() + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

app.post('/upload-voice', upload.single('voice'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const fileUrl = `https://${req.get('host')}/uploads/${req.file.filename}`;
  res.json({ url: fileUrl });
});

app.post('/start-chat', (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || name.trim().length < 3) {
    return res.status(400).json({ error: 'Invalid name' });
  }
  const token = crypto.randomUUID();
  sessions.set(token, name.trim());
  res.json({ token });
});

const io = new Server(server, { cors: corsOptions });

io.on('connection', socket => {
  socket.emit('user_count', connectedUsers);

  socket.on('join', token => {
    const name = sessions.get(token);
    if (!name) {
      socket.emit('error', 'Invalid token');
      return; 
    }

    socket.userName = name;
    sessions.delete(token);

    if (!socket.counted) {
      socket.counted = true;
      connectedUsers++;
      io.emit('user_count', connectedUsers);
    }

    waitingUsers.push(socket);

    if (waitingUsers.length >= 2) {
      const user1 = waitingUsers.shift();
      const user2 = waitingUsers.shift();
      const room = `room-${crypto.randomUUID()}`;
      
      user1.join(room);
      user2.join(room);
      user1.room = room;
      user2.room = room;

      io.to(room).emit('connected');
    } else {
      socket.emit('waiting');
    }
  });

  // إرسال النص
  socket.on('sendMessage', msg => {
    if (socket.room && msg.text) {
      const chatMsg = {
        id: msg.id || crypto.randomUUID(),
        senderId: socket.id,       // <-- التعديل الأهم: الهوية الفريدة للمرسل
        senderName: socket.userName, 
        text: msg.text,
        time: new Date().toISOString(),
        reactions: {}
      };
      io.to(socket.room).emit('newMessage', chatMsg);
    }
  });

  // إرسال الصوت
  socket.on('sendVoice', data => {
    if (socket.room && data.url) {
      const chatMsg = {
        id: data.id || crypto.randomUUID(),
        senderId: socket.id,       // <-- التعديل الأهم
        senderName: socket.userName,
        url: data.url,
        duration: data.duration,
        time: new Date().toISOString(),
        reactions: {}
      };
      io.to(socket.room).emit('newVoice', chatMsg);
    }
  });

  // التفاعلات
  socket.on('react', data => {
    if (!socket.room || !data.messageId) return;
    io.to(socket.room).emit('newReaction', { 
      messageId: data.messageId, 
      reaction: data.reaction, 
      senderId: socket.id,      // <-- التعديل الأهم
      senderName: socket.userName 
    });
  });

  socket.on('typing', () => {
    if (socket.room) socket.to(socket.room).emit('typing');
  });

  socket.on('startRecording', () => {
    if (socket.room) socket.to(socket.room).emit('partnerRecording', true);
  });
  
  socket.on('stopRecording', () => {
    if (socket.room) socket.to(socket.room).emit('partnerRecording', false);
  });
  
  socket.on('pauseRecording', () => {
    if (socket.room) socket.to(socket.room).emit('partnerRecording', false); 
  });
  
  socket.on('resumeRecording', () => {
    if (socket.room) socket.to(socket.room).emit('partnerRecording', true);
  });

  socket.on('leave', () => handleDisconnect(socket));
  socket.on('disconnect', () => handleDisconnect(socket));
});

function handleDisconnect(socket) {
  const idx = waitingUsers.indexOf(socket);
  if (idx !== -1) waitingUsers.splice(idx, 1);

  if (socket.room) {
    socket.to(socket.room).emit('partner_left');
    socket.leave(socket.room);
    socket.room = null;
  }

  if (socket.counted) {
    connectedUsers--;
    socket.counted = false;
    io.emit('user_count', connectedUsers);
  }
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
