(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s, p=document) => p.querySelectorAll(s);
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
    settingsBtn:    $('#settingsBtn'),
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
    chartSvg:       $('#chart'),

    // settings modal
    settingsModal:  $('#settingsModal'),
    settingsClose:  $('#settingsClose'),

    cfgXTitle: $('#cfgXTitle'), cfgXLow: $('#cfgXLow'), cfgXHigh: $('#cfgXHigh'),
    cfgYTitle: $('#cfgYTitle'), cfgYLow: $('#cfgYLow'), cfgYHigh: $('#cfgYHigh'),
    cfgTlText: $('#cfgTlText'), cfgTlColor: $('#cfgTlColor'),
    cfgTrText: $('#cfgTrText'), cfgTrColor: $('#cfgTrColor'),
    cfgBlText: $('#cfgBlText'), cfgBlColor: $('#cfgBlColor'),
    cfgBrText: $('#cfgBrText'), cfgBrColor: $('#cfgBrColor'),
    cfgAutoLabel: $('#cfgAutoLabel'),
    cfgApply: $('#cfgApply'),
    cfgRevert: $('#cfgRevert'),
    cfgDefaults: $('#cfgDefaults'),

    qEditorList: $('#qEditorList'),
    qAddText: $('#qAddText'),
    qAddBtn: $('#qAddBtn'),

    presetList: $('#presetList'),
    presetSaveName: $('#presetSaveName'),
    presetSaveBtn: $('#presetSaveBtn'),
    presetExportBtn: $('#presetExportBtn'),
    presetImportFile: $('#presetImportFile')
  };

  const DEFAULT_CONFIG = {
    axisX: { title: 'Risico', low: 'Laag', high: 'Hoog' },
    axisY: { title: 'Impact', low: 'Laag', high: 'Hoog' },
    quadrants: {
      tl: { text: 'Laag risico / Hoge impact', color: '#dcf1dc' },
      tr: { text: 'Hoog risico / Hoge impact', color: '#ffe2c0' },
      bl: { text: 'Laag risico / Lage impact', color: '#f0dfdb' },
      br: { text: 'Hoog risico / Lage impact', color: '#f2a29a' }
    }
  };

  const state = {
    code: null,
    adminToken: null,
    participants: new Map(),
    questions: new Map(), // full list incl. pending
    activeQuestionId: null,
    viewedQuestionId: null,
    blindMode: false,
    config: structuredClone(DEFAULT_CONFIG),
    chart: null,
    socket: null
  };

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ===========================================================================
  // Socket connect
  // ===========================================================================
  const sock = io();
  state.socket = sock;

  const savedCode = sessionStorage.getItem('kp.adminCode');
  const savedToken = sessionStorage.getItem('kp.adminToken');

  sock.on('connect', () => {
    if (savedCode && savedToken) {
      sock.emit('admin-reconnect', { code: savedCode, adminToken: savedToken }, (ack) => {
        if (ack?.ok) applyAdminState(ack.state);
        else createNew();
      });
    } else {
      createNew();
    }
  });

  function createNew(opts) {
    sock.emit('admin-create-session', opts || null, (ack) => {
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
    state.config = st.config || structuredClone(DEFAULT_CONFIG);
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
      state.chart = new QuadrantChart(el.chartSvg, { interactive: false, config: state.config });
    } else {
      state.chart.setConfig(state.config);
    }
    state.chart.setBlindMode(state.blindMode);
    el.blindToggle.checked = state.blindMode;
    renderSidebar();
    renderMain();
    bindUI();
  }

  // ===========================================================================
  // Socket events
  // ===========================================================================
  sock.on('position-update', ({ questionId, userId, name, color, x, y, timestamp }) => {
    const q = state.questions.get(questionId);
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
    q.text = questionText;
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

  sock.on('config-changed', ({ config }) => {
    state.config = config;
    state.chart?.setConfig(config);
    // als modal open is en gebruiker niet aan het typen is, vernieuw het formulier
    if (!el.settingsModal.classList.contains('hide') && !activelyEditing()) {
      formFromConfig(state.config);
    }
  });

  sock.on('admin-questions-updated', ({ questions: qs }) => {
    // behoud bestaande positions waar mogelijk
    const newMap = new Map();
    for (const q of qs) {
      const prev = state.questions.get(q.id);
      newMap.set(q.id, {
        id: q.id, text: q.text, status: q.status,
        launchedAt: q.launchedAt,
        responseCount: q.responseCount,
        positions: prev ? prev.positions : new Map((q.positions || []).map(p => [p.userId, p]))
      });
      // if server sent positions, prefer those
      if (q.positions && q.positions.length) {
        newMap.get(q.id).positions = new Map(q.positions.map(p => [p.userId, p]));
      }
    }
    state.questions = newMap;
    if (state.viewedQuestionId != null && !state.questions.has(state.viewedQuestionId)) {
      state.viewedQuestionId = state.activeQuestionId;
    }
    renderSidebar();
    renderMain();
    if (!el.settingsModal.classList.contains('hide')) renderQuestionEditor();
  });

  // ===========================================================================
  // UI binds (one-time)
  // ===========================================================================
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
        renderSidebar(); renderMain();
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
      if (e.key === 'Escape') {
        el.qrOverlay.classList.add('hide');
        if (!el.settingsModal.classList.contains('hide')) closeSettings();
      }
    });

    // settings modal
    el.settingsBtn.addEventListener('click', openSettings);
    el.settingsClose.addEventListener('click', closeSettings);
    el.settingsModal.addEventListener('click', (e) => {
      if (e.target === el.settingsModal) closeSettings();
    });
    $$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

    // config form actions
    el.cfgApply.addEventListener('click', applyConfigForm);
    el.cfgRevert.addEventListener('click', () => formFromConfig(state.config));
    el.cfgDefaults.addEventListener('click', () => formFromConfig(DEFAULT_CONFIG));
    el.cfgAutoLabel.addEventListener('click', autoLabelQuadrants);

    // question editor
    el.qAddBtn.addEventListener('click', () => {
      const text = el.qAddText.value.trim();
      if (!text) return;
      sock.emit('admin-add-question', { text }, (ack) => {
        if (ack?.ok) el.qAddText.value = '';
      });
    });
    el.qAddText.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) el.qAddBtn.click();
    });

    // presets
    el.presetSaveBtn.addEventListener('click', savePresetFromCurrent);
    el.presetExportBtn.addEventListener('click', exportCurrentAsFile);
    el.presetImportFile.addEventListener('change', importPresetFile);
  }

  function openQRFullscreen() {
    el.qrOverlayCode.textContent = state.code;
    const url = participantUrl();
    el.qrOverlayUrl.textContent = url;
    el.qrOverlayImg.src = `/api/qr?size=640&text=${encodeURIComponent(url)}`;
    el.qrOverlay.classList.remove('hide');
  }

  function participantUrl() { return `${location.origin}/?code=${state.code}`; }

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

  // ===========================================================================
  // Sidebar (live session)
  // ===========================================================================
  function renderSidebar() {
    const launched = Array.from(state.questions.values())
      .filter(q => q.status !== 'pending')
      .sort((a, b) => (a.launchedAt || 0) - (b.launchedAt || 0) || a.id - b.id);
    const pending = Array.from(state.questions.values())
      .filter(q => q.status === 'pending');

    el.launchedList.innerHTML = launched.map(renderLaunchedItem).join('') || '<div style="color:var(--muted);padding:0 10px;font-size:13px">Nog niets gelanceerd.</div>';
    el.pendingList.innerHTML = pending.map(renderPendingItem).join('') || '<div style="color:var(--muted);padding:0 10px;font-size:13px">Geen vragen meer.</div>';

    $$('[data-view]').forEach(e => {
      e.addEventListener('click', (ev) => {
        if (ev.target.closest('button')) return;
        const id = Number(e.dataset.view);
        state.viewedQuestionId = id;
        renderSidebar(); renderMain();
      });
    });
    $$('[data-launch]').forEach(b => {
      b.addEventListener('click', (ev) => { ev.stopPropagation();
        sock.emit('activate-question', { questionId: Number(b.dataset.launch) }); });
    });
    $$('[data-close]').forEach(b => {
      b.addEventListener('click', (ev) => { ev.stopPropagation(); sock.emit('close-question', {}); });
    });
    $$('[data-reopen]').forEach(b => {
      b.addEventListener('click', (ev) => { ev.stopPropagation();
        sock.emit('reopen-question', { questionId: Number(b.dataset.reopen) }); });
    });
    $$('[data-reset]').forEach(b => {
      b.addEventListener('click', (ev) => { ev.stopPropagation();
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
      </div>`;
  }

  function renderPendingItem(q) {
    return `
      <div class="q-item admin pending" data-view="${q.id}">
        <div class="qnum">${q.id}</div>
        <div class="col">
          <div class="qtext">${esc(q.text)}</div>
          <div class="q-actions">
            <button class="primary" data-launch="${q.id}">Lanceer</button>
          </div>
        </div>
        <div class="qstatus">⚪</div>
      </div>`;
  }

  // ===========================================================================
  // Main area
  // ===========================================================================
  function renderMain() {
    const q = state.viewedQuestionId != null ? state.questions.get(state.viewedQuestionId) : null;
    if (!q || q.status === 'pending') {
      el.qBarLabel.textContent = q ? `Vraag ${q.id} • Nog niet gelanceerd` : 'Geen actieve vraag';
      el.qBarText.textContent = q ? q.text : 'Lanceer een vraag uit het zijpaneel of open Instellingen om vragen te bewerken.';
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
      name: p.name || state.participants.get(p.userId)?.name || '',
      color: p.color || state.participants.get(p.userId)?.color || '#888',
      x: p.x, y: p.y
    }));
    state.chart.setPositions(posArr);
    state.chart.setBlindMode(state.blindMode);
    updateCounts();
  }

  // ===========================================================================
  // Settings modal
  // ===========================================================================
  function openSettings() {
    formFromConfig(state.config);
    renderQuestionEditor();
    renderPresetList();
    switchTab('axes');
    el.settingsModal.classList.remove('hide');
  }
  function closeSettings() { el.settingsModal.classList.add('hide'); }

  function switchTab(name) {
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    $$('.tab-pane').forEach(p => p.classList.toggle('hide', p.dataset.pane !== name));
    if (name === 'questions') renderQuestionEditor();
    if (name === 'presets') renderPresetList();
  }

  function activelyEditing() {
    const a = document.activeElement;
    return a && el.settingsModal.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
  }

  // ---------- axes / quadrants form ----------
  function formFromConfig(cfg) {
    el.cfgXTitle.value = cfg.axisX.title;
    el.cfgXLow.value   = cfg.axisX.low;
    el.cfgXHigh.value  = cfg.axisX.high;
    el.cfgYTitle.value = cfg.axisY.title;
    el.cfgYLow.value   = cfg.axisY.low;
    el.cfgYHigh.value  = cfg.axisY.high;
    el.cfgTlText.value = cfg.quadrants.tl.text;
    el.cfgTrText.value = cfg.quadrants.tr.text;
    el.cfgBlText.value = cfg.quadrants.bl.text;
    el.cfgBrText.value = cfg.quadrants.br.text;
    el.cfgTlColor.value = normalizeColorForInput(cfg.quadrants.tl.color);
    el.cfgTrColor.value = normalizeColorForInput(cfg.quadrants.tr.color);
    el.cfgBlColor.value = normalizeColorForInput(cfg.quadrants.bl.color);
    el.cfgBrColor.value = normalizeColorForInput(cfg.quadrants.br.color);
  }

  function normalizeColorForInput(c) {
    // input type=color verwacht #rrggbb
    if (typeof c !== 'string') return '#ffffff';
    if (/^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(c)) {
      return '#' + c.slice(1).split('').map(ch => ch + ch).join('').toLowerCase();
    }
    // poging om rgb(...) om te zetten
    const m = c.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) {
      const h = (n) => Number(n).toString(16).padStart(2,'0');
      return '#' + h(m[1]) + h(m[2]) + h(m[3]);
    }
    return '#ffffff';
  }

  function configFromForm() {
    return {
      axisX: { title: el.cfgXTitle.value, low: el.cfgXLow.value, high: el.cfgXHigh.value },
      axisY: { title: el.cfgYTitle.value, low: el.cfgYLow.value, high: el.cfgYHigh.value },
      quadrants: {
        tl: { text: el.cfgTlText.value, color: el.cfgTlColor.value },
        tr: { text: el.cfgTrText.value, color: el.cfgTrColor.value },
        bl: { text: el.cfgBlText.value, color: el.cfgBlColor.value },
        br: { text: el.cfgBrText.value, color: el.cfgBrColor.value }
      }
    };
  }

  function applyConfigForm() {
    const cfg = configFromForm();
    sock.emit('admin-update-config', { config: cfg }, (ack) => {
      if (ack?.ok) {
        flashOk(el.cfgApply);
        state.config = ack.config;
        state.chart?.setConfig(ack.config);
      }
    });
  }

  function autoLabelQuadrants() {
    // LT = axisX.low + axisY.high; RT = axisX.high + axisY.high; LB = axisX.low + axisY.low; RB = axisX.high + axisY.low
    const ax = el.cfgXTitle.value || 'X';
    const ay = el.cfgYTitle.value || 'Y';
    const xl = el.cfgXLow.value || 'Laag';
    const xh = el.cfgXHigh.value || 'Hoog';
    const yl = el.cfgYLow.value || 'Laag';
    const yh = el.cfgYHigh.value || 'Hoog';
    el.cfgTlText.value = `${xl} ${ax.toLowerCase()} / ${yh} ${ay.toLowerCase()}`;
    el.cfgTrText.value = `${xh} ${ax.toLowerCase()} / ${yh} ${ay.toLowerCase()}`;
    el.cfgBlText.value = `${xl} ${ax.toLowerCase()} / ${yl} ${ay.toLowerCase()}`;
    el.cfgBrText.value = `${xh} ${ax.toLowerCase()} / ${yl} ${ay.toLowerCase()}`;
  }

  function flashOk(btn) {
    const t = btn.textContent;
    btn.textContent = '✓ opgeslagen';
    setTimeout(() => { btn.textContent = t; }, 1200);
  }

  // ---------- question editor ----------
  function renderQuestionEditor() {
    const qs = Array.from(state.questions.values());
    if (qs.length === 0) {
      el.qEditorList.innerHTML = '<div class="hint-text" style="padding:10px">Geen vragen. Voeg er hieronder een toe.</div>';
      return;
    }
    el.qEditorList.innerHTML = qs.map((q, i) => `
      <div class="q-row ${q.status === 'active' ? 'active-q' : (q.status === 'closed' ? 'closed' : '')}">
        <span class="qrow-status" title="${q.status}">${q.status === 'active' ? '🟢' : (q.status === 'closed' ? '🔒' : '⚪')}</span>
        <span class="qrow-num">#${i + 1}</span>
        <input type="text" value="${esc(q.text)}" data-qid="${q.id}" />
        <div class="qrow-arrows">
          <button type="button" title="Omhoog" ${i === 0 ? 'disabled' : ''} data-up="${q.id}">▲</button>
          <button type="button" title="Omlaag" ${i === qs.length - 1 ? 'disabled' : ''} data-down="${q.id}">▼</button>
        </div>
        <button type="button" class="danger" title="Verwijderen" data-del="${q.id}">✕</button>
      </div>
    `).join('');

    // inline edit: blur or Enter saves
    $$('input[data-qid]', el.qEditorList).forEach(inp => {
      const origVal = inp.value;
      inp.addEventListener('blur', () => maybeSave(inp, origVal));
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
        if (e.key === 'Escape') { inp.value = origVal; inp.blur(); }
      });
    });
    $$('[data-up]', el.qEditorList).forEach(b => b.addEventListener('click', () => moveQuestion(Number(b.dataset.up), -1)));
    $$('[data-down]', el.qEditorList).forEach(b => b.addEventListener('click', () => moveQuestion(Number(b.dataset.down), +1)));
    $$('[data-del]', el.qEditorList).forEach(b => b.addEventListener('click', () => {
      const id = Number(b.dataset.del);
      const q = state.questions.get(id);
      const warn = q && q.status !== 'pending' ? '\n\nDeze vraag is al gelanceerd — alle antwoorden gaan verloren.' : '';
      if (confirm(`Vraag verwijderen?\n\n"${q?.text?.slice(0, 100)}"${warn}`)) {
        sock.emit('admin-delete-question', { id });
      }
    }));
  }

  function maybeSave(inp, origVal) {
    const id = Number(inp.dataset.qid);
    const text = inp.value.trim();
    if (!text) { inp.value = origVal; return; }
    if (text === origVal) return;
    sock.emit('admin-update-question', { id, text }, (ack) => {
      if (!ack?.ok) { inp.value = origVal; alert('Kon vraag niet bijwerken.'); }
    });
  }

  function moveQuestion(id, delta) {
    const ids = Array.from(state.questions.keys());
    const idx = ids.indexOf(id);
    if (idx < 0) return;
    const ni = idx + delta;
    if (ni < 0 || ni >= ids.length) return;
    [ids[idx], ids[ni]] = [ids[ni], ids[idx]];
    sock.emit('admin-reorder-questions', { ids });
  }

  // ===========================================================================
  // Presets in localStorage
  // ===========================================================================
  const PRESET_KEY = 'kp.presets.v1';

  function loadPresets() {
    try {
      const raw = localStorage.getItem(PRESET_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }
  function savePresets(arr) {
    localStorage.setItem(PRESET_KEY, JSON.stringify(arr));
  }

  function renderPresetList() {
    const arr = loadPresets();
    if (arr.length === 0) {
      el.presetList.innerHTML = '<div class="hint-text" style="padding:8px">Nog geen presets opgeslagen.</div>';
      return;
    }
    el.presetList.innerHTML = arr.map((p, i) => `
      <div class="preset-row">
        <div class="pname">${esc(p.name)}</div>
        <div class="pmeta">${(p.questions || []).length} vragen</div>
        <button class="primary" data-load="${i}">Laad</button>
        <button data-rename="${i}">Hernoem</button>
        <button data-export="${i}">Export</button>
        <button class="danger" data-delete="${i}">✕</button>
      </div>
    `).join('');
    $$('[data-load]', el.presetList).forEach(b => b.addEventListener('click', () => loadPreset(Number(b.dataset.load))));
    $$('[data-rename]', el.presetList).forEach(b => b.addEventListener('click', () => renamePreset(Number(b.dataset.rename))));
    $$('[data-export]', el.presetList).forEach(b => b.addEventListener('click', () => exportPresetByIndex(Number(b.dataset.export))));
    $$('[data-delete]', el.presetList).forEach(b => b.addEventListener('click', () => deletePreset(Number(b.dataset.delete))));
  }

  function buildCurrentPreset(name) {
    return {
      name: String(name || 'Naamloze preset').slice(0, 60),
      savedAt: Date.now(),
      config: structuredClone(state.config),
      questions: Array.from(state.questions.values()).map(q => q.text)
    };
  }

  function savePresetFromCurrent() {
    const name = el.presetSaveName.value.trim();
    if (!name) { alert('Geef eerst een naam voor de preset.'); return; }
    const arr = loadPresets();
    const existing = arr.findIndex(p => p.name === name);
    const preset = buildCurrentPreset(name);
    if (existing >= 0) {
      if (!confirm(`Preset "${name}" bestaat al. Overschrijven?`)) return;
      arr[existing] = preset;
    } else {
      arr.push(preset);
    }
    savePresets(arr);
    el.presetSaveName.value = '';
    renderPresetList();
    flashOk(el.presetSaveBtn);
  }

  function loadPreset(idx) {
    const arr = loadPresets();
    const p = arr[idx];
    if (!p) return;
    const anyLaunched = Array.from(state.questions.values()).some(q => q.status !== 'pending');
    const warn = anyLaunched
      ? 'Dit vervangt ALLE vragen en verwijdert posities van al gelanceerde vragen.'
      : 'Dit vervangt alle vragen en assen.';
    if (!confirm(`Preset "${p.name}" laden?\n\n${warn}`)) return;
    sock.emit('admin-replace-all', { config: p.config, questions: p.questions }, (ack) => {
      if (ack?.ok) {
        applyAdminState(ack.state);
        closeSettings();
      } else {
        alert('Kon preset niet laden.');
      }
    });
  }

  function renamePreset(idx) {
    const arr = loadPresets();
    const p = arr[idx]; if (!p) return;
    const name = prompt('Nieuwe naam:', p.name);
    if (!name) return;
    p.name = name.slice(0, 60);
    savePresets(arr);
    renderPresetList();
  }

  function deletePreset(idx) {
    const arr = loadPresets();
    const p = arr[idx]; if (!p) return;
    if (!confirm(`Preset "${p.name}" verwijderen?`)) return;
    arr.splice(idx, 1);
    savePresets(arr);
    renderPresetList();
  }

  function exportPresetByIndex(idx) {
    const arr = loadPresets();
    const p = arr[idx]; if (!p) return;
    downloadJson(`kwadrantenpoll-preset-${slug(p.name)}.json`, p);
  }

  function exportCurrentAsFile() {
    const name = el.presetSaveName.value.trim() || 'huidige';
    const p = buildCurrentPreset(name);
    downloadJson(`kwadrantenpoll-preset-${slug(name)}.json`, p);
  }

  async function importPresetFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const txt = await f.text();
      const data = JSON.parse(txt);
      if (!data || typeof data !== 'object') throw new Error('Ongeldig bestand');
      if (!data.name) data.name = f.name.replace(/\.json$/i, '');
      if (!Array.isArray(data.questions)) throw new Error('Ontbrekende vragen');
      const arr = loadPresets();
      arr.push({
        name: String(data.name).slice(0, 60),
        savedAt: Date.now(),
        config: data.config || DEFAULT_CONFIG,
        questions: data.questions.map(q => typeof q === 'string' ? q : q?.text).filter(Boolean).slice(0, 100)
      });
      savePresets(arr);
      renderPresetList();
      alert(`Preset "${data.name}" geïmporteerd.`);
    } catch (err) {
      alert('Kon bestand niet importeren: ' + err.message);
    } finally {
      e.target.value = '';
    }
  }

  function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'preset';
  }
})();
