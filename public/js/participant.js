(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const el = {
    codeScreen:    $('#codeScreen'),
    codeInput:     $('#codeInput'),
    codeNext:      $('#codeNext'),
    codeError:     $('#codeError'),
    nameScreen:    $('#nameScreen'),
    nameInput:     $('#nameInput'),
    nameSubmit:    $('#nameSubmit'),
    nameBack:      $('#nameBack'),
    nameError:     $('#nameError'),
    mainApp:       $('#mainApp'),
    topCode:       $('#topCode'),
    participantCount: $('#participantCount'),
    hoverToggle:   $('#hoverToggle'),
    questionList:  $('#questionList'),
    qBarLabel:     $('#qBarLabel'),
    qBarText:      $('#qBarText'),
    questionBar:   $('#questionBar'),
    reviewBanner:  $('#reviewBanner'),
    backToActive:  $('#backToActive'),
    chartSvg:      $('#chart'),
    waitingScreen: $('#waitingScreen'),
    openSidebar:   $('#openSidebar'),
    closeSidebar:  $('#closeSidebar'),
    sidebar:       $('#sidebar'),
    sidebarBackdrop: $('#sidebarBackdrop'),
    newQuestionToast: $('#newQuestionToast')
  };

  // ---------- state ----------
  const state = {
    code: null,
    userId: localStorage.getItem('kp.userId') || null,
    name: localStorage.getItem('kp.name') || '',
    color: null,
    participants: new Map(),
    questions: new Map(),      // id -> { id, text, status, positions: Map<uid,{x,y}>, responseCount }
    activeQuestionId: null,
    viewedQuestionId: null,
    blindMode: false,
    socket: null,
    chart: null,
    hoverLabelsOnly: false,
    config: null
  };

  // ---------- utils ----------
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function setError(node, msg) { node.textContent = msg || ''; }

  // ---------- flow: code entry ----------
  (function initCodeScreen() {
    const params = new URLSearchParams(location.search);
    const preCode = (params.get('code') || '').trim();
    if (/^\d{4}$/.test(preCode)) el.codeInput.value = preCode;
    el.codeInput.focus();
    el.codeInput.addEventListener('input', () => {
      el.codeInput.value = el.codeInput.value.replace(/\D/g, '').slice(0, 4);
      setError(el.codeError, '');
    });
    el.codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') el.codeNext.click();
    });
    el.codeNext.addEventListener('click', async () => {
      const code = el.codeInput.value.trim();
      if (!/^\d{4}$/.test(code)) return setError(el.codeError, 'Ongeldige code — geef 4 cijfers.');
      try {
        const r = await fetch(`/api/session/${code}/exists`).then(r => r.json());
        if (!r.exists) return setError(el.codeError, 'Geen sessie met deze code.');
      } catch (e) {
        return setError(el.codeError, 'Verbindingsfout — probeer opnieuw.');
      }
      state.code = code;
      el.codeScreen.style.display = 'none';
      el.nameScreen.style.display = 'flex';
      el.nameInput.value = state.name || '';
      el.nameInput.focus();
      if (state.name) el.nameInput.select();
    });
  })();

  // ---------- flow: name entry ----------
  el.nameBack.addEventListener('click', () => {
    el.nameScreen.style.display = 'none';
    el.codeScreen.style.display = 'flex';
    el.codeInput.focus();
  });
  el.nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el.nameSubmit.click();
  });
  el.nameSubmit.addEventListener('click', () => {
    const name = el.nameInput.value.trim();
    if (!name) return setError(el.nameError, 'Naam is verplicht.');
    if (name.length > 30) return setError(el.nameError, 'Max 30 tekens.');
    state.name = name;
    localStorage.setItem('kp.name', name);
    connect();
  });

  // ---------- socket connect & join ----------
  function connect() {
    const sock = io();
    state.socket = sock;

    sock.on('connect', () => {
      sock.emit('join-session', {
        code: state.code,
        name: state.name,
        userId: state.userId
      }, (ack) => {
        if (!ack?.ok) {
          const msg = ({
            INVALID_CODE: 'Ongeldige sessiecode.',
            SESSION_NOT_FOUND: 'Geen sessie met deze code.',
            INVALID_NAME: 'Ongeldige naam.',
            SESSION_FULL: 'Sessie zit vol.'
          })[ack?.error] || 'Fout bij aanmelden.';
          setError(el.nameError, msg);
          sock.disconnect();
          return;
        }
        state.userId = ack.userId;
        state.color = ack.color;
        localStorage.setItem('kp.userId', ack.userId);
        onJoined();
      });
    });

    sock.on('session-state', (data) => {
      state.activeQuestionId = data.activeQuestionId;
      state.blindMode = !!data.blindMode;
      state.participants = new Map(data.participants.map(p => [p.id, p]));
      state.config = data.config || null;
      updateParticipantCount();
      state.chart?.setBlindMode(state.blindMode);
      if (state.config) state.chart?.setConfig(state.config);
    });

    sock.on('config-changed', ({ config }) => {
      state.config = config;
      state.chart?.setConfig(config);
    });

    sock.on('questions-updated', ({ questions: qs }) => {
      // vervang de lokale lijst met gelanceerde vragen (behoud posities uit lokale cache waar mogelijk)
      const newMap = new Map();
      for (const q of qs) {
        const prev = state.questions.get(q.id);
        newMap.set(q.id, {
          id: q.id, text: q.text, status: q.status,
          launchedAt: q.launchedAt,
          responseCount: q.responseCount,
          positions: new Map((q.positions || []).map(p => [p.userId, p]))
        });
      }
      state.questions = newMap;
      // als de huidige viewedQuestionId niet meer bestaat, reset
      if (state.viewedQuestionId != null && !state.questions.has(state.viewedQuestionId)) {
        state.viewedQuestionId = state.activeQuestionId ?? null;
      }
      renderSidebar();
      renderMain();
    });

    sock.on('question-history', (data) => {
      for (const q of data.questions || []) {
        state.questions.set(q.id, {
          id: q.id, text: q.text, status: q.status,
          launchedAt: q.launchedAt,
          responseCount: q.responseCount,
          positions: new Map(q.positions.map(p => [p.userId, p]))
        });
      }
      if (state.activeQuestionId != null) {
        state.viewedQuestionId = state.activeQuestionId;
      } else {
        const closed = Array.from(state.questions.values())
          .filter(q => q.status === 'closed')
          .sort((a, b) => (b.launchedAt || 0) - (a.launchedAt || 0))[0];
        state.viewedQuestionId = closed ? closed.id : null;
      }
      renderSidebar();
      renderMain();
    });

    sock.on('position-update', ({ questionId, userId, name, color, x, y, timestamp }) => {
      let q = state.questions.get(questionId);
      if (!q) return;
      const existed = q.positions.has(userId);
      q.positions.set(userId, { userId, name, color, x, y, timestamp });
      if (!existed) q.responseCount = q.positions.size;
      // Render als deze vraag getoond wordt
      if (state.viewedQuestionId === questionId) {
        state.chart?.upsertPosition({ userId, name, color, x, y });
      }
      if (!state.participants.has(userId)) {
        state.participants.set(userId, { id: userId, name, color, connected: true });
      }
      updateParticipantCount();
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
      // sluit eventueel andere actieve lokaal
      for (const other of state.questions.values()) {
        if (other.id !== questionId && other.status === 'active') other.status = 'closed';
      }
      const wasInReview = state.viewedQuestionId != null && state.viewedQuestionId !== state.activeQuestionId;
      state.activeQuestionId = questionId;
      if (wasInReview) {
        showNewQuestionToast();
      } else {
        state.viewedQuestionId = questionId;
      }
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
      // andere actieve worden gesloten (zal via question-closed event komen)
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
      state.chart?.setBlindMode(state.blindMode);
    });

    sock.on('participant-joined', ({ userId, name, color, connected }) => {
      state.participants.set(userId, { id: userId, name, color, connected });
      updateParticipantCount();
    });
    sock.on('participant-left', ({ userId }) => {
      const p = state.participants.get(userId);
      if (p) p.connected = false;
      updateParticipantCount();
    });

    sock.on('disconnect', () => {
      // UI blijft maar laat niets meer pushen
    });
  }

  // ---------- UI wiring on joined ----------
  function onJoined() {
    el.codeScreen.style.display = 'none';
    el.nameScreen.style.display = 'none';
    el.mainApp.style.display = 'grid';
    el.topCode.textContent = state.code;

    state.chart = new QuadrantChart(el.chartSvg, {
      interactive: false,
      ownUserId: state.userId,
      config: state.config || null,
      onSubmit: (x, y, final) => {
        if (state.viewedQuestionId !== state.activeQuestionId) return;
        if (state.activeQuestionId == null) return;
        state.socket.emit('submit-position', {
          questionId: state.activeQuestionId,
          x, y
        });
      }
    });
    renderMain();

    el.openSidebar.addEventListener('click', openSidebar);
    el.closeSidebar.addEventListener('click', closeSidebar);
    el.sidebarBackdrop.addEventListener('click', closeSidebar);
    el.backToActive.addEventListener('click', () => {
      if (state.activeQuestionId != null) {
        state.viewedQuestionId = state.activeQuestionId;
        renderSidebar();
        renderMain();
        hideNewQuestionToast();
      }
    });
    el.newQuestionToast.addEventListener('click', () => {
      if (state.activeQuestionId != null) {
        state.viewedQuestionId = state.activeQuestionId;
        renderSidebar();
        renderMain();
        hideNewQuestionToast();
      }
    });
    el.hoverToggle.addEventListener('click', () => {
      state.hoverLabelsOnly = !state.hoverLabelsOnly;
      el.hoverToggle.style.opacity = state.hoverLabelsOnly ? '1' : '0.55';
      state.chart.setHoverLabelsOnly(state.hoverLabelsOnly);
    });
  }

  function openSidebar() { el.sidebar.classList.add('open'); el.sidebarBackdrop.classList.add('show'); }
  function closeSidebar() { el.sidebar.classList.remove('open'); el.sidebarBackdrop.classList.remove('show'); }

  function updateParticipantCount() {
    // aantal geplaatst op huidige actieve vraag / totaal deelnemers
    const total = state.participants.size;
    let placed = 0;
    if (state.activeQuestionId != null) {
      const q = state.questions.get(state.activeQuestionId);
      placed = q ? q.positions.size : 0;
    }
    el.participantCount.textContent = `${placed} / ${total} geplaatst`;
    // hover toggle enkel tonen bij veel deelnemers
    el.hoverToggle.style.display = total >= 30 ? 'inline-block' : 'none';
    el.hoverToggle.style.opacity = state.hoverLabelsOnly ? '1' : '0.55';
  }

  // ---------- sidebar render ----------
  function renderSidebar() {
    const items = Array.from(state.questions.values())
      .filter(q => q.status !== 'pending')
      .sort((a, b) => (a.launchedAt || 0) - (b.launchedAt || 0) || a.id - b.id);
    el.questionList.innerHTML = '';
    for (const q of items) {
      const div = document.createElement('div');
      const viewing = q.id === state.viewedQuestionId;
      const active = q.status === 'active';
      div.className = 'q-item' + (viewing ? ' viewing' : '') + (active ? ' active-q' : '');
      div.innerHTML = `
        <div class="qnum">${q.id}</div>
        <div class="col">
          <div class="qtext">${esc(q.text)}</div>
          ${q.status === 'closed' ? `<div class="qcount">${q.responseCount} antwoorden</div>` : ''}
        </div>
        <div class="qstatus" title="${active ? 'Actief' : 'Gesloten'}">${active ? '🟢' : '🔒'}</div>
      `;
      div.addEventListener('click', () => {
        state.viewedQuestionId = q.id;
        if (q.id === state.activeQuestionId) hideNewQuestionToast();
        renderSidebar();
        renderMain();
        closeSidebar();
      });
      el.questionList.appendChild(div);
    }
  }

  // ---------- main render ----------
  function renderMain() {
    const hasAny = state.questions.size > 0 && Array.from(state.questions.values()).some(q => q.status !== 'pending');
    const q = state.viewedQuestionId != null ? state.questions.get(state.viewedQuestionId) : null;

    if (!hasAny || !q) {
      el.waitingScreen.style.display = 'flex';
      el.qBarLabel.textContent = 'Wachten…';
      el.qBarText.textContent = 'Wachten op de facilitator…';
      el.questionBar.classList.remove('closed');
      el.questionBar.classList.add('waiting');
      el.reviewBanner.style.display = 'none';
      state.chart?.setInteractive(false);
      state.chart?.setPositions([]);
      return;
    }

    el.waitingScreen.style.display = 'none';
    el.questionBar.classList.remove('waiting');
    const isActiveView = q.id === state.activeQuestionId && q.status === 'active';
    el.qBarLabel.textContent = isActiveView ? `Vraag ${q.id} • Actief` : `Vraag ${q.id} • Afgesloten`;
    el.qBarText.textContent = q.text;
    el.questionBar.classList.toggle('closed', !isActiveView);

    // review banner
    el.reviewBanner.style.display = isActiveView ? 'none' : 'flex';

    state.chart.setInteractive(isActiveView);
    const posArr = Array.from(q.positions.values()).map(p => ({
      userId: p.userId,
      name: p.name || (state.participants.get(p.userId)?.name) || '',
      color: p.color || (state.participants.get(p.userId)?.color) || '#888',
      x: p.x, y: p.y
    }));
    state.chart.setPositions(posArr);
    state.chart.setBlindMode(state.blindMode);
  }

  function showNewQuestionToast() {
    el.newQuestionToast.classList.remove('hide');
  }
  function hideNewQuestionToast() {
    el.newQuestionToast.classList.add('hide');
  }
})();
