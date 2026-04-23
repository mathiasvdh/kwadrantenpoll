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
// STANDAARD VRAGEN — komen in een nieuwe sessie. Admin kan ze live aanpassen.
// ============================================================================
const DEFAULT_QUESTIONS = [
  "AI die feedback geeft op de eerste draft van een schrijfopdracht.",
  "Een AI-tutor die studenten buiten de lesuren persoonlijk begeleidt bij oefeningen en uitleg, afgestemd op hun tempo en niveau.",
  "Een AI-detector waarmee de docent nagaat of een ingeleverde tekst door AI is gegenereerd.",
  "AI die live hoorcolleges vertaalt voor anderstalige studenten en de transcriptie ter beschikking stelt.",
  "AI die data van studenten analyseert en monitort: aanwezigheid, participatie, score, feedback, uitvalrisico, voortgang.",
  "Een op maat gemaakte chatbot die op basis van bronnenmateriaal van de docent alle vragen beantwoordt tijdens de les, zodat er meer tijd is voor lesgeven.",
  "Een AI waarin je tientallen academische artikelen kan uploaden en die gebruikt kan worden als kennisbasis.",
  "AI die lesmateriaal genereert voor de docent (slides, hand-outs, extra oefeningen, …).",
  "Een bot die zich gedraagt als een student, waaraan studenten begrippen uit de cursus moeten uitleggen.",
  "De online applicatie die we nu gebruiken: een docent die via vibe-code een tool bouwt waarin collega's stemmen over AI in onderwijs."
];

// ============================================================================
// STANDAARD CONFIG — assen + kwadrantkleuren
// ============================================================================
function buildDefaultConfig() {
  return {
    axisX: { title: 'Risico', low: 'Laag', high: 'Hoog' }, // low = label aan x=0 (links), high = label aan x=100 (rechts)
    axisY: { title: 'Impact', low: 'Laag', high: 'Hoog' }, // low = label aan y=0 (onder), high = label aan y=100 (boven)
    quadrants: {
      tl: { text: 'Laag risico / Hoge impact', color: '#dcf1dc' }, // lichtgroen
      tr: { text: 'Hoog risico / Hoge impact', color: '#ffe2c0' }, // lichtoranje
      bl: { text: 'Laag risico / Lage impact', color: '#f0dfdb' }, // zacht roze
      br: { text: 'Hoog risico / Lage impact', color: '#f2a29a' }  // rood
    }
  };
}

function sanitizeConfig(input) {
  const d = buildDefaultConfig();
  if (!input || typeof input !== 'object') return d;
  const str = (v, fallback, max = 60) => {
    if (typeof v !== 'string') return fallback;
    return v.replace(/[\u0000-\u001F<>]/g, '').trim().slice(0, max) || fallback;
  };
  const color = (v, fallback) => {
    if (typeof v !== 'string') return fallback;
    const t = v.trim();
    if (/^#[0-9a-f]{3,8}$/i.test(t)) return t;
    if (/^(rgb|hsl)a?\(\s*[0-9.,\s%-]+\s*\)$/i.test(t)) return t;
    return fallback;
  };
  const q = (side) => ({
    text: str(input.quadrants?.[side]?.text, d.quadrants[side].text, 80),
    color: color(input.quadrants?.[side]?.color, d.quadrants[side].color)
  });
  return {
    axisX: {
      title: str(input.axisX?.title, d.axisX.title, 40),
      low:   str(input.axisX?.low,   d.axisX.low,   30),
      high:  str(input.axisX?.high,  d.axisX.high,  30)
    },
    axisY: {
      title: str(input.axisY?.title, d.axisY.title, 40),
      low:   str(input.axisY?.low,   d.axisY.low,   30),
      high:  str(input.axisY?.high,  d.axisY.high,  30)
    },
    quadrants: { tl: q('tl'), tr: q('tr'), bl: q('bl'), br: q('br') }
  };
}

function sanitizeQuestionText(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001F]/g, ' ').trim().slice(0, 500);
}

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

function makeDefaultQuestionsMap() {
  const map = new Map();
  DEFAULT_QUESTIONS.forEach((text, i) => {
    const id = i + 1;
    map.set(id, { id, text, status: 'pending', launchedAt: null, positions: new Map() });
  });
  return map;
}

function createSession(initialConfig, initialQuestions) {
  const code = generateSessionCode();
  const now = Date.now();
  let questionsMap;
  let nextQuestionId;
  if (Array.isArray(initialQuestions) && initialQuestions.length > 0) {
    questionsMap = new Map();
    initialQuestions.forEach((text, i) => {
      const t = sanitizeQuestionText(text);
      if (!t) return;
      const id = i + 1;
      questionsMap.set(id, { id, text: t, status: 'pending', launchedAt: null, positions: new Map() });
    });
    if (questionsMap.size === 0) questionsMap = makeDefaultQuestionsMap();
    nextQuestionId = questionsMap.size + 1;
  } else {
    questionsMap = makeDefaultQuestionsMap();
    nextQuestionId = DEFAULT_QUESTIONS.length + 1;
  }
  const session = {
    code,
    createdAt: now,
    lastActivity: now,
    adminToken: crypto.randomUUID(),
    activeQuestionId: null,
    blindMode: false,
    config: sanitizeConfig(initialConfig),
    nextQuestionId,
    participants: new Map(),
    questions: questionsMap
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
    config: s.config,
    nextQuestionId: s.nextQuestionId,
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
      // respecteer volgorde van snapshot
      for (const q of (s.questions || [])) {
        const txt = sanitizeQuestionText(q.text);
        if (!txt) continue;
        questionsMap.set(q.id, {
          id: q.id,
          text: txt,
          status: ['pending','active','closed'].includes(q.status) ? q.status : 'pending',
          launchedAt: q.launchedAt ?? null,
          positions: new Map((q.positions || []).map(p => [p.userId, { x: p.x, y: p.y, timestamp: p.timestamp }]))
        });
      }
      if (questionsMap.size === 0) {
        makeDefaultQuestionsMap().forEach((v, k) => questionsMap.set(k, v));
      }
      const maxId = Math.max(0, ...questionsMap.keys());
      sessions.set(s.code, {
        code: s.code,
        createdAt: s.createdAt,
        lastActivity: s.lastActivity,
        adminToken: s.adminToken,
        activeQuestionId: s.activeQuestionId,
        blindMode: !!s.blindMode,
        config: sanitizeConfig(s.config),
        nextQuestionId: s.nextQuestionId && s.nextQuestionId > maxId ? s.nextQuestionId : maxId + 1,
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
  return {
    code: session.code,
    activeQuestionId: session.activeQuestionId,
    blindMode: session.blindMode,
    config: session.config,
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
    config: session.config,
    participants: Array.from(session.participants.entries()).map(([id, p]) => ({
      id, name: p.name, color: p.color, connected: p.connected
    })),
    questions: Array.from(session.questions.values())
      .map(q => serializeQuestionForClient(q, true))
  };
}

function broadcastQuestionsUpdated(session) {
  const pub = Array.from(session.questions.values())
    .map(q => serializeQuestionForClient(q, false))
    .filter(Boolean);
  const adm = Array.from(session.questions.values())
    .map(q => serializeQuestionForClient(q, true));
  io.to(`session:${session.code}`).emit('questions-updated', { questions: pub });
  io.to(`admin:${session.code}`).emit('admin-questions-updated', { questions: adm });
}

function broadcastConfigChanged(session) {
  io.to(`session:${session.code}`).emit('config-changed', { config: session.config });
}

// ============================================================================
// HTTP
// ============================================================================
const app = express();
app.use(express.json());

// Embed-vriendelijke headers zodat de app in o.a. PowerPoint Web Viewer,
// Microsoft Teams, Notion, etc. als iframe mag geladen worden.
app.use((req, res, next) => {
  res.removeHeader('X-Frame-Options');
  // CSP: sta embed toe vanuit elke oorsprong (wijzig naar specifieke domains als je strenger wil zijn)
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  next();
});

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
  // Dynamische kolomnamen op basis van sessie-config
  const cfg = session.config || buildDefaultConfig();
  const xHeader = `x: ${cfg.axisX.title} (0=links/${cfg.axisX.low}, 100=rechts/${cfg.axisX.high})`;
  const yHeader = `y: ${cfg.axisY.title} (0=onder/${cfg.axisY.low}, 100=boven/${cfg.axisY.high})`;
  const rows = [['userId','name','questionId','questionText', xHeader, yHeader, 'timestamp']];
  for (const q of session.questions.values()) {
    for (const [uid, pos] of q.positions.entries()) {
      const p = session.participants.get(uid);
      rows.push([
        uid,
        p ? p.name : '',
        q.id,
        q.text,
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

  // ----- Admin: nieuwe sessie aanmaken (eventueel met preset config/questions) -----
  socket.on('admin-create-session', (arg, cb) => {
    try {
      const opts = arg && typeof arg === 'object' ? arg : {};
      const session = createSession(opts.config, opts.questions);
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
      config: session.config,
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

  // ----- Admin: config updaten (assen, kwadrantlabels + kleuren) -----
  socket.on('admin-update-config', ({ config } = {}, cb) => {
    const session = requireAdmin(); if (!session) return cb?.({ ok: false });
    session.config = sanitizeConfig(config);
    touchSession(session);
    markDirty();
    broadcastConfigChanged(session);
    cb?.({ ok: true, config: session.config });
  });

  // ----- Admin: vraag toevoegen -----
  socket.on('admin-add-question', ({ text } = {}, cb) => {
    const session = requireAdmin(); if (!session) return cb?.({ ok: false });
    const clean = sanitizeQuestionText(text);
    if (!clean) return cb?.({ ok: false, error: 'EMPTY' });
    const id = session.nextQuestionId++;
    const q = { id, text: clean, status: 'pending', launchedAt: null, positions: new Map() };
    session.questions.set(id, q);
    touchSession(session); markDirty();
    broadcastQuestionsUpdated(session);
    cb?.({ ok: true, id });
  });

  // ----- Admin: vraagtekst wijzigen -----
  socket.on('admin-update-question', ({ id, text } = {}, cb) => {
    const session = requireAdmin(); if (!session) return cb?.({ ok: false });
    const q = session.questions.get(Number(id));
    if (!q) return cb?.({ ok: false, error: 'NOT_FOUND' });
    const clean = sanitizeQuestionText(text);
    if (!clean) return cb?.({ ok: false, error: 'EMPTY' });
    q.text = clean;
    touchSession(session); markDirty();
    broadcastQuestionsUpdated(session);
    // als deze vraag actief is, opnieuw als actief broadcasten zodat tekst in question bar mee-update
    if (q.status === 'active') {
      io.to(`session:${session.code}`).emit('question-active', {
        questionId: q.id, questionText: q.text,
        positions: Array.from(q.positions.entries()).map(([uid, p]) => ({ userId: uid, x: p.x, y: p.y, timestamp: p.timestamp }))
      });
    }
    cb?.({ ok: true });
  });

  // ----- Admin: vraag verwijderen -----
  socket.on('admin-delete-question', ({ id } = {}, cb) => {
    const session = requireAdmin(); if (!session) return cb?.({ ok: false });
    const qid = Number(id);
    const q = session.questions.get(qid);
    if (!q) return cb?.({ ok: false, error: 'NOT_FOUND' });
    session.questions.delete(qid);
    if (session.activeQuestionId === qid) {
      session.activeQuestionId = null;
      io.to(`session:${session.code}`).emit('question-closed', { questionId: qid });
    }
    touchSession(session); markDirty();
    broadcastQuestionsUpdated(session);
    cb?.({ ok: true });
  });

  // ----- Admin: vragen herordenen -----
  socket.on('admin-reorder-questions', ({ ids } = {}, cb) => {
    const session = requireAdmin(); if (!session) return cb?.({ ok: false });
    if (!Array.isArray(ids)) return cb?.({ ok: false, error: 'INVALID' });
    const newMap = new Map();
    for (const rawId of ids) {
      const id = Number(rawId);
      const q = session.questions.get(id);
      if (q) newMap.set(id, q);
    }
    // vragen die niet in `ids` zaten achteraan plakken (veiligheidsnet)
    for (const [id, q] of session.questions) if (!newMap.has(id)) newMap.set(id, q);
    session.questions = newMap;
    touchSession(session); markDirty();
    broadcastQuestionsUpdated(session);
    cb?.({ ok: true });
  });

  // ----- Admin: volledige replace (preset laden) -----
  socket.on('admin-replace-all', ({ config, questions: qs } = {}, cb) => {
    const session = requireAdmin(); if (!session) return cb?.({ ok: false });
    // nieuwe config
    session.config = sanitizeConfig(config);
    // nieuwe vragen
    if (Array.isArray(qs)) {
      const newMap = new Map();
      let idCounter = 1;
      for (const item of qs) {
        const text = sanitizeQuestionText(typeof item === 'string' ? item : item?.text);
        if (!text) continue;
        const id = idCounter++;
        newMap.set(id, { id, text, status: 'pending', launchedAt: null, positions: new Map() });
      }
      if (newMap.size > 0) {
        session.questions = newMap;
        session.activeQuestionId = null;
        session.nextQuestionId = idCounter;
      }
    }
    touchSession(session); markDirty();
    broadcastConfigChanged(session);
    broadcastQuestionsUpdated(session);
    cb?.({ ok: true, state: buildAdminState(session) });
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
