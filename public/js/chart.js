// QuadrantChart — gedeeld tussen deelnemer en admin
(function (global) {
  const NS = 'http://www.w3.org/2000/svg';
  const VB = 620;
  const PLOT = { x: 60, y: 60, w: 500, h: 500 };

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

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function mergeConfig(cfg) {
    const d = DEFAULT_CONFIG;
    if (!cfg) return structuredClone(d);
    return {
      axisX: { ...d.axisX, ...(cfg.axisX || {}) },
      axisY: { ...d.axisY, ...(cfg.axisY || {}) },
      quadrants: {
        tl: { ...d.quadrants.tl, ...(cfg.quadrants?.tl || {}) },
        tr: { ...d.quadrants.tr, ...(cfg.quadrants?.tr || {}) },
        bl: { ...d.quadrants.bl, ...(cfg.quadrants?.bl || {}) },
        br: { ...d.quadrants.br, ...(cfg.quadrants?.br || {}) }
      }
    };
  }

  class QuadrantChart {
    constructor(svg, opts = {}) {
      this.svg = svg;
      this.onSubmit = opts.onSubmit || null;
      this.interactive = !!opts.interactive;
      this.ownUserId = opts.ownUserId || null;
      this.blindMode = false;
      this.hoverLabelsOnly = false;
      this.positions = new Map();
      this.lastSubmit = 0;
      this._tooltipEl = null;
      this.zoom = 1;
      this._fsMode = false;
      this.config = mergeConfig(opts.config);
      this._build();
      this._createControls();
      this._bindInput(); // altijd binden; handlers gaten op this.interactive
      this._bindKeyboardAndWheel();
    }

    // --- zoom & fullscreen ---
    setZoom(z) {
      this.zoom = Math.max(0.4, Math.min(5, Number(z) || 1));
      const wrapper = this.svg.parentElement;
      if (!wrapper) return;
      if (Math.abs(this.zoom - 1) < 0.01) {
        this.zoom = 1;
        wrapper.style.width = '';
        wrapper.style.maxWidth = '';
        wrapper.style.maxHeight = '';
      } else {
        const parentEl = wrapper.parentElement;
        const parentAvail = parentEl ? parentEl.clientWidth - 20 : 500;
        const base = Math.min(720, Math.max(240, parentAvail));
        const size = Math.round(base * this.zoom);
        wrapper.style.width = `${size}px`;
        wrapper.style.maxWidth = 'none';
        wrapper.style.maxHeight = 'none';
      }
      // update zoom-badge tekst
      if (this._zoomBadge) this._zoomBadge.textContent = `${Math.round(this.zoom * 100)}%`;
    }

    toggleFullscreen(force) {
      const wrapper = this.svg.parentElement;
      if (!wrapper) return;
      const want = typeof force === 'boolean' ? force : !this._fsMode;
      this._fsMode = want;
      wrapper.classList.toggle('fs-mode', want);
      // in fs-mode: reset zoom zodat SVG de volledige wrapper vult
      if (want) {
        this._zoomBefore = this.zoom;
        this.setZoom(1);
      } else if (this._zoomBefore != null) {
        this.setZoom(this._zoomBefore);
        this._zoomBefore = null;
      }
      if (this._fsBtn) this._fsBtn.textContent = want ? '✕' : '⛶';
      if (this._fsBtn) this._fsBtn.title = want ? 'Sluit volledig scherm (Esc)' : 'Volledig scherm (F)';
    }

    _createControls() {
      const wrapper = this.svg.parentElement;
      if (!wrapper || wrapper.querySelector('.chart-zoom')) return;
      if (getComputedStyle(wrapper).position === 'static') wrapper.style.position = 'relative';
      const div = document.createElement('div');
      div.className = 'chart-zoom';
      div.innerHTML = `
        <button type="button" data-act="in" title="Inzoomen (+)">+</button>
        <button type="button" data-act="out" title="Uitzoomen (−)">−</button>
        <button type="button" data-act="reset" title="100% (0)"><span class="z-reset">100%</span></button>
        <button type="button" data-act="fs" title="Volledig scherm (F)">⛶</button>
      `;
      // geen positie-plaatsing via deze knoppen
      div.addEventListener('pointerdown', e => e.stopPropagation());
      div.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        e.stopPropagation();
        switch (btn.dataset.act) {
          case 'in':    this.setZoom(this.zoom * 1.25); break;
          case 'out':   this.setZoom(this.zoom / 1.25); break;
          case 'reset': this.setZoom(1); break;
          case 'fs':    this.toggleFullscreen(); break;
        }
      });
      wrapper.appendChild(div);
      this._zoomBadge = div.querySelector('.z-reset');
      this._fsBtn = div.querySelector('[data-act="fs"]');
    }

    _bindKeyboardAndWheel() {
      if (QuadrantChart._kbBoundChart === this) return;
      // Slechts 1 instantie bindt globale keyboard shortcuts — als er al een is, skippen we
      if (!QuadrantChart._kbBoundChart) {
        QuadrantChart._kbBoundChart = this;
        document.addEventListener('keydown', (e) => {
          const a = document.activeElement;
          if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
          const chart = QuadrantChart._kbBoundChart;
          if (!chart) return;
          if (e.key === '+' || (e.key === '=' && e.shiftKey)) { e.preventDefault(); chart.setZoom(chart.zoom * 1.25); }
          else if (e.key === '-' || e.key === '_') { e.preventDefault(); chart.setZoom(chart.zoom / 1.25); }
          else if (e.key === '0') { e.preventDefault(); chart.setZoom(1); }
          else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); chart.toggleFullscreen(); }
          else if (e.key === 'Escape' && chart._fsMode) { chart.toggleFullscreen(false); }
        });
      }
      // Ctrl+wheel zoom over de eigen svg
      this.svg.addEventListener('wheel', (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.1 : 1/1.1;
        this.setZoom(this.zoom * factor);
      }, { passive: false });
    }

    setConfig(cfg) {
      this.config = mergeConfig(cfg);
      this._redrawBase();
      this.render();
    }

    setOwnUserId(uid) { this.ownUserId = uid; this.render(); }
    setInteractive(v) { this.interactive = !!v; this.svg.classList.toggle('interactive', this.interactive); }
    setBlindMode(v) { this.blindMode = !!v; this.render(); }
    setHoverLabelsOnly(v) { this.hoverLabelsOnly = !!v; this.render(); }

    setPositions(arr) {
      this.positions = new Map();
      for (const p of arr || []) this.positions.set(p.userId, { ...p });
      this.render();
    }

    upsertPosition(p) {
      this.positions.set(p.userId, { ...p });
      this.render();
    }

    clearPositions() {
      this.positions = new Map();
      this.render();
    }

    _build() {
      this.svg.setAttribute('viewBox', `0 0 ${VB} ${VB}`);
      this.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      this.svg.classList.add('quadrant-chart');
      if (this.interactive) this.svg.classList.add('interactive');
      this.svg.innerHTML = this._baseSVG();
      this.layer = document.createElementNS(NS, 'g');
      this.layer.setAttribute('class', 'positions-layer');
      this.svg.appendChild(this.layer);
    }

    _redrawBase() {
      // reset alles en teken opnieuw (base + layer)
      this.svg.innerHTML = this._baseSVG();
      this.layer = document.createElementNS(NS, 'g');
      this.layer.setAttribute('class', 'positions-layer');
      this.svg.appendChild(this.layer);
    }

    _baseSVG() {
      const { x, y, w, h } = PLOT;
      const cx = x + w / 2, cy = y + h / 2;
      const parts = [];

      const cfg = this.config;
      // kwadrant-achtergronden met configureerbare kleuren
      parts.push(`<rect x="${x}"  y="${y}"  width="${w/2}" height="${h/2}" fill="${cfg.quadrants.tl.color}"/>`);
      parts.push(`<rect x="${cx}" y="${y}"  width="${w/2}" height="${h/2}" fill="${cfg.quadrants.tr.color}"/>`);
      parts.push(`<rect x="${x}"  y="${cy}" width="${w/2}" height="${h/2}" fill="${cfg.quadrants.bl.color}"/>`);
      parts.push(`<rect x="${cx}" y="${cy}" width="${w/2}" height="${h/2}" fill="${cfg.quadrants.br.color}"/>`);

      // grid 100×100 — gelaagde opacity: per 1 heel subtiel, per 5 lichter, per 10 middel, per 25 donker
      for (let i = 1; i < 100; i++) {
        let col, sw;
        if (i % 25 === 0)      { col = 'rgba(0,0,0,0.22)'; sw = 1; }
        else if (i % 10 === 0) { col = 'rgba(0,0,0,0.12)'; sw = 1; }
        else if (i % 5 === 0)  { col = 'rgba(0,0,0,0.06)'; sw = 0.8; }
        else                   { col = 'rgba(0,0,0,0.025)'; sw = 0.5; }
        const gx = x + (i / 100) * w;
        const gy = y + h - (i / 100) * h;
        parts.push(`<line x1="${gx}" y1="${y}" x2="${gx}" y2="${y+h}" stroke="${col}" stroke-width="${sw}"/>`);
        parts.push(`<line x1="${x}" y1="${gy}" x2="${x+w}" y2="${gy}" stroke="${col}" stroke-width="${sw}"/>`);
      }

      // Pijl-marker voor de kruis-assen (werkt aan beide uiteinden via auto-start-reverse)
      parts.push(`<defs>
        <marker id="axArrow" viewBox="0 -6 12 12" refX="10" refY="0"
                markerUnits="userSpaceOnUse" markerWidth="14" markerHeight="14"
                orient="auto-start-reverse">
          <path d="M0,-6 L12,0 L0,6 z" fill="#222"/>
        </marker>
      </defs>`);

      // KRUIS-ASSEN (lopen iets voorbij het kwadrantenvlak, met pijlen op beide uiteinden)
      const EXT = 14;
      const axStroke = '#222', axSW = 2;
      parts.push(`<line x1="${x - EXT}" y1="${cy}" x2="${x + w + EXT}" y2="${cy}" stroke="${axStroke}" stroke-width="${axSW}" marker-start="url(#axArrow)" marker-end="url(#axArrow)"/>`);
      parts.push(`<line x1="${cx}" y1="${y - EXT}" x2="${cx}" y2="${y + h + EXT}" stroke="${axStroke}" stroke-width="${axSW}" marker-start="url(#axArrow)" marker-end="url(#axArrow)"/>`);

      // Kwadrant-tekstlabels (subtiel, in de 4 hoeken van het gekleurde vlak)
      const qText = (tx, ty, text, anchor) => `
        <text x="${tx}" y="${ty}" text-anchor="${anchor}" font-size="13" font-weight="700" fill="#333" opacity="0.72">${esc(text)}</text>`;
      parts.push(qText(x + 10,     y + 22,     cfg.quadrants.tl.text, 'start'));
      parts.push(qText(x + w - 10, y + 22,     cfg.quadrants.tr.text, 'end'));
      parts.push(qText(x + 10,     y + h - 10, cfg.quadrants.bl.text, 'start'));
      parts.push(qText(x + w - 10, y + h - 10, cfg.quadrants.br.text, 'end'));

      // Eind-labels bij elke pijlpunt (Hoog/Laag + configureerbare termen)
      const endLabel = (tx, ty, text, anchor) =>
        `<text x="${tx}" y="${ty}" text-anchor="${anchor}" font-size="13" font-weight="600" fill="#333" stroke="white" stroke-width="3" paint-order="stroke">${esc(text)}</text>`;
      // X-as eindlabels (links = low, rechts = high)
      parts.push(endLabel(x - EXT - 6,       cy + 5,                  cfg.axisX.low,  'end'));
      parts.push(endLabel(x + w + EXT + 6,   cy + 5,                  cfg.axisX.high, 'start'));
      // Y-as eindlabels (boven = high, onder = low)
      parts.push(endLabel(cx,                y - EXT - 6,             cfg.axisY.high, 'middle'));
      parts.push(endLabel(cx,                y + h + EXT + 16,        cfg.axisY.low,  'middle'));

      // Astitels OP de as zelf — verschoven van kruispunt naar rechter-/bovenhelft
      // X-as titel: boven de horizontale as in de rechterhelft
      parts.push(`<text x="${cx + w * 0.22}" y="${cy - 10}" text-anchor="middle" font-size="18" font-weight="700" fill="#111" stroke="white" stroke-width="6" paint-order="stroke">${esc(cfg.axisX.title)}</text>`);
      // Y-as titel: gedraaid langs de verticale as in de bovenhelft
      parts.push(`<text transform="translate(${cx - 10}, ${cy - h * 0.22}) rotate(-90)" text-anchor="middle" font-size="18" font-weight="700" fill="#111" stroke="white" stroke-width="6" paint-order="stroke">${esc(cfg.axisY.title)}</text>`);

      return parts.join('');
    }

    toPlot(x, y) {
      return {
        px: PLOT.x + (x / 100) * PLOT.w,
        py: PLOT.y + PLOT.h - (y / 100) * PLOT.h
      };
    }

    toValue(px, py) {
      return {
        x: Math.max(0, Math.min(100, ((px - PLOT.x) / PLOT.w) * 100)),
        y: Math.max(0, Math.min(100, ((PLOT.y + PLOT.h - py) / PLOT.h) * 100))
      };
    }

    _placeLabel(text, px, py, usedRects) {
      const approxW = Math.max(28, text.length * 7 + 6);
      const approxH = 16;
      const candidates = [
        { dx: 14, dy: 5, anchor: 'start' },
        { dx: -14, dy: 5, anchor: 'end' },
        { dx: 14, dy: -12, anchor: 'start' },
        { dx: -14, dy: -12, anchor: 'end' },
        { dx: 14, dy: 20, anchor: 'start' },
        { dx: -14, dy: 20, anchor: 'end' },
        { dx: 0, dy: -16, anchor: 'middle' },
        { dx: 0, dy: 24, anchor: 'middle' }
      ];
      for (const c of candidates) {
        const x = px + c.dx, y = py + c.dy;
        const rx1 = c.anchor === 'end' ? x - approxW : (c.anchor === 'middle' ? x - approxW / 2 : x);
        const rect = { x1: rx1 - 2, y1: y - 13, x2: rx1 + approxW + 2, y2: y + 3 };
        if (rect.x1 < PLOT.x + 2 || rect.x2 > PLOT.x + PLOT.w - 2) continue;
        if (rect.y1 < PLOT.y + 2 || rect.y2 > PLOT.y + PLOT.h - 2) continue;
        const collide = usedRects.some(r => !(rect.x2 < r.x1 || rect.x1 > r.x2 || rect.y2 < r.y1 || rect.y1 > r.y2));
        if (!collide) {
          usedRects.push(rect);
          return { x, y, anchor: c.anchor };
        }
      }
      return null;
    }

    render() {
      if (!this.layer) return;
      this.layer.innerHTML = '';
      const usedRects = [];

      // Sorteer: eigen stip laatst (bovenop); grotere y onderop zodat labels niet boven elkaar proppen
      const entries = Array.from(this.positions.values()).sort((a, b) => {
        const ao = a.userId === this.ownUserId ? 1 : 0;
        const bo = b.userId === this.ownUserId ? 1 : 0;
        if (ao !== bo) return ao - bo;
        return (b.y ?? 0) - (a.y ?? 0);
      });

      const showLabels = !this.blindMode && !this.hoverLabelsOnly;

      for (const p of entries) {
        const { px, py } = this.toPlot(p.x, p.y);
        const isOwn = p.userId === this.ownUserId;
        const g = document.createElementNS(NS, 'g');
        g.setAttribute('class', 'dot-group' + (isOwn ? ' own' : ''));
        g.dataset.userId = p.userId;

        if (isOwn) {
          const pulse = document.createElementNS(NS, 'circle');
          pulse.setAttribute('cx', px);
          pulse.setAttribute('cy', py);
          pulse.setAttribute('r', 11);
          pulse.setAttribute('fill', 'none');
          pulse.setAttribute('stroke', p.color);
          pulse.setAttribute('stroke-width', 2.5);
          pulse.setAttribute('class', 'pulse');
          g.appendChild(pulse);
        }

        const dot = document.createElementNS(NS, 'circle');
        dot.setAttribute('cx', px);
        dot.setAttribute('cy', py);
        dot.setAttribute('r', isOwn ? 10 : 8);
        dot.setAttribute('fill', p.color);
        dot.setAttribute('stroke', 'white');
        dot.setAttribute('stroke-width', isOwn ? 3 : 2);
        dot.setAttribute('class', 'dot');
        g.appendChild(dot);

        // tooltip (SVG title = desktop hover). Mobiel: via pointerdown handler hierna.
        const title = document.createElementNS(NS, 'title');
        const labelText = this.blindMode && !isOwn ? 'Anoniem' : (p.name || '');
        title.textContent = `${labelText} — ${this.config.axisX.title}: ${Math.round(p.x)}, ${this.config.axisY.title}: ${Math.round(p.y)}`;
        g.appendChild(title);

        // label
        const shouldLabel = showLabels || isOwn;
        if (shouldLabel && !(this.blindMode && !isOwn)) {
          const spot = this._placeLabel(p.name || '', px, py, usedRects);
          if (spot) {
            const t = document.createElementNS(NS, 'text');
            t.setAttribute('x', spot.x);
            t.setAttribute('y', spot.y);
            t.setAttribute('text-anchor', spot.anchor);
            t.setAttribute('font-size', '12');
            t.setAttribute('font-weight', isOwn ? '700' : '600');
            t.setAttribute('fill', '#111');
            t.setAttribute('stroke', 'white');
            t.setAttribute('stroke-width', '3.5');
            t.setAttribute('paint-order', 'stroke');
            t.setAttribute('class', 'dot-label');
            t.textContent = p.name || '';
            g.appendChild(t);
          }
        }

        // tap/hover tooltip via floating div
        g.addEventListener('pointerenter', (e) => this._showTooltip(p, e));
        g.addEventListener('pointerleave', () => this._hideTooltip());
        g.addEventListener('click', (e) => {
          // Eigen dot: geen tap tooltip (in plaatsingsmodus wil user klikken om te positioneren)
          if (!this.interactive) this._showTooltip(p, e, 1600);
        });

        this.layer.appendChild(g);
      }
    }

    _showTooltip(p, evt, autoHideMs = 0) {
      this._ensureTooltip();
      const rect = this.svg.getBoundingClientRect();
      const name = this.blindMode && p.userId !== this.ownUserId ? 'Anoniem' : (p.name || '');
      this._tooltipEl.textContent = `${name} • ${this.config.axisX.title}: ${Math.round(p.x)} • ${this.config.axisY.title}: ${Math.round(p.y)}`;
      this._tooltipEl.style.left = `${evt.clientX - rect.left + 12}px`;
      this._tooltipEl.style.top = `${evt.clientY - rect.top + 12}px`;
      this._tooltipEl.classList.add('show');
      if (autoHideMs) {
        clearTimeout(this._tooltipTimer);
        this._tooltipTimer = setTimeout(() => this._hideTooltip(), autoHideMs);
      }
    }

    _hideTooltip() {
      if (this._tooltipEl) this._tooltipEl.classList.remove('show');
    }

    _ensureTooltip() {
      if (this._tooltipEl) return;
      const parent = this.svg.parentElement;
      if (!parent) return;
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      const t = document.createElement('div');
      t.className = 'chart-tooltip';
      parent.appendChild(t);
      this._tooltipEl = t;
    }

    _clientToSvg(clientX, clientY) {
      const rect = this.svg.getBoundingClientRect();
      const sx = (clientX - rect.left) / rect.width;
      const sy = (clientY - rect.top) / rect.height;
      return { vx: sx * VB, vy: sy * VB };
    }

    _bindInput() {
      let dragging = false;
      const submit = (clientX, clientY, final) => {
        if (!this.interactive) return;
        const { vx, vy } = this._clientToSvg(clientX, clientY);
        if (vx < PLOT.x || vx > PLOT.x + PLOT.w || vy < PLOT.y || vy > PLOT.y + PLOT.h) return;
        const { x, y } = this.toValue(vx, vy);
        const now = Date.now();
        if (!final && now - this.lastSubmit < 80) return;
        this.lastSubmit = now;
        this.onSubmit?.(x, y, final);
      };
      this.svg.addEventListener('pointerdown', (e) => {
        if (!this.interactive) return;
        dragging = true;
        try { this.svg.setPointerCapture(e.pointerId); } catch {}
        submit(e.clientX, e.clientY, false);
      });
      this.svg.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        submit(e.clientX, e.clientY, false);
      });
      const endDrag = (e) => {
        if (!dragging) return;
        dragging = false;
        submit(e.clientX, e.clientY, true);
      };
      this.svg.addEventListener('pointerup', endDrag);
      this.svg.addEventListener('pointercancel', endDrag);
    }

    exportPNG(filename = 'kwadranten.png') {
      // Clone SVG met inline styles
      const clone = this.svg.cloneNode(true);
      clone.setAttribute('xmlns', NS);
      clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
      const xml = new XMLSerializer().serializeToString(clone);
      const svg64 = btoa(unescape(encodeURIComponent(xml)));
      const url = `data:image/svg+xml;base64,${svg64}`;
      const img = new Image();
      img.onload = () => {
        const scale = 2;
        const c = document.createElement('canvas');
        c.width = VB * scale;
        c.height = VB * scale;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        c.toBlob((blob) => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        }, 'image/png');
      };
      img.onerror = (e) => console.error('PNG export faalde', e);
      img.src = url;
    }
  }

  global.QuadrantChart = QuadrantChart;
})(window);
