const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

app.get('/teach', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'teach.html'));
});

app.get('/student', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'student.html'));
});

// State
let strokes = [];      // Full stroke history (each stroke is an array of points)
let revealedImage = ''; // Last revealed snapshot as data URL
let paused = false;

function broadcast(data, senderRole) {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === 1 && client._role !== senderRole) {
      client.send(msg);
    }
  }
}

function broadcastToAll(data) {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  }
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'register':
        ws._role = msg.role;
        if (msg.role === 'student') {
          // Send current state to newly connected student
          ws.send(JSON.stringify({
            type: 'init',
            revealedImage,
            paused,
          }));
        }
        break;

      case 'stroke':
        // Teacher is drawing — store and forward if not paused
        strokes.push(msg.points);
        if (!paused) {
          broadcast({ type: 'stroke', points: msg.points }, 'teacher');
        }
        break;

      case 'undo':
        strokes.pop();
        if (!paused) {
          // Send full redraw to students
          broadcast({ type: 'full-redraw', strokes }, 'teacher');
        }
        break;

      case 'clear':
        strokes = [];
        if (!paused) {
          broadcast({ type: 'clear' }, 'teacher');
        }
        break;

      case 'pause':
        paused = true;
        // Capture snapshot for late-joining students
        if (msg.snapshot) {
          revealedImage = msg.snapshot;
        }
        broadcastToAll({ type: 'paused' });
        break;

      case 'reveal':
        paused = false;
        if (msg.snapshot) {
          revealedImage = msg.snapshot;
        }
        // Send current canvas state to all students
        broadcast({
          type: 'reveal',
          strokes,
          snapshot: msg.snapshot,
        }, 'teacher');
        break;
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`  Teacher: http://localhost:${PORT}/teach`);
  console.log(`  Student: http://localhost:${PORT}/student`);
});
