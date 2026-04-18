const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const SNAPSHOT_PATH = process.env.SNAPSHOT_PATH || path.join(__dirname, 'sessions-snapshot.json');
const SNAPSHOT_INTERVAL_MS = 5000;
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_PARTICIPANTS = 200;

// ============================================================================
// VRAGEN — pas hier je lijst aan
// ============================================================================
const questions = [
  { id: 1,  text: "Een chatbot op basis van geselecteerde bronnen die vragen van studenten tijdens de les behandelt, zodat enkel de moeilijkste vragen nog aan de docent gesteld worden." },
  { id: 2,  text: "Een Socratische bot die aan het begin van de les vragen stelt aan studenten over de vorige les." },
  { id: 3,  text: "Een bot die zich gedraagt als een student en die studenten begrippen uit de cursus moeten aanleren." },
  { id: 4,  text: "Een chatbot die oefenexamenvragen aanbiedt met inhoudelijke feedback op basis van het cursusmateriaal." },
  { id: 5,  text: "Een chatbot gevuld met het cursusmateriaal plus alle academische artikels uit de syllabus, waarin studenten vrij elk concept kunnen bevragen tijdens en na de les." },
  { id: 6,  text: "Een rollenspel-bot die de rol speelt van een patiënt, cliënt of getuige waarmee studenten gesprekstechnieken oefenen." },
  { id: 7,  text: "Een debat-tegenstander die een specifieke filosofische of ethische positie inneemt, waartegen studenten moeten argumenteren." },
  { id: 8,  text: "Een chatbot voor eigen gebruik door de docent, doorzoekbaar in diens vakliteratuur en collegenotities om passages en citaten op te sporen bij het opstellen van examenvragen." },
  { id: 9,  text: "Een bot die een eerste feedbackronde genereert op thesisdrafts, die studenten zelf inzetten vóór indiening bij de promotor." },
  { id: 10, text: "Een AI-helpdesk die studenten antwoord geeft op vragen over stagereglement, ECTS-afspraken en examenregeling." },
  { id: 11, text: "Een rubric-nakijker die open examenvragen automatisch scoort volgens een vastgelegde rubric, waarmee de docent zijn eigen score vergelijkt." },
  { id: 12, text: "Een via NotebookLM gegenereerde podcast op basis van cursusmateriaal en slides, als preteaching beschikbaar voor studenten." },
  { id: 13, text: "Een bot die per hoofdstuk van de cursus samenvattingen en studiekaarten genereert en aan alle studenten ter beschikking stelt." },
  { id: 14, text: "Een vertaalbot die alle colleges live ondertitelt voor anderstalige en slechthorende studenten en de transcriptie nadien beschikbaar maakt." }
];

// ============================================================================
// STATE
// ============================================================================
// Session: { code, createdAt, lastActivity, adminToken, activeQuestionId, blindMode,
//   participants: Map<userId, { name, color, connected }>,
//   questions: Map<questionId, { id, text, status, launchedAt, positions: Map<userId, {x,y,timestamp}> }>
// }
const sessions = new Map();

function generateSessionCode() {
  let code;
  let tries = 0;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
    tries++;
    if (tries > 100) throw new Error('Kan geen unieke sessiecode genereren');
  } while (sessions.has(code));
  return code;
}

function hslForUserId(userId) {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash + userId.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  const sat = 60 + (Math.abs(hash >> 8) % 25);
  const light = 42 + (Math.abs(hash >> 16) % 12);
  return `hsl(${hue}, ${sat}%, ${light}%)`;
}

function makeQuestionsState() {
  return new Map(questions.map(q => [q.id, {
    id: q.id,
    text: q.text,
    status: 'pending',
    launchedAt: null,
    positions: new Map()
  }]));
}

function createSession() {
  const code = generateSessionCode();
  const now = Date.now();
  const session = {
    code,
    createdAt: now,
    lastActivity: now,
    adminToken: crypto.randomUUID(),
    activeQuestionId: null,
    blindMode: false,
    participants: new Map(),
    questions: makeQuestionsState()
  };
  sessions.set(code, session);
  return session;
}

function touchSession(s) { s.lastActivity = Date.now(); }

function cleanupSessions() {
  const now = Date.now();
  for (const [code, s] of sessions) {
    if (now - s.lastActivity > SESSION_TTL_MS) sessions.delete(code);
  }
}
setInterval(cleanupSessions, 60_000);

// ============================================================================
// Snapshot persistence (elke 5s)
// ============================================================================
function serializeSessions() {
  return Array.from(sessions.values()).map(s => ({
    code: s.code,
    createdAt: s.createdAt,
    lastActivity: s.lastActivity,
    adminToken: s.adminToken,
    activeQuestionId: s.activeQuestionId,
    blindMode: s.blindMode,
    participants: Array.from(s.participants.entries()).map(([id, p]) => ({
      id, name: p.name, color: p.color
    })),
    questions: Array.from(s.questions.values()).map(q => ({
      id: q.id, text: q.text, status: q.status, launchedAt: q.launchedAt,
      positions: Array.from(q.positions.entries()).map(([uid, pos]) => ({
        userId: uid, x: pos.x, y: pos.y, timestamp: pos.timestamp
      }))
    }))
  }));
}

function restoreSessions() {
  if (!fs.existsSync(SNAPSHOT_PATH)) return;
  try {
    const data = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
    for (const s of data) {
      const participants = new Map(s.participants.map(p => [
        p.id, { name: p.name, color: p.color, connected: false }
      ]));
      const questionsMap = new Map();
      for (const cfg of questions) {
        questionsMap.set(cfg.id, { id: cfg.id, text: cfg.text, status: 'pending', launchedAt: null, positions: new Map() });
      }
      for (const q of s.questions) {
        if (!questionsMap.has(q.id)) continue;
        const restored = questionsMap.get(q.id);
        restored.status = q.status;
        restored.launchedAt = q.launchedAt;
        restored.positions = new Map(q.positions.map(p => [p.userId, { x: p.x, y: p.y, timestamp: p.timestamp }]));
      }
      sessions.set(s.code, {
        code: s.code,
        createdAt: s.createdAt,
        lastActivity: s.lastActivity,
        adminToken: s.adminToken,
        activeQuestionId: s.activeQuestionId,
        blindMode: !!s.blindMode,
        participants,
        questions: questionsMap
      });
    }
    console.log(`[snapshot] Restored ${sessions.size} sessies`);
  } catch (e) {
    console.error('[snapshot] restore faalde:', e.message);
  }
}

let snapshotDirty = false;
function markDirty() { snapshotDirty = true; }
function saveSnapshot() {
  if (!snapshotDirty) return;
  try {
    const tmp = SNAPSHOT_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(serializeSessions()), 'utf8');
    fs.renameSync(tmp, SNAPSHOT_PATH);
    snapshotDirty = false;
  } catch (e) {
    console.error('[snapshot] save faalde:', e.message);
  }
}
setInterval(saveSnapshot, SNAPSHOT_INTERVAL_MS);

restoreSessions();

// ============================================================================
// Serialisatie voor clients
// ============================================================================
function serializeQuestionForClient(q, includePending) {
  if (!includePending && q.status === 'pending') return null;
  return {
    id: q.id,
    text: q.text,
    status: q.status,
    launchedAt: q.launchedAt,
    responseCount: q.positions.size,
    positions: Array.from(q.positions.entries()).map(([uid, pos]) => ({
      userId: uid, x: pos.x, y: pos.y, timestamp: pos.timestamp
    }))
  };
}

function buildSessionState(session) {
  // voor deelnemers: enkel gelanceerde vragen (active + closed)
  return {
    code: session.code,
    activeQuestionId: session.activeQuestionId,
    blindMode: session.blindMode,
    participants: Array.from(session.participants.entries()).map(([id, p]) => ({
      id, name: p.name, color: p.color, connected: p.connected
    })),
    questions: Array.from(session.questions.values())
      .map(q => serializeQuestionForClient(q, false))
      .filter(Boolean)
  };
}

function buildAdminState(session) {
  return {
    code: session.code,
    adminToken: session.adminToken,
    activeQuestionId: session.activeQuestionId,
    blindMode: session.blindMode,
    participants: Array.from(session.participants.entries()).map(([id, p]) => ({
      id, name: p.name, color: p.color, connected: p.connected
    })),
    questions: Array.from(session.questions.values())
      .map(q => serializeQuestionForClient(q, true))
  };
}

// ============================================================================
// HTTP
// ============================================================================
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/api/session/:code/exists', (req, res) => {
  res.json({ exists: sessions.has(String(req.params.code)) });
});

// QR code generator (SVG). Gebruik: /api/qr?text=...&size=320
app.get('/api/qr', async (req, res) => {
  const text = String(req.query.text || '').slice(0, 512);
  if (!text) return res.status(400).send('text param required');
  const size = Math.max(32, Math.min(1200, Number(req.query.size) || 320));
  try {
    const svg = await QRCode.toString(text, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
      width: size,
      color: { dark: '#111', light: '#ffffff' }
    });
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(svg);
  } catch (e) {
    res.status(500).send('QR generation failed: ' + e.message);
  }
});

app.get('/api/session/:code/export.csv', (req, res) => {
  const session = sessions.get(String(req.params.code));
  if (!session) return res.status(404).send('Session not found');
  const token = req.query.adminToken;
  if (token !== session.adminToken) return res.status(403).send('Forbidden');

  const esc = v => {
    const s = String(v ?? '');
    if (s.includes('"') || s.includes(',') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  // X-as = Risico (Hoog links=0, Laag rechts=100) → risico_pct = 100 - x
  // Y-as = Pedagogische meerwaarde (Laag=0, Hoog=100) → meerwaarde_pct = y
  const rows = [['userId','name','questionId','questionText','risico_0laag_100hoog','meerwaarde_0laag_100hoog','x_plot','y_plot','timestamp']];
  for (const q of session.questions.values()) {
    for (const [uid, pos] of q.positions.entries()) {
      const p = session.participants.get(uid);
      const risico = 100 - pos.x;
      const meerwaarde = pos.y;
      rows.push([
        uid,
        p ? p.name : '',
        q.id,
        q.text,
        risico.toFixed(2),
        meerwaarde.toFixed(2),
        pos.x.toFixed(2),
        pos.y.toFixed(2),
        new Date(pos.timestamp).toISOString()
      ].map(esc));
    }
  }
  const csv = '\uFEFF' + rows.map(r => r.join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="kwadrantenpoll-${session.code}.csv"`);
  res.send(csv);
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ============================================================================
// Socket.IO
// ============================================================================
io.on('connection', (socket) => {
  let currentCode = null;
  let currentUserId = null;
  let isAdmin = false;

  function getSession() {
    return currentCode ? sessions.get(currentCode) : null;
  }

  function requireAdmin() {
    if (!isAdmin) return null;
    return getSession();
  }

  // ----- Admin: nieuwe sessie aanmaken -----
  socket.on('admin-create-session', (_arg, cb) => {
    try {
      const session = createSession();
      currentCode = session.code;
      isAdmin = true;
      socket.join(`session:${session.code}`);
      socket.join(`admin:${session.code}`);
      markDirty();
      cb?.({ ok: true, state: buildAdminState(session) });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  // ----- Admin: reconnect met token -----
  socket.on('admin-reconnect', ({ code, adminToken } = {}, cb) => {
    const session = sessions.get(String(code || ''));
    if (!session || session.adminToken !== adminToken) {
      return cb?.({ ok: false, error: 'INVALID_ADMIN' });
    }
    currentCode = session.code;
    isAdmin = true;
    socket.join(`session:${session.code}`);
    socket.join(`admin:${session.code}`);
    touchSession(session);
    cb?.({ ok: true, state: buildAdminState(session) });
  });

  // ----- Deelnemer: join -----
  socket.on('join-session', ({ code, name, userId } = {}, cb) => {
    const normCode = String(code || '').trim();
    if (!/^\d{4}$/.test(normCode)) return cb?.({ ok: false, error: 'INVALID_CODE' });
    const session = sessions.get(normCode);
    if (!session) return cb?.({ ok: false, error: 'SESSION_NOT_FOUND' });

    const cleanName = String(name || '').replace(/[\u0000-\u001F]/g, '').trim().slice(0, 30);
    if (!cleanName) return cb?.({ ok: false, error: 'INVALID_NAME' });

    let uid = typeof userId === 'string' && userId.length >= 8 ? userId : crypto.randomUUID();

    const existing = session.participants.get(uid);
    if (!existing && session.participants.size >= MAX_PARTICIPANTS) {
      return cb?.({ ok: false, error: 'SESSION_FULL' });
    }

    let participant;
    if (existing) {
      existing.name = cleanName;
      existing.connected = true;
      participant = existing;
    } else {
      participant = { name: cleanName, color: hslForUserId(uid), connected: true };
      session.participants.set(uid, participant);
    }

    currentCode = normCode;
    currentUserId = uid;
    socket.join(`session:${normCode}`);
    touchSession(session);
    markDirty();

    io.to(`session:${normCode}`).emit('participant-joined', {
      userId: uid, name: participant.name, color: participant.color, connected: true
    });

    cb?.({ ok: true, userId: uid, color: participant.color });

    // Stuur volgens spec de twee events
    socket.emit('session-state', {
      code: session.code,
      activeQuestionId: session.activeQuestionId,
      blindMode: session.blindMode,
      participants: Array.from(session.participants.entries()).map(([id, p]) => ({
        id, name: p.name, color: p.color, connected: p.connected
      }))
    });
    socket.emit('question-history', {
      questions: Array.from(session.questions.values())
        .map(q => serializeQuestionForClient(q, false))
        .filter(Boolean)
    });
  });

  // ----- Deelnemer: positie indienen -----
  socket.on('submit-position', ({ questionId, x, y } = {}) => {
    const session = getSession();
    if (!session || !currentUserId) return;
    const q = session.questions.get(Number(questionId));
    if (!q) return;
    // Enkel actieve vraag
    if (q.status !== 'active' || session.activeQuestionId !== q.id) return;
    const nx = Math.max(0, Math.min(100, Number(x)));
    const ny = Math.max(0, Math.min(100, Number(y)));
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
    const p = session.participants.get(currentUserId);
    if (!p) return;
    const ts = Date.now();
    q.positions.set(currentUserId, { x: nx, y: ny, timestamp: ts });
    touchSession(session);
    markDirty();
    io.to(`session:${session.code}`).emit('position-update', {
      questionId: q.id,
      userId: currentUserId,
      name: p.name,
      color: p.color,
      x: nx,
      y: ny,
      timestamp: ts
    });
  });

  // ----- Admin: vraag lanceren -----
  socket.on('activate-question', ({ questionId } = {}) => {
    const session = requireAdmin(); if (!session) return;
    const q = session.questions.get(Number(questionId));
    if (!q) return;
    // sluit eventueel lopende vraag
    if (session.activeQuestionId !== null && session.activeQuestionId !== q.id) {
      const prev = session.questions.get(session.activeQuestionId);
      if (prev) {
        prev.status = 'closed';
        io.to(`session:${session.code}`).emit('question-closed', { questionId: prev.id });
      }
    }
    q.status = 'active';
    q.launchedAt = q.launchedAt || Date.now();
    session.activeQuestionId = q.id;
    touchSession(session);
    markDirty();
    io.to(`session:${session.code}`).emit('question-active', {
      questionId: q.id,
      questionText: q.text,
      positions: Array.from(q.positions.entries()).map(([uid, pos]) => ({
        userId: uid, x: pos.x, y: pos.y, timestamp: pos.timestamp
      }))
    });
  });

  // ----- Admin: actieve vraag sluiten -----
  socket.on('close-question', () => {
    const session = requireAdmin(); if (!session) return;
    if (session.activeQuestionId === null) return;
    const q = session.questions.get(session.activeQuestionId);
    if (!q) return;
    q.status = 'closed';
    const closedId = q.id;
    session.activeQuestionId = null;
    touchSession(session);
    markDirty();
    io.to(`session:${session.code}`).emit('question-closed', { questionId: closedId });
  });

  // ----- Admin: vraag heropenen -----
  socket.on('reopen-question', ({ questionId } = {}) => {
    const session = requireAdmin(); if (!session) return;
    const q = session.questions.get(Number(questionId));
    if (!q) return;
    if (session.activeQuestionId !== null && session.activeQuestionId !== q.id) {
      const prev = session.questions.get(session.activeQuestionId);
      if (prev) {
        prev.status = 'closed';
        io.to(`session:${session.code}`).emit('question-closed', { questionId: prev.id });
      }
    }
    q.status = 'active';
    session.activeQuestionId = q.id;
    touchSession(session);
    markDirty();
    io.to(`session:${session.code}`).emit('question-reopened', { questionId: q.id });
    io.to(`session:${session.code}`).emit('question-active', {
      questionId: q.id,
      questionText: q.text,
      positions: Array.from(q.positions.entries()).map(([uid, pos]) => ({
        userId: uid, x: pos.x, y: pos.y, timestamp: pos.timestamp
      }))
    });
  });

  // ----- Admin: vraag resetten -----
  socket.on('reset-question', ({ questionId } = {}) => {
    const session = requireAdmin(); if (!session) return;
    const q = session.questions.get(Number(questionId));
    if (!q) return;
    q.positions.clear();
    touchSession(session);
    markDirty();
    io.to(`session:${session.code}`).emit('question-reset', { questionId: q.id });
  });

  // ----- Admin: blind mode -----
  socket.on('toggle-blind', ({ value } = {}) => {
    const session = requireAdmin(); if (!session) return;
    session.blindMode = !!value;
    touchSession(session);
    markDirty();
    io.to(`session:${session.code}`).emit('blind-mode-changed', { value: session.blindMode });
  });

  socket.on('disconnect', () => {
    if (currentCode && currentUserId && !isAdmin) {
      const session = sessions.get(currentCode);
      if (session) {
        const p = session.participants.get(currentUserId);
        if (p) p.connected = false;
        io.to(`session:${currentCode}`).emit('participant-left', { userId: currentUserId });
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Kwadrantenpoll draait op http://localhost:${PORT}`);
  console.log(`Admin:  http://localhost:${PORT}/admin`);
  console.log(`Deelnemers:  http://localhost:${PORT}/`);
});

// Save on shutdown
process.on('SIGINT', () => { saveSnapshot(); process.exit(0); });
process.on('SIGTERM', () => { saveSnapshot(); process.exit(0); });
