// QuadrantChart — gedeeld tussen deelnemer en admin
(function (global) {
  const NS = 'http://www.w3.org/2000/svg';
  const VB = 600;
  const PLOT = { x: 60, y: 30, w: 520, h: 510 };

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
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
      this._build();
      this._bindInput(); // altijd binden; handlers gaten op this.interactive
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
      // Positions layer
      this.layer = document.createElementNS(NS, 'g');
      this.layer.setAttribute('class', 'positions-layer');
      this.svg.appendChild(this.layer);
    }

    _baseSVG() {
      const { x, y, w, h } = PLOT;
      const cx = x + w / 2, cy = y + h / 2;
      const parts = [];

      // kwadranten (4 achtergronden)
      parts.push(`<rect x="${x}" y="${y}" width="${w/2}" height="${h/2}" fill="#fde0e0"/>`);          // LT: hoog risico / laag meerwaarde — rood
      parts.push(`<rect x="${cx}" y="${y}" width="${w/2}" height="${h/2}" fill="#ffe8cc"/>`);         // RT: hoog risico / hoog meerwaarde — oranje
      parts.push(`<rect x="${x}" y="${cy}" width="${w/2}" height="${h/2}" fill="#ececec"/>`);         // LB: laag risico / laag meerwaarde — grijs
      parts.push(`<rect x="${cx}" y="${cy}" width="${w/2}" height="${h/2}" fill="#dcf1dc"/>`);        // RB: laag risico / hoog meerwaarde — groen

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

      // middenlijnen
      parts.push(`<line x1="${cx}" y1="${y}" x2="${cx}" y2="${y+h}" stroke="#666" stroke-width="2" stroke-dasharray="4 4"/>`);
      parts.push(`<line x1="${x}" y1="${cy}" x2="${x+w}" y2="${cy}" stroke="#666" stroke-width="2" stroke-dasharray="4 4"/>`);

      // buitenrand
      parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#222" stroke-width="2"/>`);

      // kwadrant-labels (subtiel, in hoeken)
      const q = (tx, ty, text, anchor, color) => `
        <text x="${tx}" y="${ty}" text-anchor="${anchor}" font-size="13" font-weight="700" fill="${color}" opacity="0.72">${esc(text)}</text>`;
      parts.push(q(x + 10,       y + 22,         'Hoog risico / Lage meerwaarde',  'start', '#8a2b2b'));
      parts.push(q(x + w - 10,   y + 22,         'Hoog risico / Hoge meerwaarde',  'end',   '#8a5a1d'));
      parts.push(q(x + 10,       y + h - 10,     'Laag risico / Lage meerwaarde',  'start', '#555'));
      parts.push(q(x + w - 10,   y + h - 10,     'Laag risico / Hoge meerwaarde',  'end',   '#2d6a2d'));

      // as-labels buiten plot
      // X-as
      parts.push(`<text x="${cx}" y="${VB - 14}" text-anchor="middle" font-size="17" font-weight="700" fill="#111">Pedagogische meerwaarde</text>`);
      parts.push(`<text x="${x}" y="${y + h + 22}" text-anchor="middle" font-size="13" fill="#333">Laag</text>`);
      parts.push(`<text x="${x + w}" y="${y + h + 22}" text-anchor="middle" font-size="13" fill="#333">Hoog</text>`);

      // Y-as
      parts.push(`<text transform="translate(18, ${cy}) rotate(-90)" text-anchor="middle" font-size="17" font-weight="700" fill="#111">Risico</text>`);
      parts.push(`<text x="${x - 6}" y="${y + 6}" text-anchor="end" font-size="13" fill="#333">Hoog</text>`);
      parts.push(`<text x="${x - 6}" y="${y + h}" text-anchor="end" font-size="13" fill="#333">Laag</text>`);

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
        title.textContent = `${labelText} — (${Math.round(p.x)}, ${Math.round(p.y)})`;
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
      this._tooltipEl.textContent = `${name} • (${Math.round(p.x)}, ${Math.round(p.y)})`;
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
