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

app.use(express.json({ limit: '50mb' }));
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

app.get('/resources', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'resources.html'));
});

// --- Resources API ---
const RESOURCES_DIR = process.env.RAILWAY_ENVIRONMENT
  ? '/app/uploads/resources'
  : path.join(__dirname, 'uploads', 'resources');
const RESOURCES_META = path.join(RESOURCES_DIR, '_meta.json');

const DEFAULT_SUBJECTS = [
  { name: 'Biology', color: '#2D7D46' },
  { name: 'Chemistry', color: '#7B2D8B' },
  { name: 'Physics', color: '#C0392B' },
  { name: 'Maths', color: '#2C3E8B' },
  { name: 'English', color: '#B8860B' },
];
const EXAM_BOARDS = ['AQA', 'Edexcel', 'OCR', 'WJEC'];
const YEAR_GROUPS = ['KS2', 'KS3', 'GCSE Foundation', 'GCSE Higher', 'AS Level', 'A Level'];

function ensureResourcesStructure() {
  if (!fs.existsSync(RESOURCES_DIR)) fs.mkdirSync(RESOURCES_DIR, { recursive: true });
  if (!fs.existsSync(RESOURCES_META)) {
    // Build the default folder tree
    const tree = { id: 'root', name: 'Resources', children: [], files: [] };
    for (const subj of DEFAULT_SUBJECTS) {
      const subjNode = { id: subj.name.toLowerCase(), name: subj.name, color: subj.color, children: [], files: [] };
      for (const board of EXAM_BOARDS) {
        const boardNode = { id: `${subjNode.id}_${board.toLowerCase()}`, name: board, children: [], files: [] };
        for (const yg of YEAR_GROUPS) {
          boardNode.children.push({ id: `${boardNode.id}_${yg.toLowerCase().replace(/\s+/g, '-')}`, name: yg, children: [], files: [] });
        }
        subjNode.children.push(boardNode);
      }
      tree.children.push(subjNode);
    }
    fs.writeFileSync(RESOURCES_META, JSON.stringify(tree, null, 2));
  }
  return JSON.parse(fs.readFileSync(RESOURCES_META, 'utf-8'));
}

function saveResourcesMeta(tree) {
  fs.writeFileSync(RESOURCES_META, JSON.stringify(tree, null, 2));
}

function findNode(node, id) {
  if (node.id === id) return node;
  for (const child of (node.children || [])) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

function findParent(node, id) {
  for (const child of (node.children || [])) {
    if (child.id === id) return node;
    const found = findParent(child, id);
    if (found) return found;
  }
  return null;
}

function getNodePath(node, id, trail = []) {
  if (node.id === id) return [...trail, { id: node.id, name: node.name }];
  for (const child of (node.children || [])) {
    const result = getNodePath(child, id, [...trail, { id: node.id, name: node.name }]);
    if (result) return result;
  }
  return null;
}

function searchFiles(node, query, pathSoFar = '') {
  const results = [];
  const currentPath = pathSoFar ? `${pathSoFar} > ${node.name}` : node.name;
  for (const f of (node.files || [])) {
    if (f.name.toLowerCase().includes(query.toLowerCase())) {
      results.push({ ...f, folderPath: currentPath, folderId: node.id });
    }
  }
  for (const child of (node.children || [])) {
    results.push(...searchFiles(child, query, currentPath));
  }
  return results;
}

// Get folder tree
app.get('/api/resources/tree', (_req, res) => {
  res.json(ensureResourcesStructure());
});

// Get folder contents
app.get('/api/resources/folder/:id', (req, res) => {
  const tree = ensureResourcesStructure();
  const node = findNode(tree, req.params.id);
  if (!node) return res.status(404).json({ error: 'Folder not found' });
  const breadcrumb = getNodePath(tree, req.params.id) || [];
  res.json({ ...node, breadcrumb });
});

// Create sub-folder
app.post('/api/resources/folder/:parentId', (req, res) => {
  const tree = ensureResourcesStructure();
  const parent = findNode(tree, req.params.parentId);
  if (!parent) return res.status(404).json({ error: 'Parent not found' });
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const id = `${parent.id}_${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}_${Date.now()}`;
  const newFolder = { id, name, children: [], files: [] };
  parent.children.push(newFolder);
  saveResourcesMeta(tree);
  res.json(newFolder);
});

// Rename folder
app.patch('/api/resources/folder/:id', (req, res) => {
  const tree = ensureResourcesStructure();
  const node = findNode(tree, req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  node.name = (req.body.name || node.name).trim();
  saveResourcesMeta(tree);
  res.json({ ok: true });
});

// Delete folder
app.delete('/api/resources/folder/:id', (req, res) => {
  const tree = ensureResourcesStructure();
  const parent = findParent(tree, req.params.id);
  if (!parent) return res.status(404).json({ error: 'Not found' });
  parent.children = parent.children.filter(c => c.id !== req.params.id);
  saveResourcesMeta(tree);
  // Also delete folder files from disk
  const dirPath = path.join(RESOURCES_DIR, req.params.id);
  if (fs.existsSync(dirPath)) fs.rmSync(dirPath, { recursive: true, force: true });
  res.json({ ok: true });
});

// Upload resource file
const resourceStorage = multer.diskStorage({
  destination(req, _file, cb) {
    const dir = path.join(RESOURCES_DIR, req.params.folderId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(_req, file, cb) { cb(null, file.originalname); },
});
const resourceUpload = multer({
  storage: resourceStorage,
  fileFilter(_req, file, cb) {
    const allowed = ['application/pdf', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/png', 'image/jpeg'];
    cb(null, allowed.includes(file.mimetype));
  },
});

app.post('/api/resources/upload/:folderId', resourceUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const tree = ensureResourcesStructure();
  const node = findNode(tree, req.params.folderId);
  if (!node) return res.status(404).json({ error: 'Folder not found' });
  const fileEntry = {
    name: req.file.originalname,
    size: req.file.size,
    type: req.file.mimetype,
    uploaded: new Date().toISOString(),
    diskPath: `${req.params.folderId}/${req.file.originalname}`,
  };
  // Remove duplicate if re-uploading same name
  node.files = (node.files || []).filter(f => f.name !== fileEntry.name);
  node.files.push(fileEntry);
  saveResourcesMeta(tree);
  res.json(fileEntry);
});

// Download/serve resource file
app.get('/api/resources/file/:folderId/:filename', (req, res) => {
  const filePath = path.join(RESOURCES_DIR, req.params.folderId, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(filePath);
});

// Delete resource file
app.delete('/api/resources/file/:folderId/:filename', (req, res) => {
  const tree = ensureResourcesStructure();
  const node = findNode(tree, req.params.folderId);
  if (node) {
    node.files = (node.files || []).filter(f => f.name !== req.params.filename);
    saveResourcesMeta(tree);
  }
  const filePath = path.join(RESOURCES_DIR, req.params.folderId, req.params.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  res.json({ ok: true });
});

// Search
app.get('/api/resources/search', (req, res) => {
  const q = req.query.q || '';
  if (q.length < 2) return res.json([]);
  const tree = ensureResourcesStructure();
  res.json(searchFiles(tree, q));
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

// --- Bulk annotation save/load (all pages for a PDF) ---
// Save all page data for a student's PDF
app.post('/api/annotations/:student/:pdf', (req, res) => {
  const student = req.params.student.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const pdf = req.params.pdf;
  const dir = path.join(UPLOADS_DIR, student);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const annoFile = path.join(dir, `${pdf.replace('.pdf', '')}_annotations.json`);
  fs.writeFileSync(annoFile, JSON.stringify(req.body));
  res.json({ ok: true });
});

// Load all page data for a student's PDF
app.get('/api/annotations/:student/:pdf', (req, res) => {
  const student = req.params.student.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const pdf = req.params.pdf;
  const annoFile = path.join(UPLOADS_DIR, student, `${pdf.replace('.pdf', '')}_annotations.json`);
  if (!fs.existsSync(annoFile)) return res.json(null);
  try {
    const data = JSON.parse(fs.readFileSync(annoFile, 'utf-8'));
    res.json(data);
  } catch {
    res.json(null);
  }
});

// --- PDF Export with annotations ---
app.post('/api/export/:student/:pdf', async (req, res) => {
  const { PDFDocument } = require('pdf-lib');
  const student = req.params.student.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const pdf = req.params.pdf;
  const pdfPath = path.join(UPLOADS_DIR, student, pdf);

  if (!fs.existsSync(pdfPath)) return res.status(404).json({ error: 'PDF not found' });

  try {
    const existingPdfBytes = fs.readFileSync(pdfPath);
    const pdfDoc = await PDFDocument.load(existingPdfBytes);
    const pageImages = req.body.pageImages || []; // [{pageIndex, dataUrl}]

    for (const pi of pageImages) {
      let page;
      if (pi.pageIndex < pdfDoc.getPageCount()) {
        page = pdfDoc.getPage(pi.pageIndex);
      } else {
        // Extra blank page added during session
        page = pdfDoc.addPage();
      }

      if (pi.dataUrl) {
        const pngData = pi.dataUrl.replace(/^data:image\/png;base64,/, '');
        const pngImage = await pdfDoc.embedPng(Buffer.from(pngData, 'base64'));
        const { width, height } = page.getSize();
        page.drawImage(pngImage, { x: 0, y: 0, width, height });
      }
    }

    const pdfBytes = await pdfDoc.save();
    const exportName = `${student}_${pdf.replace('.pdf', '')}_annotated.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${exportName}"`);
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error('PDF export error:', err);
    res.status(500).json({ error: 'Export failed' });
  }
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

      case 'wb-page-delete': {
        const delId = msg.pageId;
        if (pageOrder.length <= 1) break; // cannot delete last page
        delete pages[delId];
        const delIdx = pageOrder.indexOf(delId);
        if (delIdx !== -1) pageOrder.splice(delIdx, 1);
        activePageId = msg.newActivePageId || pageOrder[0];
        broadcast({ type: 'wb-page-delete', pageId: delId, newActivePageId: activePageId, pageOrder }, 'teacher');
        break;
      }

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
        if (msg.image) { strokeData.image = msg.image; strokeData.w = msg.w; strokeData.h = msg.h; }
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
