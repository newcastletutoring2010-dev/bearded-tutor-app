const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// --- Multer setup for PDF uploads ---
const storage = multer.diskStorage({
  destination(req, _file, cb) {
    const student = req.params.student.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const dir = path.join(UPLOADS_DIR, student);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(_req, file, cb) {
    cb(null, file.originalname);
  },
});
const upload = multer({
  storage,
  fileFilter(_req, file, cb) {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are allowed'));
  },
});

// --- Page routes ---
app.get('/teach', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'teach.html'));
});

app.get('/student', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'student.html'));
});

app.get('/library', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'library.html'));
});

// --- Library API ---
// List all students
app.get('/api/students', (_req, res) => {
  if (!fs.existsSync(UPLOADS_DIR)) return res.json([]);
  const entries = fs.readdirSync(UPLOADS_DIR, { withFileTypes: true });
  const students = entries.filter(e => e.isDirectory()).map(e => e.name).sort();
  res.json(students);
});

// Create student folder
app.post('/api/students/:student', (req, res) => {
  const student = req.params.student.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!student) return res.status(400).json({ error: 'Invalid student name' });
  const dir = path.join(UPLOADS_DIR, student);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  res.json({ ok: true, student });
});

// List PDFs for a student
app.get('/api/students/:student/pdfs', (req, res) => {
  const student = req.params.student.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const dir = path.join(UPLOADS_DIR, student);
  if (!fs.existsSync(dir)) return res.json([]);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.pdf'));
  res.json(files);
});

// Upload PDF for a student
app.post('/api/students/:student/upload', upload.single('pdf'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ ok: true, filename: req.file.originalname });
});

// Delete a PDF
app.delete('/api/students/:student/pdfs/:filename', (req, res) => {
  const student = req.params.student.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const filename = req.params.filename;
  const filePath = path.join(UPLOADS_DIR, student, filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  // Also remove annotations for this PDF
  const annoDir = path.join(UPLOADS_DIR, student);
  const annoPrefix = filename.replace('.pdf', '') + '_annotations_page_';
  if (fs.existsSync(annoDir)) {
    fs.readdirSync(annoDir)
      .filter(f => f.startsWith(annoPrefix))
      .forEach(f => fs.unlinkSync(path.join(annoDir, f)));
  }
  res.json({ ok: true });
});

// --- Annotation API ---
// Save annotations for a student/pdf/page
app.post('/api/annotations/:student/:pdf/:page', (req, res) => {
  const student = req.params.student.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const pdf = req.params.pdf;
  const page = parseInt(req.params.page, 10);
  const dir = path.join(UPLOADS_DIR, student);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const annoFile = path.join(dir, `${pdf.replace('.pdf', '')}_annotations_page_${page}.json`);
  fs.writeFileSync(annoFile, JSON.stringify(req.body));
  res.json({ ok: true });
});

// Load annotations for a student/pdf/page
app.get('/api/annotations/:student/:pdf/:page', (req, res) => {
  const student = req.params.student.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const pdf = req.params.pdf;
  const page = parseInt(req.params.page, 10);
  const annoFile = path.join(UPLOADS_DIR, student, `${pdf.replace('.pdf', '')}_annotations_page_${page}.json`);
  if (!fs.existsSync(annoFile)) return res.json({ strokes: [] });
  try {
    const data = JSON.parse(fs.readFileSync(annoFile, 'utf-8'));
    res.json(data);
  } catch {
    res.json({ strokes: [] });
  }
});

// Clear annotations for a student/pdf/page
app.delete('/api/annotations/:student/:pdf/:page', (req, res) => {
  const student = req.params.student.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const pdf = req.params.pdf;
  const page = parseInt(req.params.page, 10);
  const annoFile = path.join(UPLOADS_DIR, student, `${pdf.replace('.pdf', '')}_annotations_page_${page}.json`);
  if (fs.existsSync(annoFile)) fs.unlinkSync(annoFile);
  res.json({ ok: true });
});

// --- Whiteboard State ---
let strokes = [];
let revealedImage = '';
let paused = false;

// --- PDF State (shared between teacher/students) ---
let currentPdf = { student: null, filename: null, page: 1, totalPages: 0 };

// --- Viewport State ---
let currentViewport = { zoom: 1, panX: 0, panY: 0 };

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
          ws.send(JSON.stringify({
            type: 'init',
            revealedImage,
            paused,
            currentPdf,
            currentViewport,
          }));
        }
        break;

      case 'stroke':
        strokes.push({ points: msg.points, color: msg.color, size: msg.size });
        if (!paused) {
          broadcast({ type: 'stroke', points: msg.points, color: msg.color, size: msg.size }, 'teacher');
        }
        break;

      case 'undo':
        strokes.pop();
        if (!paused) {
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
        broadcast({
          type: 'reveal',
          strokes,
          snapshot: msg.snapshot,
        }, 'teacher');
        break;

      // --- PDF events ---
      case 'pdf-load':
        currentPdf = {
          student: msg.student,
          filename: msg.filename,
          page: msg.page || 1,
          totalPages: msg.totalPages || 0,
        };
        strokes = [];
        broadcast({
          type: 'pdf-load',
          student: msg.student,
          filename: msg.filename,
          page: msg.page || 1,
          totalPages: msg.totalPages || 0,
        }, 'teacher');
        break;

      case 'pdf-page':
        currentPdf.page = msg.page;
        strokes = [];
        broadcast({
          type: 'pdf-page',
          page: msg.page,
        }, 'teacher');
        break;

      case 'viewport':
        currentViewport = { zoom: msg.zoom, panX: msg.panX, panY: msg.panY };
        if (!paused) {
          broadcast({ type: 'viewport', zoom: msg.zoom, panX: msg.panX, panY: msg.panY }, 'teacher');
        }
        break;

      case 'pdf-unload':
        currentPdf = { student: null, filename: null, page: 1, totalPages: 0 };
        strokes = [];
        broadcast({ type: 'pdf-unload' }, 'teacher');
        break;
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`  Teacher: http://localhost:${PORT}/teach`);
  console.log(`  Student: http://localhost:${PORT}/student`);
  console.log(`  Library: http://localhost:${PORT}/library`);
});
