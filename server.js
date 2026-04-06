const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const UPLOADS_DIR = process.env.RAILWAY_ENVIRONMENT
  ? '/app/uploads'
  : path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

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

// --- Multi-Page Whiteboard State ---
const pages = { wb_1: { strokes: [], type: 'blank' } };
let pageOrder = ['wb_1'];
let activePageId = 'wb_1';
let nextPageNum = 2;

function getPageStrokes(pageId) {
  if (!pages[pageId]) pages[pageId] = { strokes: [], type: 'blank' };
  return pages[pageId].strokes;
}

let revealedImage = '';
let paused = false;

// --- PDF State (shared between teacher/students) ---
let currentPdf = { student: null, filename: null, page: 1, totalPages: 0 };

// --- Viewport State ---
let currentViewport = { zoom: 1, panX: 0, panY: 0 };

// --- Split View State ---
let splitView = false;
let splitLeftPageId = 'wb_1';
let splitRightPageId = null;

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
        ws.send(JSON.stringify({
          type: 'init',
          pages,
          pageOrder,
          activePageId,
          revealedImage,
          paused,
          currentPdf,
          currentViewport,
          splitView,
          splitLeftPageId,
          splitRightPageId,
        }));
        break;

      // --- Multi-page navigation ---
      case 'wb-page-add': {
        const newId = msg.pageId || ('wb_' + nextPageNum++);
        if (!pages[newId]) pages[newId] = { strokes: [], type: msg.pageType || 'blank' };
        if (!pageOrder.includes(newId)) {
          const afterIdx = msg.afterPageId ? pageOrder.indexOf(msg.afterPageId) : pageOrder.length - 1;
          pageOrder.splice(afterIdx + 1, 0, newId);
        }
        activePageId = newId;
        broadcast({ type: 'wb-page-add', pageId: newId, pageType: msg.pageType || 'blank', pageOrder, activePageId }, 'teacher');
        break;
      }

      case 'wb-page-change':
        activePageId = msg.pageId;
        broadcast({ type: 'wb-page-change', pageId: msg.pageId }, 'teacher');
        break;

      // --- Split view ---
      case 'wb-split-toggle':
        splitView = msg.enabled;
        splitLeftPageId = msg.leftPageId;
        splitRightPageId = msg.rightPageId;
        broadcast({ type: 'wb-split-toggle', enabled: msg.enabled, leftPageId: msg.leftPageId, rightPageId: msg.rightPageId }, 'teacher');
        break;

      case 'wb-split-change':
        if (msg.panel === 'left') splitLeftPageId = msg.pageId;
        if (msg.panel === 'right') splitRightPageId = msg.pageId;
        broadcast({ type: 'wb-split-change', panel: msg.panel, pageId: msg.pageId }, 'teacher');
        break;

      // --- Per-page stroke operations (all carry pageId) ---
      case 'stroke': {
        const pid = msg.pageId || activePageId;
        const s = getPageStrokes(pid);
        const strokeData = { points: msg.points, color: msg.color, size: msg.size };
        if (msg.text) strokeData.text = msg.text;
        s.push(strokeData);
        if (!paused) {
          broadcast({ type: 'stroke', pageId: pid, ...strokeData }, 'teacher');
        }
        break;
      }

      case 'undo': {
        const pid = msg.pageId || activePageId;
        const s = getPageStrokes(pid);
        s.pop();
        if (!paused) {
          broadcast({ type: 'full-redraw', pageId: pid, strokes: s }, 'teacher');
        }
        break;
      }

      case 'clear': {
        const pid = msg.pageId || activePageId;
        if (pages[pid]) pages[pid].strokes = [];
        if (!paused) {
          broadcast({ type: 'clear', pageId: pid }, 'teacher');
        }
        break;
      }

      case 'erase': {
        const pid = msg.pageId || activePageId;
        if (pages[pid]) pages[pid].strokes = msg.strokes || [];
        if (!paused) {
          broadcast({ type: 'full-redraw', pageId: pid, strokes: msg.strokes || [] }, 'teacher');
        }
        break;
      }

      case 'history-sync': {
        const pid = msg.pageId || activePageId;
        if (pages[pid]) pages[pid].strokes = msg.strokes || [];
        if (!paused) {
          broadcast({ type: 'full-redraw', pageId: pid, strokes: msg.strokes || [] }, 'teacher');
        }
        break;
      }

      case 'pause':
        paused = true;
        if (msg.snapshot) revealedImage = msg.snapshot;
        broadcastToAll({ type: 'paused' });
        break;

      case 'reveal':
        paused = false;
        if (msg.snapshot) revealedImage = msg.snapshot;
        broadcast({
          type: 'reveal',
          pageId: activePageId,
          strokes: getPageStrokes(activePageId),
          snapshot: msg.snapshot,
        }, 'teacher');
        break;

      // --- PDF events ---
      case 'pdf-load': {
        currentPdf = {
          student: msg.student,
          filename: msg.filename,
          page: msg.page || 1,
          totalPages: msg.totalPages || 0,
        };
        // Create page entries for each PDF page
        const pdfPages = [];
        for (let i = 1; i <= (msg.totalPages || 1); i++) {
          const pid = `pdf_${msg.student}_${msg.filename}_${i}`;
          if (!pages[pid]) pages[pid] = { strokes: [], type: 'pdf', pdfPage: i };
          if (!pageOrder.includes(pid)) pdfPages.push(pid);
        }
        if (pdfPages.length > 0) pageOrder.push(...pdfPages);
        activePageId = `pdf_${msg.student}_${msg.filename}_${msg.page || 1}`;
        broadcast({
          type: 'pdf-load',
          student: msg.student,
          filename: msg.filename,
          page: msg.page || 1,
          totalPages: msg.totalPages || 0,
          pageOrder,
          activePageId,
        }, 'teacher');
        break;
      }

      case 'pdf-page':
        currentPdf.page = msg.page;
        if (currentPdf.student && currentPdf.filename) {
          activePageId = `pdf_${currentPdf.student}_${currentPdf.filename}_${msg.page}`;
        }
        broadcast({ type: 'pdf-page', page: msg.page, activePageId }, 'teacher');
        break;

      case 'viewport':
        currentViewport = { zoom: msg.zoom, panX: msg.panX, panY: msg.panY };
        if (!paused) {
          broadcast({ type: 'viewport', zoom: msg.zoom, panX: msg.panX, panY: msg.panY }, 'teacher');
        }
        break;

      case 'pdf-unload':
        currentPdf = { student: null, filename: null, page: 1, totalPages: 0 };
        // Revert to first whiteboard page
        activePageId = pageOrder.find(id => id.startsWith('wb_')) || 'wb_1';
        broadcast({ type: 'pdf-unload', activePageId }, 'teacher');
        break;

      // --- Smart calculator via Gemini ---
      case 'calculate_math':
        (async () => {
          try {
            console.log('[calc] Server received calculate_math');
            const apiKey = process.env.GEMINI_API_KEY;
            if (!apiKey) throw new Error('GEMINI_API_KEY not set');

            const genAI = new GoogleGenerativeAI(apiKey);
            const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite-preview' });

            console.log(`[calc] Received image: ${Math.round(msg.image.length / 1024)}KB base64`);
            console.log('[calc] Calling Gemini API...');

            const result = await model.generateContent([
              {
                inlineData: {
                  mimeType: 'image/png',
                  data: msg.image,
                },
              },
              'You must respond with ONLY a raw JSON object, no markdown, no code blocks, no explanation. Example response: {"equation":"4x4","answer":"16"}\nNow read this handwritten equation and respond:',
            ]);

            const rawText = result.response.text();
            console.log(`[calc] Raw Gemini response: "${rawText}"`);

            // --- Robust JSON extraction ---
            // 1. Strip markdown code fences if present
            let text = rawText.trim()
              .replace(/^```(?:json)?\s*/i, '')
              .replace(/\s*```\s*$/i, '')
              .trim();

            // 2. Extract first { ... last }
            const firstBrace = text.indexOf('{');
            const lastBrace = text.lastIndexOf('}');
            let parsed = null;

            if (firstBrace !== -1 && lastBrace > firstBrace) {
              const jsonStr = text.slice(firstBrace, lastBrace + 1);
              try {
                parsed = JSON.parse(jsonStr);
              } catch (parseErr) {
                console.error(`[calc] JSON.parse failed on: "${jsonStr}"`, parseErr.message);
              }
            }

            // 3. Regex fallback: try to extract equation and answer from free text
            if (!parsed) {
              console.log('[calc] Attempting regex fallback extraction...');
              const eqMatch = text.match(/equation["\s:]+([^"}\n]+)/i);
              const ansMatch = text.match(/answer["\s:]+([^"}\n]+)/i);
              if (eqMatch && ansMatch) {
                parsed = { equation: eqMatch[1].trim().replace(/[",]/g, ''), answer: ansMatch[1].trim().replace(/[",]/g, '') };
                console.log(`[calc] Regex fallback extracted: ${JSON.stringify(parsed)}`);
              }
            }

            if (!parsed || !parsed.answer) {
              console.error(`[calc] Could not parse math from response: "${text}"`);
              throw new Error('Could not parse math');
            }

            ws.send(JSON.stringify({
              type: 'calculate_result',
              equation: parsed.equation,
              answer: String(parsed.answer),
              x: msg.x,
              y: msg.y,
            }));
          } catch (err) {
            console.error('[calc] Gemini error:', err.message, err.stack);
            ws.send(JSON.stringify({
              type: 'calculate_error',
              error: err.message,
            }));
          }
        })();
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
