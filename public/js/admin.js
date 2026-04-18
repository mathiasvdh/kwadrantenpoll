(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const el = {
    sessionCode:    $('#sessionCode'),
    participantUrl: $('#participantUrl'),
    qrImg:          $('#qrImg'),
    qrFullscreen:   $('#qrFullscreen'),
    qrOverlay:      $('#qrOverlay'),
    qrOverlayCode:  $('#qrOverlayCode'),
    qrOverlayImg:   $('#qrOverlayImg'),
    qrOverlayUrl:   $('#qrOverlayUrl'),
    placedCount:    $('#placedCount'),
    totalCount:     $('#totalCount'),
    blindToggle:    $('#blindToggle'),
    hoverLabelsToggle: $('#hoverLabelsToggle'),
    exportPngBtn:   $('#exportPngBtn'),
    exportCsvBtn:   $('#exportCsvBtn'),
    openSidebar:    $('#openSidebar'),
    closeSidebar:   $('#closeSidebar'),
    sidebar:        $('#sidebar'),
    sidebarBackdrop:$('#sidebarBackdrop'),
    launchedList:   $('#launchedList'),
    pendingList:    $('#pendingList'),
    qBarLabel:      $('#qBarLabel'),
    qBarText:       $('#qBarText'),
    questionBar:    $('#questionBar'),
    reviewBanner:   $('#reviewBanner'),
    backToActive:   $('#backToActive'),
    chartSvg:       $('#chart')
  };

  const state = {
    code: null,
    adminToken: null,
    participants: new Map(),
    questions: new Map(), // full list incl. pending
    activeQuestionId: null,
    viewedQuestionId: null,
    blindMode: false,
    chart: null,
    socket: null
  };

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ---------- connect ----------
  const sock = io();
  state.socket = sock;

  const savedCode = sessionStorage.getItem('kp.adminCode');
  const savedToken = sessionStorage.getItem('kp.adminToken');

  sock.on('connect', () => {
    if (savedCode && savedToken) {
      sock.emit('admin-reconnect', { code: savedCode, adminToken: savedToken }, (ack) => {
        if (ack?.ok) {
          applyAdminState(ack.state);
        } else {
          createNew();
        }
      });
    } else {
      createNew();
    }
  });

  function createNew() {
    sock.emit('admin-create-session', null, (ack) => {
      if (!ack?.ok) {
        alert('Kon sessie niet aanmaken: ' + (ack?.error || 'onbekend'));
        return;
      }
      applyAdminState(ack.state);
      sessionStorage.setItem('kp.adminCode', ack.state.code);
      sessionStorage.setItem('kp.adminToken', ack.state.adminToken);
    });
  }

  function applyAdminState(st) {
    state.code = st.code;
    state.adminToken = st.adminToken;
    state.activeQuestionId = st.activeQuestionId;
    state.blindMode = !!st.blindMode;
    state.participants = new Map(st.participants.map(p => [p.id, p]));
    state.questions = new Map(st.questions.map(q => [q.id, {
      ...q,
      positions: new Map((q.positions || []).map(p => [p.userId, p]))
    }]));
    state.viewedQuestionId = st.activeQuestionId;
    if (state.viewedQuestionId == null) {
      const lastClosed = Array.from(state.questions.values())
        .filter(q => q.status === 'closed')
        .sort((a, b) => (b.launchedAt || 0) - (a.launchedAt || 0))[0];
      if (lastClosed) state.viewedQuestionId = lastClosed.id;
    }

    renderCode();
    if (!state.chart) {
      state.chart = new QuadrantChart(el.chartSvg, { interactive: false });
    }
    state.chart.setBlindMode(state.blindMode);
    el.blindToggle.checked = state.blindMode;
    renderSidebar();
    renderMain();
    bindUI();
  }

  // ---------- socket events ----------
  sock.on('position-update', ({ questionId, userId, name, color, x, y, timestamp }) => {
    let q = state.questions.get(questionId);
    if (!q) return;
    q.positions.set(userId, { userId, name, color, x, y, timestamp });
    q.responseCount = q.positions.size;
    if (!state.participants.has(userId)) {
      state.participants.set(userId, { id: userId, name, color, connected: true });
    }
    if (state.viewedQuestionId === questionId) {
      state.chart?.upsertPosition({ userId, name, color, x, y });
    }
    updateCounts();
    renderSidebar();
  });

  sock.on('question-active', ({ questionId, questionText, positions }) => {
    let q = state.questions.get(questionId);
    if (!q) {
      q = { id: questionId, text: questionText, status: 'active', launchedAt: Date.now(), positions: new Map(), responseCount: 0 };
      state.questions.set(questionId, q);
    }
    q.status = 'active';
    if (positions) {
      q.positions = new Map(positions.map(p => [p.userId, p]));
      q.responseCount = q.positions.size;
    }
    for (const other of state.questions.values()) {
      if (other.id !== questionId && other.status === 'active') other.status = 'closed';
    }
    state.activeQuestionId = questionId;
    state.viewedQuestionId = questionId;
    renderSidebar();
    renderMain();
  });

  sock.on('question-closed', ({ questionId }) => {
    const q = state.questions.get(questionId);
    if (q) q.status = 'closed';
    if (state.activeQuestionId === questionId) state.activeQuestionId = null;
    renderSidebar();
    renderMain();
  });

  sock.on('question-reopened', ({ questionId }) => {
    const q = state.questions.get(questionId);
    if (q) q.status = 'active';
    renderSidebar();
  });

  sock.on('question-reset', ({ questionId }) => {
    const q = state.questions.get(questionId);
    if (!q) return;
    q.positions.clear();
    q.responseCount = 0;
    if (state.viewedQuestionId === questionId) state.chart?.clearPositions();
    renderSidebar();
  });

  sock.on('blind-mode-changed', ({ value }) => {
    state.blindMode = !!value;
    el.blindToggle.checked = state.blindMode;
    state.chart?.setBlindMode(state.blindMode);
  });

  sock.on('participant-joined', ({ userId, name, color, connected }) => {
    state.participants.set(userId, { id: userId, name, color, connected });
    updateCounts();
  });
  sock.on('participant-left', ({ userId }) => {
    const p = state.participants.get(userId);
    if (p) p.connected = false;
    updateCounts();
  });

  // ---------- UI ----------
  let uiBound = false;
  function bindUI() {
    if (uiBound) return;
    uiBound = true;

    el.openSidebar.addEventListener('click', () => { el.sidebar.classList.add('open'); el.sidebarBackdrop.classList.add('show'); });
    el.closeSidebar.addEventListener('click', closeSidebar);
    el.sidebarBackdrop.addEventListener('click', closeSidebar);
    function closeSidebar() { el.sidebar.classList.remove('open'); el.sidebarBackdrop.classList.remove('show'); }

    el.blindToggle.addEventListener('change', () => {
      sock.emit('toggle-blind', { value: el.blindToggle.checked });
    });

    el.hoverLabelsToggle.addEventListener('change', () => {
      state.chart?.setHoverLabelsOnly(el.hoverLabelsToggle.checked);
    });

    el.backToActive.addEventListener('click', () => {
      if (state.activeQuestionId != null) {
        state.viewedQuestionId = state.activeQuestionId;
        renderSidebar();
        renderMain();
      }
    });

    el.exportPngBtn.addEventListener('click', () => {
      const q = state.viewedQuestionId != null ? state.questions.get(state.viewedQuestionId) : null;
      const fn = q ? `kwadranten-v${q.id}-${state.code}.png` : `kwadranten-${state.code}.png`;
      state.chart.exportPNG(fn);
    });

    el.exportCsvBtn.addEventListener('click', () => {
      const u = `/api/session/${state.code}/export.csv?adminToken=${encodeURIComponent(state.adminToken)}`;
      window.open(u, '_blank');
    });

    el.qrImg.addEventListener('click', openQRFullscreen);
    el.qrFullscreen.addEventListener('click', openQRFullscreen);
    el.qrOverlay.addEventListener('click', () => el.qrOverlay.classList.add('hide'));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') el.qrOverlay.classList.add('hide');
    });
  }

  function openQRFullscreen() {
    el.qrOverlayCode.textContent = state.code;
    const url = participantUrl();
    el.qrOverlayUrl.textContent = url;
    el.qrOverlayImg.src = `/api/qr?size=640&text=${encodeURIComponent(url)}`;
    el.qrOverlay.classList.remove('hide');
  }

  // ---------- code + QR ----------
  function participantUrl() {
    return `${location.origin}/?code=${state.code}`;
  }

  function renderCode() {
    el.sessionCode.textContent = state.code;
    document.title = `Kwadrantenpoll — ${state.code}`;
    const url = participantUrl();
    el.participantUrl.textContent = url;
    el.qrImg.src = `/api/qr?size=128&text=${encodeURIComponent(url)}`;
    updateCounts();
  }

  function updateCounts() {
    el.totalCount.textContent = String(state.participants.size);
    let placed = 0;
    if (state.activeQuestionId != null) {
      const q = state.questions.get(state.activeQuestionId);
      placed = q ? q.positions.size : 0;
    }
    el.placedCount.textContent = String(placed);
  }

  // ---------- sidebar ----------
  function renderSidebar() {
    const launched = Array.from(state.questions.values())
      .filter(q => q.status !== 'pending')
      .sort((a, b) => (a.launchedAt || 0) - (b.launchedAt || 0) || a.id - b.id);
    const pending = Array.from(state.questions.values())
      .filter(q => q.status === 'pending')
      .sort((a, b) => a.id - b.id);

    el.launchedList.innerHTML = launched.map(q => renderLaunchedItem(q)).join('') || '<div style="color:var(--muted);padding:0 10px;font-size:13px">Nog niets gelanceerd.</div>';
    el.pendingList.innerHTML = pending.map(q => renderPendingItem(q)).join('') || '<div style="color:var(--muted);padding:0 10px;font-size:13px">Geen vragen meer.</div>';

    // bind clicks & admin actions
    document.querySelectorAll('[data-view]').forEach(e => {
      e.addEventListener('click', (ev) => {
        if (ev.target.closest('button')) return;
        const id = Number(e.dataset.view);
        state.viewedQuestionId = id;
        renderSidebar();
        renderMain();
      });
    });
    document.querySelectorAll('[data-launch]').forEach(b => {
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        sock.emit('activate-question', { questionId: Number(b.dataset.launch) });
      });
    });
    document.querySelectorAll('[data-close]').forEach(b => {
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        sock.emit('close-question', {});
      });
    });
    document.querySelectorAll('[data-reopen]').forEach(b => {
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        sock.emit('reopen-question', { questionId: Number(b.dataset.reopen) });
      });
    });
    document.querySelectorAll('[data-reset]').forEach(b => {
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const id = Number(b.dataset.reset);
        const q = state.questions.get(id);
        if (confirm(`Alle antwoorden voor vraag ${id} wissen?\n\n"${q?.text?.slice(0, 80)}"`)) {
          sock.emit('reset-question', { questionId: id });
        }
      });
    });
  }

  function renderLaunchedItem(q) {
    const viewing = q.id === state.viewedQuestionId;
    const active = q.status === 'active';
    return `
      <div class="q-item admin ${viewing ? 'viewing' : ''} ${active ? 'active-q' : ''}" data-view="${q.id}">
        <div class="qnum">${q.id}</div>
        <div class="col">
          <div class="qtext">${esc(q.text)}</div>
          <div class="qcount">${q.responseCount || q.positions.size} antwoorden</div>
          <div class="q-actions">
            ${active
              ? `<button class="danger" data-close="${q.id}">Sluit</button>`
              : `<button data-reopen="${q.id}">Heropen</button>`}
            <button class="ghost" data-reset="${q.id}">Reset</button>
          </div>
        </div>
        <div class="qstatus">${active ? '🟢' : '🔒'}</div>
      </div>
    `;
  }

  function renderPendingItem(q) {
    return `
      <div class="q-item admin pending" data-view="${q.id}" style="opacity:0.85">
        <div class="qnum">${q.id}</div>
        <div class="col">
          <div class="qtext">${esc(q.text)}</div>
          <div class="q-actions">
            <button class="primary" data-launch="${q.id}">Lanceer</button>
          </div>
        </div>
        <div class="qstatus">⚪</div>
      </div>
    `;
  }

  // ---------- main ----------
  function renderMain() {
    const q = state.viewedQuestionId != null ? state.questions.get(state.viewedQuestionId) : null;
    if (!q || q.status === 'pending') {
      el.qBarLabel.textContent = q ? `Vraag ${q.id} • Nog niet gelanceerd` : 'Geen actieve vraag';
      el.qBarText.textContent = q ? q.text : 'Lanceer een vraag uit het zijpaneel om te beginnen.';
      el.questionBar.classList.remove('closed');
      el.reviewBanner.style.display = 'none';
      state.chart?.setPositions([]);
      updateCounts();
      return;
    }
    const isActive = q.id === state.activeQuestionId && q.status === 'active';
    el.qBarLabel.textContent = `Vraag ${q.id} • ${isActive ? 'Actief' : 'Afgesloten'}`;
    el.qBarText.textContent = q.text;
    el.questionBar.classList.toggle('closed', !isActive);
    el.reviewBanner.style.display = isActive ? 'none' : 'flex';

    const posArr = Array.from(q.positions.values()).map(p => ({
      userId: p.userId,
      name: p.name || (state.participants.get(p.userId)?.name) || '',
      color: p.color || (state.participants.get(p.userId)?.color) || '#888',
      x: p.x, y: p.y
    }));
    state.chart.setPositions(posArr);
    state.chart.setBlindMode(state.blindMode);
    updateCounts();
  }
})();
