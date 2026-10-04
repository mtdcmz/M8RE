/* M8 Graphics - Canvas2D port of flash.display.Graphics
 * Command recording + deferred replay (ruffle Drawing semantics: mark_dirty
 * per op; Ticker replays once per frame; open paths get implicit close+fill
 * so scripts that skip endFill() still render).
 * Supported: beginFill/beginGradientFill/endFill/lineStyle/moveTo/lineTo/
 * curveTo/drawRect/drawRoundRect/drawCircle/drawEllipse/drawPath/clear/copyFrom
 */
(function (global) {
  "use strict";
  const M8 = global.M8RE;

  // dirty graphics flushed once per frame by Ticker (no per-op replay)
  M8._dirtyGraphics = new Set();

  function colorToCss(c, alpha) {
    c = Number(c) >>> 0;
    if (c > 0xFFFFFF) c = c & 0xFFFFFF;
    const r = (c >> 16) & 0xff, g = (c >> 8) & 0xff, b = c & 0xff;
    if (alpha !== undefined) return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }

  class Graphics {
    constructor(shape) {
      this._shape = shape;        // host M8Shape (provides canvas el)
      this._cmds = [];
      this._dirty = false;        // set on any command change
      this._bounds = null;        // {minX, minY, maxX, maxY}
      this._lineW = 0;
      this._fillActive = false;   // inside beginFill..endFill (affects lineTo bounds)
    }

    _markDirty() {
      this._dirty = true;
      if (this._shape) M8._dirtyGraphics.add(this);
    }

    _expand(x, y, r) {
      r = r || 0;
      if (!this._bounds) {
        this._bounds = { minX: x - r, minY: y - r, maxX: x + r, maxY: y + r };
      } else {
        if (x - r < this._bounds.minX) this._bounds.minX = x - r;
        if (y - r < this._bounds.minY) this._bounds.minY = y - r;
        if (x + r > this._bounds.maxX) this._bounds.maxX = x + r;
        if (y + r > this._bounds.maxY) this._bounds.maxY = y + r;
      }
      this._markDirty();
    }

    // ---- draw ops ----
    beginFill(color, alpha) {
      color = (color === undefined) ? 0 : color;
      alpha = (alpha === undefined) ? 1 : alpha;
      this._cmds.push({ t: 'bf', color: color, alpha: alpha });
      this._fillActive = true;
      this._markDirty();
    }

    beginGradientFill(type, colors, alphas, ratios, matrix) {
      this._cmds.push({ t: 'bgf', type: type || 'linear', colors: colors || [], alphas: alphas || [], ratios: ratios || [], matrix: matrix || null });
      this._fillActive = true;
      this._markDirty();
    }

    endFill() {
      this._cmds.push({ t: 'ef' });
      this._fillActive = false;
      this._markDirty();
    }

    lineStyle(thickness, color, alpha, pixelHinting, scaleMode, caps, joints, miterLimit) {
      if (thickness === undefined || thickness === null || isNaN(Number(thickness))) {
        this._cmds.push({ t: 'ls', off: true });
        return;
      }
      this._lineW = Number(thickness);
      this._cmds.push({
        t: 'ls', off: false, thickness: Number(thickness),
        color: (color === undefined) ? 0 : color,
        alpha: (alpha === undefined) ? 1 : alpha,
        caps: caps || null, joints: joints || null, miterLimit: miterLimit || 3
      });
      this._markDirty();
    }

    moveTo(x, y) {
      this._cmds.push({ t: 'mt', x: x, y: y });
      // Flash: bounds only grow for visible output (stroke or fill active)
      // plain lineTo/moveTo with no stroke/fill adds no pixels
      // e.g. Duet collide_checking draws with no stroke/fill:
      // bounds stay fixed, canvas never grows unbounded
      if (this._lineW > 0 || this._fillActive) this._expand(x, y, this._lineW ? this._lineW / 2 : 0);
    }

    lineTo(x, y) {
      this._cmds.push({ t: 'lt', x: x, y: y });
      if (this._lineW > 0 || this._fillActive) this._expand(x, y, this._lineW ? this._lineW / 2 : 0);
    }

    curveTo(cx, cy, x, y) {
      this._cmds.push({ t: 'ct', cx: cx, cy: cy, x: x, y: y });
      if (this._lineW > 0 || this._fillActive) {
        this._expand(cx, cy, this._lineW ? this._lineW / 2 : 0);
        this._expand(x, y, this._lineW ? this._lineW / 2 : 0);
      }
    }

    drawRect(x, y, w, h) {
      this._cmds.push({ t: 'dr', x: x, y: y, w: w, h: h });
      this._expand(x, y, this._lineW ? this._lineW / 2 : 0);
      this._expand(x + w, y + h, this._lineW ? this._lineW / 2 : 0);
    }

    drawRoundRect(x, y, w, h, ew, eh) {
      eh = (eh === undefined) ? ew : eh;
      this._cmds.push({ t: 'drr', x: x, y: y, w: w, h: h, ew: ew, eh: eh });
      this._expand(x, y, this._lineW ? this._lineW / 2 : 0);
      this._expand(x + w, y + h, this._lineW ? this._lineW / 2 : 0);
    }

    drawCircle(x, y, r) {
      this._cmds.push({ t: 'dc', x: x, y: y, r: r });
      this._expand(x, y, r + (this._lineW ? this._lineW / 2 : 0));
    }

    drawEllipse(x, y, w, h) {
      this._cmds.push({ t: 'de', x: x, y: y, w: w, h: h });
      this._expand(x, y, this._lineW ? this._lineW / 2 : 0);
      this._expand(x + w, y + h, this._lineW ? this._lineW / 2 : 0);
    }

    // Flash Graphics.drawPath(commands:Vector.<int>, data:Vector.<Number>, winding:String)
    // commands: 0=NO_OP 1=MOVE_TO 2=LINE_TO 3=CURVE_TO 4=WIDE_MOVE_TO 5=WIDE_LINE_TO
    // winding: "evenOdd" (default) / "nonZero"
    drawPath(commands, data, winding) {
      const cmds = commands || [];
      const d = data || [];
      this._cmds.push({ t: 'dp', commands: Array.from(cmds), data: Array.from(d), winding: winding || 'evenOdd' });
      // bounds: walk coordinates by command width
      let p = 0;
      for (let i = 0; i < cmds.length; i++) {
        const c = Number(cmds[i]) | 0;
        let step = 0, count = 0;
        if (c === 1 || c === 2) { step = 0; count = 2; }
        else if (c === 3) { step = 0; count = 4; }
        else if (c === 4 || c === 5) { step = 2; count = 4; }
        if (count) {
          for (let k = step; k < count; k += 2) {
            const x = Number(d[p + k]), y = Number(d[p + k + 1]);
            if (isFinite(x) && isFinite(y)) {
              this._expand(x, y, this._lineW ? this._lineW / 2 : 0);
            }
          }
          p += count;
        }
      }
      this._markDirty();
    }

    clear() {
      this._cmds.length = 0;
      this._bounds = null;
      this._lineW = 0;
      this._fillActive = false;
      this._markDirty();
    }

    copyFrom(other) {
      this._cmds = other._cmds.slice();
      this._bounds = other._bounds ? Object.assign({}, other._bounds) : null;
      this._lineW = other._lineW || 0;
      this._markDirty();
    }

    // flush all dirty graphics once per frame (Ticker calls this)
    static flushAll() {
      const set = M8._dirtyGraphics;
      if (set.size === 0) return;
      const arr = Array.from(set);
      set.clear();
      for (const g of arr) {
        try { g._flush(); } catch (e) { /* skip broken graphic */ }
      }
    }

    // ---- replay to canvas (open paths get implicit close+fill) ----
    // The canvas top-left sits at the shape (x, y).
    // Draw ops may use negative coords (e.g. drawCircle(42,16,55) crosses x<0),
    // so the canvas covers the full bounds and drawing is shifted by (-minX, -minY).
    // Canvas pixel (0,0) then maps to local (minX, minY), not (0, 0).
    // The element is offset by (minX, minY) so local (lx,ly) lands at (x+lx, y+ly).
    // Otherwise shields render offset from the ship center.
    _flush() {
      const shape = this._shape;
      if (!shape) { this._dirty = false; return; }
      // M8Shape canvas lives in _canvasEl, not shape.el
      const el = shape._canvasEl || shape.el;
      if (!el) { this._dirty = false; return; }
      const b = this._bounds;
      if (!b) { el.width = 0; el.height = 0; shape._gfxOffX = 0; shape._gfxOffY = 0; shape._applyCanvasOffset(); this._dirty = false; return; }
      const minX = Math.floor(b.minX), minY = Math.floor(b.minY);
      const w = Math.max(1, Math.ceil(b.maxX) - minX);
      const h = Math.max(1, Math.ceil(b.maxY) - minY);
      if (el.width !== w) el.width = w;
      if (el.height !== h) el.height = h;
      const ctx = el.getContext('2d');
      if (!ctx) { this._dirty = false; return; }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.translate(-minX, -minY);

      // fillActive: inside a fill block (set by beginFill, cleared by endFill).
      // Flash: stroke-only paths fill nothing.
      // Old impl black-filled them, occluding ships/shields.
      let fillStyle = null;
      let fillActive = false;
      let strokeStyle = null;
      let pathOpen = false;
      const cmds = this._cmds;
      const n = cmds.length;
      for (let i = 0; i < n; i++) {
        const c = cmds[i];
        switch (c.t) {
          case 'bf':
            fillStyle = colorToCss(c.color, c.alpha);
            fillActive = true;
            ctx.beginPath();
            pathOpen = true;
            ctx._m8Winding = 'nonzero';
            break;
          case 'bgf': {
            const grad = Graphics._makeGradient(ctx, c);
            fillStyle = grad || '#000000';
            fillActive = true;
            ctx.beginPath();
            pathOpen = true;
            break;
          }
          case 'ef':
            if (pathOpen) {
              if (fillActive) {
                ctx.fillStyle = fillStyle;
                ctx.fill(ctx._m8Winding === 'evenodd' ? 'evenodd' : 'nonzero');
              }
              if (strokeStyle) {
                ctx.strokeStyle = strokeStyle.color;
                ctx.lineWidth = strokeStyle.thickness;
                ctx.stroke();
              }
              pathOpen = false;
              fillActive = false;
            }
            break;
          case 'ls':
            if (c.off) { strokeStyle = null; ctx.strokeStyle = 'rgba(0,0,0,0)'; }
            else {
              strokeStyle = { color: colorToCss(c.color, c.alpha), thickness: c.thickness };
              ctx.strokeStyle = strokeStyle.color;
              ctx.lineWidth = c.thickness;
              ctx.lineCap = c.caps === 'none' ? 'butt' : (c.caps === 'square' ? 'square' : 'round');
              ctx.lineJoin = c.joints === 'miter' ? 'miter' : (c.joints === 'bevel' ? 'bevel' : 'round');
              ctx.miterLimit = c.miterLimit || 3;
            }
            break;
          case 'mt':
            if (!pathOpen) { ctx.beginPath(); pathOpen = true; }
            ctx.moveTo(c.x, c.y);
            break;
          case 'lt':
            if (!pathOpen) { ctx.beginPath(); pathOpen = true; }
            ctx.lineTo(c.x, c.y);
            break;
          case 'ct':
            if (!pathOpen) { ctx.beginPath(); pathOpen = true; }
            ctx.quadraticCurveTo(c.cx, c.cy, c.x, c.y);
            break;
          case 'dr':
            if (!pathOpen) { ctx.beginPath(); pathOpen = true; }
            ctx.rect(c.x, c.y, c.w, c.h);
            break;
          case 'drr': {
            if (!pathOpen) { ctx.beginPath(); pathOpen = true; }
            const ew = Math.min(c.ew, c.w / 2), eh = Math.min(c.eh, c.h / 2);
            const x = c.x, y = c.y, w2 = c.w, h2 = c.h;
            ctx.moveTo(x + ew, y);
            ctx.lineTo(x + w2 - ew, y);
            ctx.quadraticCurveTo(x + w2, y, x + w2, y + eh);
            ctx.lineTo(x + w2, y + h2 - eh);
            ctx.quadraticCurveTo(x + w2, y + h2, x + w2 - ew, y + h2);
            ctx.lineTo(x + ew, y + h2);
            ctx.quadraticCurveTo(x, y + h2, x, y + h2 - eh);
            ctx.lineTo(x, y + eh);
            ctx.quadraticCurveTo(x, y, x + ew, y);
            ctx.closePath();
            break;
          }
          case 'dc':
            if (!pathOpen) { ctx.beginPath(); pathOpen = true; }
            ctx.arc(c.x, c.y, Math.max(0, c.r), 0, Math.PI * 2);
            ctx.closePath();
            break;
          case 'de':
            if (!pathOpen) { ctx.beginPath(); pathOpen = true; }
            ctx.ellipse(c.x + c.w / 2, c.y + c.h / 2, Math.max(0, c.w / 2), Math.max(0, c.h / 2), 0, 0, Math.PI * 2);
            ctx.closePath();
            break;
          case 'dp': {
            if (!pathOpen) { ctx.beginPath(); pathOpen = true; }
            const dcmds = c.commands, dd = c.data;
            let p = 0;
            for (let j = 0; j < dcmds.length; j++) {
              const cmd = dcmds[j] | 0;
              if (cmd === 1) { ctx.moveTo(dd[p], dd[p + 1]); p += 2; }
              else if (cmd === 2) { ctx.lineTo(dd[p], dd[p + 1]); p += 2; }
              else if (cmd === 3) { ctx.quadraticCurveTo(dd[p], dd[p + 1], dd[p + 2], dd[p + 3]); p += 4; }
              else if (cmd === 4) { ctx.moveTo(dd[p + 2], dd[p + 3]); p += 4; }
              else if (cmd === 5) { ctx.lineTo(dd[p + 2], dd[p + 3]); p += 4; }
            }
            ctx._m8Winding = (c.winding === 'evenOdd') ? 'evenodd' : 'nonzero';
            break;
          }
        }
      }
      // ruffle: open paths get implicit close+fill at end of replay
      // but only when a fill is active; stroke-only paths stay transparent
      if (pathOpen) {
        if (fillActive) {
          ctx.fillStyle = fillStyle;
          ctx.fill(ctx._m8Winding === 'evenodd' ? 'evenodd' : 'nonzero');
        }
        if (strokeStyle) {
          ctx.strokeStyle = strokeStyle.color;
          ctx.lineWidth = strokeStyle.thickness;
          ctx.stroke();
        }
      }
      // store bounds offset for canvas correction (container/children unaffected)
      if (shape._gfxOffX !== minX || shape._gfxOffY !== minY) {
        shape._gfxOffX = minX;
        shape._gfxOffY = minY;
        shape._applyCanvasOffset();
      }
      this._dirty = false;
    }

    static _makeGradient(ctx, c) {
      const n = c.colors.length;
      if (!n) return null;
      let grad;
      // Flash gradients: "linear" along matrix width, "radial" radial
      const m = c.matrix;
      if (c.type === 'radial') {
        grad = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(m ? m.width : 100, 1));
      } else {
        const w = m && m.width ? m.width : 100;
        const h = m && m.height ? m.height : 100;
        const rot = m && m.rotation ? m.rotation : 0;
        // rotation approximation: 0 or 90 degrees
        if (Math.abs(Math.abs(rot) - Math.PI / 2) < 0.01) {
          grad = ctx.createLinearGradient(0, 0, 0, h);
        } else {
          grad = ctx.createLinearGradient(0, 0, w, 0);
        }
      }
      for (let i = 0; i < n; i++) {
        const ratio = (c.ratios[i] === undefined ? (i / Math.max(1, n - 1)) * 255 : c.ratios[i]) / 255;
        const alpha = c.alphas[i] === undefined ? 1 : c.alphas[i];
        grad.addColorStop(Math.max(0, Math.min(1, ratio)), colorToCss(c.colors[i], alpha));
      }
      return grad;
    }
  }

  M8.Graphics = Graphics;
  M8.colorToCss = colorToCss;
})(typeof window !== 'undefined' ? window : globalThis);
