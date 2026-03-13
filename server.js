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
let waitingUser = null;        // for text chat
let waitingVideoUser = null;   // for video call
let connectedUsers = 0;
const messages = [];

const allowedOrigin = 'https://sayhello.up.railway.app';
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

// ── File Upload ──────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => cb(null, crypto.randomUUID() + '.webm')
});
const upload = multer({ storage });

const roomFiles = new Map();
const roomMessages = new Map();

app.post('/upload-voice', upload.single('voice'), (req, res) => {
  const room = req.body.room;
  if (!room) return res.status(400).json({ error: 'Room is required' });

  const filePath = path.join('uploads', req.file.filename);
  if (!roomFiles.has(room)) roomFiles.set(room, []);
  roomFiles.get(room).push(filePath);

  const fileUrl = `https://${req.get('host')}/uploads/${req.file.filename}`;
  res.json({ url: fileUrl });
});

function clearRoomFiles(room) {
  const files = roomFiles.get(room);
  if (files) {
    files.forEach(file => {
      fs.unlink(file, err => {
        if (err) console.error('Failed to delete file', file, err);
      });
    });
    roomFiles.delete(room);
  }
  if (roomMessages.has(room)) roomMessages.delete(room);
}

app.use('/uploads', express.static('uploads'));

// ── Session start ────────────────────────────────────────────────────────────
app.post('/start-chat', (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || name.trim().length < 3 || name.trim().length > 50) {
    return res.status(400).json({ error: 'Invalid name' });
  }
  const token = crypto.randomUUID();
  sessions.set(token, name.trim());
  res.json({ token });
});

// ── Socket.IO ────────────────────────────────────────────────────────────────
const io = new Server(server, { cors: corsOptions });

function decreaseUserCount(socket) {
  if (waitingUser && waitingUser.id === socket.id) waitingUser = null;
  if (waitingVideoUser && waitingVideoUser.id === socket.id) waitingVideoUser = null;

  if (socket.counted) {
    connectedUsers--;
    socket.counted = false;
    io.emit('user_count', connectedUsers);
  }
}

/**
 * Match two sockets into a room.
 * @param {object} s1
 * @param {object} s2
 */
function pairSockets(s1, s2) {
  const room = `room-${s1.id}-${s2.id}`;
  s1.join(room); s2.join(room);
  s1.room = room; s2.room = room;
  io.to(room).emit('connected');
}

io.on('connection', socket => {
  console.log('User connected:', socket.id);
  socket.emit('user_count', connectedUsers);

  // ── join (text chat OR video call) ──────────────────────────────────────
  socket.on('join', token => {
    const name = sessions.get(token);
    if (!name) { socket.emit('error', 'Invalid token'); return socket.disconnect(); }

    socket.userId = socket.id;
    socket.userName = name;
    sessions.delete(token);

    socket.counted = true;
    connectedUsers++;
    io.emit('user_count', connectedUsers);

    // Detect mode from name tag (optional) – default: text chat queue
    const isVideo = socket.isVideo || false;
    const queue = isVideo ? 'video' : 'text';
    socket.chatMode = queue;

    if (queue === 'video') {
      if (waitingVideoUser && waitingVideoUser.id !== socket.id) {
        pairSockets(socket, waitingVideoUser);
        waitingVideoUser = null;
      } else {
        waitingVideoUser = socket;
        socket.emit('waiting');
      }
    } else {
      if (waitingUser && waitingUser.id !== socket.id) {
        pairSockets(socket, waitingUser);
        waitingUser = null;
      } else {
        waitingUser = socket;
        socket.emit('waiting');
      }
    }
  });

  // ── join-video: dedicated event so client can explicitly choose video queue
  socket.on('join-video', token => {
    socket.isVideo = true;
    // re-use join logic by emitting internally
    const name = sessions.get(token);
    if (!name) { socket.emit('error', 'Invalid token'); return socket.disconnect(); }

    socket.userId = socket.id;
    socket.userName = name;
    sessions.delete(token);

    if (!socket.counted) {
      socket.counted = true;
      connectedUsers++;
      io.emit('user_count', connectedUsers);
    }

    socket.chatMode = 'video';

    if (waitingVideoUser && waitingVideoUser.id !== socket.id) {
      pairSockets(socket, waitingVideoUser);
      waitingVideoUser = null;
    } else {
      waitingVideoUser = socket;
      socket.emit('waiting');
    }
  });

  // ── Text chat events ────────────────────────────────────────────────────
  socket.on('sendMessage', msg => {
    if (!socket.room || !msg.id || !msg.text) return;
    const chatMsg = {
      id: msg.id, sender: socket.userName,
      text: msg.text, time: new Date().toISOString(), reactions: {}
    };
    messages.push(chatMsg);
    io.to(socket.room).emit('newMessage', chatMsg);
  });

  socket.on('sendVoice', data => {
    if (!socket.room || !data.id) return;
    const chatMsg = {
      id: data.id, sender: socket.userName,
      url: data.url, duration: data.duration,
      time: new Date().toISOString(), reactions: {}
    };
    messages.push(chatMsg);
    io.to(socket.room).emit('newVoice', chatMsg);
  });

  socket.on('react', data => {
    if (!socket.room || !data.messageId) return;
    const { messageId, reaction, sender } = data;
    const msg = messages.find(m => m.id === messageId);
    if (!msg) return;
    if (!msg.reactions[reaction]) msg.reactions[reaction] = [];
    const idx = msg.reactions[reaction].indexOf(sender);
    if (idx === -1) {
      msg.reactions[reaction].push(sender);
    } else {
      msg.reactions[reaction].splice(idx, 1);
      if (!msg.reactions[reaction].length) delete msg.reactions[reaction];
    }
    io.to(socket.room).emit('newReaction', { messageId, reactions: msg.reactions });
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

  // ── WebRTC signaling (video call) ────────────────────────────────────────
  socket.on('vc-offer', offer => {
    if (socket.room) socket.to(socket.room).emit('vc-offer', offer);
  });

  socket.on('vc-answer', answer => {
    if (socket.room) socket.to(socket.room).emit('vc-answer', answer);
  });

  socket.on('vc-ice', candidate => {
    if (socket.room) socket.to(socket.room).emit('vc-ice', candidate);
  });

  // ── Leave / Disconnect ───────────────────────────────────────────────────
  socket.on('leave', () => {
    if (socket.room) {
      const room = socket.room;
      socket.to(room).emit('partner_left');
      socket.leave(room);
      socket.room = null;
      const size = io.sockets.adapter.rooms.get(room)?.size || 0;
      if (size === 0) clearRoomFiles(room);
    }
    decreaseUserCount(socket);
  });

  socket.on('disconnect', () => {
    if (socket.room) {
      const room = socket.room;
      socket.to(room).emit('partner_left');
      const size = io.sockets.adapter.rooms.get(room)?.size || 0;
      if (size === 0) clearRoomFiles(room);
    }
    decreaseUserCount(socket);
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log('Server running on port', PORT));