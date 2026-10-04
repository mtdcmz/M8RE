/* M8 display element layer - DOM port of Flash DisplayObject/TextField/Shape/Sprite/Bitmap
 * Coords: x/y = top-left (Flash semantics); transform = translate -> rotate3d -> scale
 * Events: enterFrame dispatched by the global Ticker at stage frame rate
 *
 * Performance design (AS3-aligned, avoids DOM forced layout):
 * - hitTestObject: pure AABB math, never getBoundingClientRect
 * - CommentField metrics: shared canvas measurement cache,
 *   invalidated on text/font/size/wordWrap change (Flash autoSize=LEFT)
 * - _applyTransform: dirty-checked, style written only on change
 * - transform.matrix3D / rotation / filters / blendMode: Flash equivalents
 */
(function (global) {
  "use strict";
  const M8 = global.M8RE;
  const colorToCss = M8.colorToCss;

  // All targets with enterFrame listeners (dispatched by the frame loop)
  // Removed from stage = removed from dispatch (Flash semantics)
  // Perf: iterate cached snapshot; rebuild on add/remove only
  M8._efTargets = new Set();
  M8._efTargetsArr = [];
  M8._efDirty = false;
  M8._efAdd = function (el) { M8._efTargets.add(el); M8._efDirty = true; };
  M8._efDel = function (el) { if (M8._efTargets.delete(el)) M8._efDirty = true; };
  M8._efSync = function () {
    if (M8._efDirty) { M8._efTargetsArr = Array.from(M8._efTargets); M8._efDirty = false; }
    return M8._efTargetsArr;
  };

  // DOM event names (addEventListener('click'...) binds to the underlying el)
  const DOM_EVENT_TYPES = {
    'click': 1, 'dblclick': 1, 'mousedown': 1, 'mouseup': 1, 'mousemove': 1,
    'mouseover': 1, 'mouseout': 1, 'mouseenter': 1, 'mouseleave': 1,
    'rollover': 1, 'rollout': 1, 'focus': 1, 'blur': 1, 'change': 1,
    'input': 1, 'touchstart': 1, 'touchend': 1, 'touchmove': 1
  };

  const FONT_FALLBACK = ', "Microsoft YaHei", SimHei, sans-serif';
  // Block-glyph font: Flash/GDI grid-fits block/box chars to the full em,
  // Chrome/DirectWrite use raw outlines (SimHei block is 0.94em + 0.02em bearing),
  // causing gaps/offsets in block-art (pixel pictures, room walls).
  // Measured: DengXian/Meiryo block covers ~0.99em with no side bearing.
  // @font-face + unicode-range redirects only those ranges; text keeps its font.
  let blockFontInjected = false;
  function ensureBlockFontFace() {
    if (blockFontInjected) return;
    blockFontInjected = true;
    try {
      const st = document.createElement('style');
      st.id = 'm8re-block-font';
      st.textContent =
        "@font-face{font-family:'M8REBlockFill';src:local('DengXian'),local('等线'),local('Meiryo'),local('MS Gothic');" +
        'unicode-range:U+2500-25FF,U+2588,U+2591-2593;}';
      (document.head || document.documentElement).appendChild(st);
    } catch (e) { }
  }
  function mapFont(f) {
    ensureBlockFontFace();
    // M8REBlockFill first: unicode-range limits it to block/box chars;
    // everything else falls back to the original font
    if (!f) return "'M8REBlockFill', \"SimHei\"" + FONT_FALLBACK;
    const s = String(f);
    if (s === '黑体') return "'M8REBlockFill', SimHei" + FONT_FALLBACK;
    if (s === '宋体') return "'M8REBlockFill', SimSun" + FONT_FALLBACK;
    if (s === '楷体') return "'M8REBlockFill', KaiTi, \"楷体\"" + FONT_FALLBACK;
    return "'M8REBlockFill', \"" + s + "\"" + FONT_FALLBACK;
  }

  // ---------------- shared text measurement canvas ----------------
  let measureCtx = null;
  function getMeasureCtx() {
    if (!measureCtx) {
      const c = document.createElement('canvas');
      c.width = 8; c.height = 8;
      measureCtx = c.getContext('2d');
    }
    return measureCtx;
  }

  // Flash blendMode -> CSS mix-blend-mode (common subset)
  const BLEND_MAP = {
    'add': 'plus-lighter', 'screen': 'screen', 'multiply': 'multiply',
    'overlay': 'overlay', 'lighten': 'lighten', 'darken': 'darken',
    'difference': 'difference', 'hardlight': 'hard-light', 'softlight': 'soft-light',
    'invert': 'difference', 'alpha': 'normal', 'erase': 'normal', 'layer': 'normal', 'normal': 'normal'
  };

  // filter descriptor -> CSS filter string
  // Flash GlowFilter -> CSS: layered drop-shadows approximate the glow.
  // strength = layer count (3 = heavy ink look).
  // blur radius = average of blurX/blurY.
  function filterToCss(f) {
    if (!f) return null;
    switch (f.__filter) {
      case 'glow': {
        const blurX = f.blurX || 6, blurY = f.blurY || 6;
        const blur = Math.max(0.5, (blurX + blurY) / 4);
        const a = (f.alpha === undefined ? 1 : f.alpha);
        const c = Number(f.color === undefined ? 0xFF0000 : f.color) >>> 0;
        const r = (c >> 16) & 0xff, g = (c >> 8) & 0xff, b = c & 0xff;
        const st = Math.max(1, f.strength || 2);
        const parts = [];
        // strength=3: 3 layers with growing radius -> inner-to-outer glow falloff
        for (let i = 0; i < Math.min(4, st); i++) {
          const layerBlur = (blur * (1 + i * 0.3)).toFixed(1);
          parts.push('drop-shadow(0 0 ' + layerBlur + 'px rgba(' + r + ',' + g + ',' + b + ',' + a + '))');
        }
        return parts.join(' ');
      }
      case 'dropshadow': {
        const d = f.distance === undefined ? 4 : f.distance;
        const ang = (f.angle === undefined ? 45 : f.angle) * Math.PI / 180;
        const dx = (d * Math.cos(ang)).toFixed(1), dy = (d * Math.sin(ang)).toFixed(1);
        const blur = Math.max(0, ((f.blurX === undefined ? 4 : f.blurX) + (f.blurY === undefined ? 4 : f.blurY)) / 4).toFixed(1);
        const a = f.alpha === undefined ? 1 : f.alpha;
        const c = Number(f.color === undefined ? 0 : f.color) >>> 0;
        return 'drop-shadow(' + dx + 'px ' + dy + 'px ' + blur + 'px rgba(' +
          ((c >> 16) & 0xff) + ',' + ((c >> 8) & 0xff) + ',' + (c & 0xff) + ',' + a + '))';
      }
      case 'blur': {
        const bx = f.blurX || 0, by = f.blurY || 0;
        if (!bx && !by) return null;
        return 'blur(' + Math.max(bx, by).toFixed(1) + 'px)';
      }
      default:
        return null; // bevel/convolution/displacement/gradient*: no CSS equivalent
    }
  }


  // ---------------- Flash 3D matrix pipeline (per Ruffle display_object/render) ----------------
  // Flash 3D: each object has Matrix3D = T(x,y,z) * R * S. Euler order X->Y->Z,
  // see ruffle matrix_3d.rs recompose: translation*rotation*scale.
  // Projection: stage PerspectiveProjection (default FOV 55deg, center=stage center);
  // focalLength = (w/2)*tan((180-FOV)/2) (ruffle perspective_projection.rs).
  // Matrices operate in registration-point space (transform-origin:0 0).
  // We compose the full matrix in JS and emit one matrix3d(); the GPU does
  // the w-divide, matching Flash. No CSS rotateY/perspective mixing.
  const D2R = Math.PI / 180;

  // 4x4 stored in CSS column-major (same memory layout as Flash rawData)
  function m3dNew() { return new Float64Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]); }
  function m3dMultiply(a, b) { // a*b (apply b first)
    const o = new Float64Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c*4+r] = a[r]*b[c*4] + a[4+r]*b[c*4+1] + a[8+r]*b[c*4+2] + a[12+r]*b[c*4+3];
    }
    return o;
  }
  function m3dTranslate(x, y, z) {
    const m = m3dNew(); m[12] = x; m[13] = y; m[14] = z || 0; return m;
  }
  function m3dScale(sx, sy, sz) {
    const m = m3dNew(); m[0] = sx; m[5] = sy; m[10] = sz === undefined ? 1 : sz; return m;
  }
  function m3dRotateZ(deg) {
    const r = deg * D2R, c = Math.cos(r), s = Math.sin(r);
    const m = m3dNew(); m[0] = c; m[1] = s; m[4] = -s; m[5] = c; return m;
  }
  function m3dRotateY(deg) {
    const r = deg * D2R, c = Math.cos(r), s = Math.sin(r);
    const m = m3dNew(); m[0] = c; m[2] = -s; m[8] = s; m[10] = c; return m;
  }
  function m3dRotateX(deg) {
    const r = deg * D2R, c = Math.cos(r), s = Math.sin(r);
    const m = m3dNew(); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; return m;
  }
  // Flash viewport: matrices act in registration-point space, then translate to (x,y)
  function m3dCss(m) {
    const a = Array.from(m);
    // strip -0 and denormal noise
    for (let i = 0; i < 16; i++) if (Math.abs(a[i]) < 1e-10) a[i] = 0;
    return 'matrix3d(' + a.map(function (v) { return +v.toFixed(6); }).join(',') + ')';
  }
  // Local 3D compose: T*R*S. R is the explicit matrix from Ruffle
  // matrix_3d.rs recompose (EulerAngles), column-major raw values,
  // matching Flash Matrix3D decompose/recompose exactly.
  function m3dCompose(x, y, rz, ry, rx, sx, sy, z) {
    const m = m3dTranslate(x, y, z || 0);
    const cy = Math.cos(ry * D2R), sy2 = Math.sin(ry * D2R);
    const cx = Math.cos(rx * D2R), sx2 = Math.sin(rx * D2R);
    const cz = Math.cos(rz * D2R), sz2 = Math.sin(rz * D2R);
    // Ruffle recompose EulerAngles: column-major raw
    m[0]  = cy * cz;
    m[1]  = cy * sz2;
    m[2]  = -sy2;
    m[4]  = sx2 * sy2 * cz - cx * sz2;
    m[5]  = sx2 * sy2 * sz2 + cx * cz;
    m[6]  = sx2 * cy;
    m[8]  = cx * sy2 * cz + sx2 * sz2;
    m[9]  = cx * sy2 * sz2 - sx2 * cz;
    m[10] = cx * cy;
    if (sx !== 1 || sy !== 1) {
      const S = m3dNew();
      S[0] = sx; S[5] = sy;
      return m3dMultiply(m, S);
    }
    return m;
  }

  // ---------------- base class ----------------
  class M8Element {
    constructor(tag) {
      this.el = document.createElement(tag);
      // transform-origin:0 0 - Flash rotates/scales around the registration point,
      // CSS defaults to box center. Without this, rotated/scaled mode7 elements
      // (a quarter of them in c7UF) land skewed.
      this.el.style.cssText = 'position:absolute;left:0;top:0;transform-origin:0 0;';
      this._x = 0; this._y = 0; this._z = null;
      this._scaleX = 1; this._scaleY = 1;
      this._rotationX = 0; this._rotationY = 0; this._rotationZ = 0;
      this._alpha = 1;
      this._visible = true;
      this._parent = null;
      this._children = [];
      this._listeners = {};
      this._domListeners = {};   // type -> native el callback (shared across listeners)
      this._mouseX = 0; this._mouseY = 0;
      this.motionManager = null; // created by host (needs ScriptManager)
      this._filters = [];
      this._blendMode = 'normal';
      this._matrix3D = null;       // transform.matrix3D backing field
      this._lastTransform = null;  // transform dirty-check cache
      this._lastOpacity = null;
      this._lastVisibility = null;
      this.name = null;
      this._mouseEnabled = true;
      this._buttonMode = false;
      this.cacheAsBitmap = false;   // placeholder (no DOM equivalent)
      this.tabEnabled = false;
      this._hasEf = false;          // has enterFrame listener (_efTargets membership)
      const self = this;
      this.transform = {
        matrix3D: null,
        matrix: null,
        colorTransform: null,
        perspectiveProjection: null
      };
      // Assigning matrix3D switches to 3D (null forces back to 2D, as in Flash)
      Object.defineProperty(this.transform, 'matrix3D', {
        get: function () { return self._matrix3D; },
        set: function (v) {
          self._matrix3D = v;
          self._applyTransform();
        },
        configurable: true, enumerable: true
      });
      this._applyTransform();
    }

    // ---- transform (dirty-checked; style untouched when unchanged) ----
    _applyTransform() {
      const s = this.el.style;
      const has2DRot = this._rotationZ !== 0;
      const has3D = !!(this._matrix3D || this._rotationX || this._rotationY || (this._z !== null && this._z !== undefined));
      let t;
      if (has3D || this._use3DPipeline) {
        // Flash pipeline: one matrix3d carries the full transform.
        if (this._matrix3D) {
          t = m3dCss(this._matrix3D.rawData);
        } else {
          t = m3dCss(m3dCompose(this._x, this._y, has2DRot ? this._rotationZ : 0,
            this._rotationY, this._rotationX, this._scaleX, this._scaleY, this._z || 0));
        }
        if ((this._rotationX || this._rotationY) && M8._enableStage3D) M8._enableStage3D();
      } else {
        // 2D fast path: translate+scale (simple string, cache-friendly)
        t = 'translate(' + this._x + 'px,' + this._y + 'px)';
        if (has2DRot) t += ' rotate(' + this._rotationZ + 'deg)';
        if (this._scaleX !== 1 || this._scaleY !== 1) t += ' scale(' + this._scaleX + ',' + this._scaleY + ')';
      }
      if (t !== this._lastTransform) {
        s.transform = t;
        this._lastTransform = t;
      }
      const op = String(this._alpha);
      if (op !== this._lastOpacity) {
        s.opacity = op;
        this._lastOpacity = op;
      }
      const vis = this._visible ? 'visible' : 'hidden';
      if (vis !== this._lastVisibility) {
        s.visibility = vis;
        this._lastVisibility = vis;
      }
    }

    get x() { return this._x; }
    set x(v) { this._x = Number(v) || 0; this._applyTransform(); }
    get y() { return this._y; }
    set y(v) { this._y = Number(v) || 0; this._applyTransform(); }
    get z() { return this._z; }
    set z(v) { this._z = v; this._applyTransform(); }
    get scaleX() { return this._scaleX; }
    set scaleX(v) { this._scaleX = (Number(v) === 0 ? 0 : Number(v)) || 0; this._applyTransform(); }
    get scaleY() { return this._scaleY; }
    set scaleY(v) { this._scaleY = (Number(v) === 0 ? 0 : Number(v)) || 0; this._applyTransform(); }
    set scale(v) { this._scaleX = this._scaleY = Number(v) || 0; this._applyTransform(); }
    get scale() { return this._scaleX; }
    get alpha() { return this._alpha; }
    set alpha(v) { this._alpha = Number(v); if (isNaN(this._alpha)) this._alpha = 1; this._applyTransform(); }
    get visible() { return this._visible; }
    set visible(v) { this._visible = !!v; this._applyTransform(); }
    // Flash DisplayObject.rotation == Z rotation (used by scripts/tweens)
    get rotation() { return this._rotationZ; }
    set rotation(v) { this._rotationZ = Number(v) || 0; this._applyTransform(); }
    get rotationX() { return this._rotationX; }
    set rotationX(v) { this._rotationX = Number(v) || 0; this._applyTransform(); }
    get rotationY() { return this._rotationY; }
    set rotationY(v) { this._rotationY = Number(v) || 0; this._applyTransform(); }
    get rotationZ() { return this._rotationZ; }
    set rotationZ(v) { this._rotationZ = Number(v) || 0; this._applyTransform(); }

    // ---- filters / blend mode ----
    get filters() { return this._filters; }
    set filters(list) {
      this._filters = (list == null) ? [] : (Array.isArray(list) ? list : [list]);
      const parts = [];
      for (const f of this._filters) {
        const css = filterToCss(f);
        if (css) parts.push(css);
      }
      this.el.style.filter = parts.length ? parts.join(' ') : 'none';
      // Script-assigned filters replace the default ink outline (legacy semantics)
      if (this._strokeOn) {
        this.el.style.textShadow = '';
        this._strokeOn = false;
      }
    }
    get blendMode() { return this._blendMode; }
    set blendMode(v) {
      this._blendMode = v || 'normal';
      this.el.style.mixBlendMode = BLEND_MAP[this._blendMode] || 'normal';
    }

    // ---- size (Flash: width includes scale; getter cached, setter rescales) ----
    _layoutWidth() {
      if (this._customWidth !== undefined) return this._customWidth;
      return this._domWidth();
    }
    _layoutHeight() {
      if (this._customHeight !== undefined) return this._customHeight;
      return this._domHeight();
    }
    // DOM read fallback (subclasses override with reflow-free impls)
    _domWidth() { return this.el.offsetWidth || 0; }
    _domHeight() { return this.el.offsetHeight || 0; }
    get width() { return this._layoutWidth() * Math.abs(this._scaleX); }
    set width(v) { this._setWidth(Number(v)); }
    get height() { return this._layoutHeight() * Math.abs(this._scaleY); }
    set height(v) { this._setHeight(Number(v)); }
    _setWidth(v) {
      const lw = this._layoutWidth();
      if (lw > 0) this.scaleX = v / lw;
    }
    _setHeight(v) {
      const lh = this._layoutHeight();
      if (lh > 0) this.scaleY = v / lh;
    }

    // ---- hierarchy ----
    get parent() { return this._parent; }
    get numChildren() { return this._children.length; }
    getChildAt(i) { return this._children[i]; }

    addChild(child) {
      // 3D mode: new intermediate containers need preserve-3d for passthrough
      if (M8._stage3dOn) child.el.style.transformStyle = 'preserve-3d';
      if (child._parent) {
        if (child._parent === this && this._children.indexOf(child) !== -1) {
          // Already a child: just move to top (Flash semantics). Do NOT re-dispatch
          // Event.ADDED - handlers that re-add on added (c7UF resizer) would recurse
          // infinitely (handler -> addChild -> bubbles -> handler -> ...).
          this._children.splice(this._children.indexOf(child), 1);
          this._children.push(child);
          this.el.appendChild(child.el);
          return child;
        }
        child._parent.removeChild(child);
      }
      child._parent = this;
      this._children.push(child);
      this.el.appendChild(child.el);
      this._dispatchAdded(child);
      child._onAddedToStage();
      return child;
    }

    _notifyStageAddedRec() {
      if (this._hasEf) M8._efAdd(this);
      for (const c of this._children) c._notifyStageAddedRec();
    }

    // Flash Event.ADDED: target = added child, bubbles up the parent chain
    _dispatchAdded(child) {
      const ev = { type: 'added', target: child, currentTarget: child, bubbles: true };
      child.dispatchEvent('added', ev);
      let p = child._parent;
      while (p) { ev.currentTarget = p; p.dispatchEvent('added', ev); p = p._parent; }
    }
    _dispatchRemoved(child) {
      const ev = { type: 'removed', target: child, currentTarget: child, bubbles: true };
      child.dispatchEvent('removed', ev);
      let p = child._parent;
      while (p) { ev.currentTarget = p; p.dispatchEvent('removed', ev); p = p._parent; }
    }

    removeChild(child) {
      const i = this._children.indexOf(child);
      if (i === -1) {
        // AS3 throws ArgumentError; per-frame throws would spam, so this degrades
        // to a silent no-op (scripts should check numChildren first)
        return null;
      }
      this._children.splice(i, 1);
      child._parent = null;
      this._dispatchRemoved(child);
      child.el.remove();
      return child;
    }

    removeChildAt(i) {
      if (i < 0 || i >= this._children.length) return null;
      return this.removeChild(this._children[i]);
    }

    setChildIndex(child, index) {
      const i = this._children.indexOf(child);
      if (i === -1) return;
      this._children.splice(i, 1);
      index = Math.max(0, Math.min(index, this._children.length));
      this._children.splice(index, 0, child);
      // sync DOM order
      if (index === this._children.length - 1) {
        this.el.appendChild(child.el);
      } else {
        this.el.insertBefore(child.el, this._children[index + 1].el);
      }
    }

    _syncDom() {
      for (const c of this._children) this.el.appendChild(c.el);
    }

    remove() {
      try {
        if (this.motionManager) this.motionManager.stop();
        if (this._parent) this._parent.removeChild(this);
        else { this.el.remove(); this._onRemovedFromStage(); }
      } catch (e) { }
    }

    // off-stage: enterFrame no longer dispatched (Flash semantics)
    _onRemovedFromStage() {
      if (this._hasEf) M8._efDel(this);
      for (const c of this._children) c._onRemovedFromStage();
    }
    _onAddedToStage() {
      this._notifyStageAddedRec();
    }

    // ---- events (engine + DOM unified interface) ----
    // enterFrame/added/removed/complete/timer -> engine dispatch
    // click/mousedown/mousemove/... -> bound to the underlying el
    addEventListener(type, fn) {
      type = String(type);
      (this._listeners[type] = this._listeners[type] || []).push(fn);
      if (type === 'enterFrame') {
        if (!this._hasEf) { this._hasEf = true; M8._efAdd(this); }
      }
      if (DOM_EVENT_TYPES[type]) this._bindDomEvent(type);
    }

    removeEventListener(type, fn) {
      type = String(type);
      const l = this._listeners[type];
      if (l) {
        const i = l.indexOf(fn);
        if (i !== -1) l.splice(i, 1);
        if (l.length === 0) {
          delete this._listeners[type];
          if (type === 'enterFrame') {
            this._hasEf = false;
            M8._efDel(this);
          }
          if (DOM_EVENT_TYPES[type]) this._unbindDomEvent(type);
        }
      }
    }

    // one native el listener per type, shared across scripts
    _bindDomEvent(type) {
      if (this._domListeners[type]) return;
      const self = this;
      const handler = function (domEv) {
        // coords relative to element top-left (Flash mouseX/mouseY semantics)
        const rect = self.el.getBoundingClientRect();
        self._mouseX = domEv.clientX - rect.left;
        self._mouseY = domEv.clientY - rect.top;
        const ev = {
          type: type, target: self, currentTarget: self,
          localX: self._mouseX, localY: self._mouseY,
          mouseX: self._mouseX, mouseY: self._mouseY,
          stageX: domEv.clientX, stageY: domEv.clientY,
          altKey: domEv.altKey, ctrlKey: domEv.ctrlKey, shiftKey: domEv.shiftKey,
          bubbles: true, native: domEv
        };
        self.dispatchEvent(type, ev);
        // bubbling kept (Flash MouseEvent semantics unless script stops it)
      };
      this._domListeners[type] = handler;
      // mouseenter/leave/focus/blur do not bubble in DOM; dispatch locally only
      const cap = (type === 'focus' || type === 'blur');
      try { this.el.addEventListener(type, handler, cap); } catch (e) { }
      if (this.buttonMode && (type === 'mouseover' || type === 'mouseenter')) {
        try { this.el.style.cursor = 'pointer'; } catch (e) { }
      }
    }

    _unbindDomEvent(type) {
      const handler = this._domListeners[type];
      if (!handler) return;
      delete this._domListeners[type];
      try { this.el.removeEventListener(type, handler); } catch (e) { }
    }

    dispatchEvent(type, ev) {
      const l = this._listeners[type];
      if (!l || !l.length) return;
      ev = ev || { type: type, target: this };
      ev.currentTarget = this;
      for (const fn of l.slice()) {
        try { fn(ev); } catch (e) {
          // same listener + same error logs once (no per-frame spam)
          if (!fn.__lastErr || fn.__lastErr !== (e && e.message)) {
            fn.__lastErr = e && e.message;
            M8.warn('event listener error', e);
          }
        }
      }
    }

    // Flash DisplayObject.mouseX/mouseY: mouse position in local coords.
    // Stage-level in Flash; readable regardless of interactivity.
    // Implementation: subtract accumulated parent offsets from stage mouse.
    // Parent x/y accumulate (nested game canvases).
    get mouseX() {
      if (this._mouseX) return this._mouseX; // set by DOM events (interactive)
      // derive local coords from stage mouse
      if (M8._stageMouse) {
        let gx = M8._stageMouse.x, gy = M8._stageMouse.y;
        let ox = 0, oy = 0;
        let el = this;
        while (el) { ox += el._x; oy += el._y; el = el._parent; }
        return gx - ox;
      }
      return 0;
    }
    get mouseY() {
      if (this._mouseY) return this._mouseY;
      if (M8._stageMouse) {
        let gx = M8._stageMouse.x, gy = M8._stageMouse.y;
        let ox = 0, oy = 0;
        let el = this;
        while (el) { ox += el._x; oy += el._y; el = el._parent; }
        return gy - oy;
      }
      return 0;
    }
    get mouseEnabled() { return this._mouseEnabled; }
    set mouseEnabled(v) {
      this._mouseEnabled = !!v;
      this.el.style.pointerEvents = this._mouseEnabled ? 'auto' : 'none';
    }
    get buttonMode() { return this._buttonMode; }
    set buttonMode(v) {
      this._buttonMode = !!v;
      if (v) { try { this.el.style.cursor = 'pointer'; } catch (e) { } }
    }

    // ---- hit testing (hitTestObject / hitTestPoint unified) ----
    // Pure math - no DOM reads, no forced layout (hot path)
    // Legacy scripts use two calling conventions (VM has no overloads):
    //   1. hitTestObject(other) - AABB intersection (Flash hitTestObject)
    //   2. hitTestObject(x, y, shapeFlag) - point test (Flash hitTestPoint,
    //      stage coords; nested offsets cancel out, so local compare is equivalent)
    //   e.g. maze game: rects[i].hitTestObject(point.x, point.y, false)
    // Key: the box must cover the drawn graphics. Flash Shapes often draw
    // away from origin (maze walls at 187,25); include _gfxOffX/Y offsets.
    // Otherwise the maze start button dies instantly to an out-of-bounds
    // reset (looks like a dead button).
    _visualBounds() {
      let ox = 0, oy = 0;
      if (this._gfxOffX !== undefined) {
        ox = this._gfxOffX * Math.abs(this._scaleX || 1);
        oy = (this._gfxOffY || 0) * Math.abs(this._scaleY || 1);
      }
      return {
        x: this._x + ox,
        y: this._y + oy,
        w: this.width,
        h: this.height
      };
    }

    hitTestObject(other, y, shapeFlag) {
      if (other == null) return false;
      const a = this._visualBounds();
      // signature 2: hitTestObject(x, y, shapeFlag)
      // -> point-in-box (Flash hitTestPoint; shapeFlag treated as boundingBox)
      if (typeof other === 'number') {
        const px = other, py = (typeof y === 'number') ? y : 0;
        return px >= a.x && px <= a.x + a.w && py >= a.y && py <= a.y + a.h;
      }
      // signature 1: hitTestObject(other:DisplayObject) - AABB intersection
      if (!other) return false;
      const b = other._visualBounds ? other._visualBounds() : { x: other._x, y: other._y, w: other.width, h: other.height };
      return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
    }

    // Flash hitTestPoint(x, y, shapeFlag) - alias (some scripts call this)
    hitTestPoint(x, y, shapeFlag) {
      return this.hitTestObject(x, y, shapeFlag);
    }

    // deep clone (AS3 Utils.clone serializes via ByteArray AMF)
    // DOM port: rebuild same-class element, copy visual state, fresh DOM node
    __clone() {
      const c = new M8Element(this.el.tagName.toLowerCase());
      c.name = this.name;
      c._x = this._x; c._y = this._y; c._z = this._z;
      c._scaleX = this._scaleX; c._scaleY = this._scaleY;
      c._rotationX = this._rotationX; c._rotationY = this._rotationY; c._rotationZ = this._rotationZ;
      c._alpha = this._alpha; c._visible = this._visible;
      c._blendMode = this._blendMode;
      c._matrix3D = this._matrix3D;
      c.mouseEnabled = this._mouseEnabled; c.buttonMode = this._buttonMode;
      c.filters = this._filters.slice();
      c._applyTransform();
      return c;
    }
  }

  // ---------------- text elements (CommentField / TextField) ----------------
  // Flash CommentField rendering (CommentField.as + CommentConfig.as):
  //   - embedFonts=false (device fonts, not embedded)
  //   - antiAliasType=NORMAL
  //   - default filter = CommentConfig ink GlowFilter:
  //       non-black text -> black glow 4px blur strength 3
  //       black text -> white glow 3px blur strength 4
  //   - scripts clear it via .filters=[]
  // CSS map: GlowFilter -> drop-shadow layers
  class CommentField extends M8Element {
    constructor() {
      super('div');
      const s = this.el.style;
      s.whiteSpace = 'pre';
      s.pointerEvents = 'none';
      s.fontFamily = mapFont('黑体');
      s.fontSize = '25px';
      s.color = '#ffffff';
      s.lineHeight = '1';
      this._text = '';
      this._wordWrap = false;
      this._multiline = false;
      this._defaultTextFormat = null;
      this._selectable = false;       // AS3 CommentField ctor sets false
      this._autoSize = 'left';        // TextFieldAutoSize.LEFT
      this._format = { font: '黑体', size: 25, color: 0xFFFFFF, bold: false, italic: false, underline: false, align: null };
      this._measured = null; // metrics cache {w, h, lines}
      // Default ink glow applied by _initFieldStyle at createComment time
      // (bare TextFields get no outline, matching legacy ctor)
    }

    get selectable() { return this._selectable; }
    set selectable(v) { this._selectable = !!v; }   // native comments default true
    get autoSize() { return this._autoSize; }
    set autoSize(v) { this._autoSize = v || 'none'; }

    // AS3 TextField.getTextFormat(): format snapshot for setTextFormat
    getTextFormat() {
      return new M8.TextFormat(
        this._format.font, this._format.size, this._format.color,
        this._format.bold, this._format.italic, this._format.underline,
        this._format.align, null, null, null, null
      );
    }

    // Legacy default ink outline (CommentField.initStyle -> getFilterByColor:
    // GlowFilter(0,0.85,4,4,3,1); soft 4px halo in the legacy player).
    // Impl: 2-pass blurred text-shadow (same idea as the BAS renderer) -
    // no per-element filter layers, no glyph erosion (Chrome<123 lacks
    // paint-order for HTML text; text-stroke eats light glyphs).
    _applyDefaultGlow() {
      // Default ink outline (CommentField.initStyle -> getFilterByColor).
      // 4-direction hard shadow: crisp, cheap, matches legacy player look.
      const color = this._format.color || 0xFFFFFF;
      const s = this.el.style;
      const c = (color !== 0) ? 'rgba(0,0,0,0.9)' : 'rgba(255,255,255,0.9)';
      s.textShadow = '1px 0 0 ' + c + ', 0 1px 0 ' + c +
        ', 0 -1px 0 ' + c + ', -1px 0 0 ' + c + ', 0 0 2px ' + c;
      this._strokeOn = true;
    }

    // Text metrics (Flash autoSize=LEFT semantics):
    // textWidth = widest line; textHeight = lines * lineHeight (SimHei lineHeight = 1em)
    // recomputed only on text/format/wrap change; zero reflow
    _measure() {
      if (this._measured) return this._measured;
      const text = this._text;
      const size = this._format.size || 25;
      let lines;
      if (!text) {
        lines = [''];
      } else if (this._wordWrap) {
        lines = [text]; // wordWrap: single-line approximation (rare in legacy scripts)
      } else {
        lines = String(text).split(/\r\n|\r|\n/);
      }
      const ctx = getMeasureCtx();
      if (ctx) {
        ctx.font = (this._format.bold ? 'bold ' : '') + size + 'px ' + mapFont(this._format.font);
      }
      let maxW = 0;
      for (const ln of lines) {
        let w;
        if (ctx && ln) {
          w = ctx.measureText(ln).width;
        } else {
          w = ln.length * size; // fallback without measurement ctx
        }
        if (w > maxW) maxW = w;
      }
      this._measured = { w: Math.ceil(maxW), h: Math.ceil(lines.length * size), lines: lines.length };
      return this._measured;
    }

    _invalidateMeasure() { this._measured = null; }

    get textWidth() { return this._measure().w; }
    get textHeight() { return this._measure().h; }

    get text() { return this._text; }
    set text(v) {
      this._text = (v === undefined || v === null) ? '' : String(v);
      // Flash TextField renders \r as newline; DOM needs the conversion.
      // .text getter preserves original chars (AS3 semantics)
      this.el.textContent = this._text.replace(/\r\n?/g, '\n');
      this._invalidateMeasure();
    }
    // AS3 TextField.appendText
    appendText(v) {
      this.text = this._text + (v === undefined || v === null ? '' : String(v));
    }
    get htmlText() { return this._text; }
    set htmlText(v) { this.text = v; }

    get color() { return this._format.color; }
    set color(v) {
      this._format.color = Number(v) >>> 0;
      this.el.style.color = colorToCss(this._format.color);
    }
    get textColor() { return this._format.color; }
    set textColor(v) { this.color = v; }

    get font() { return this._format.font; }
    set font(v) {
      this._format.font = v;
      this.el.style.fontFamily = mapFont(v);
      this._invalidateMeasure();
    }

    get fontsize() { return this._format.size; }
    set fontsize(v) {
      this._format.size = Number(v) || 25;
      this.el.style.fontSize = this._format.size + 'px';
      this._invalidateMeasure();
    }

    get bold() { return !!this._format.bold; }
    set bold(v) {
      this._format.bold = !!v;
      this.el.style.fontWeight = v ? 'bold' : 'normal';
      this._invalidateMeasure();
    }
    get italic() { return !!this._format.italic; }
    set italic(v) {
      this._format.italic = !!v;
      this.el.style.fontStyle = v ? 'italic' : 'normal';
    }
    get underline() { return !!this._format.underline; }
    set underline(v) {
      this._format.underline = !!v;
      this.el.style.textDecoration = v ? 'underline' : 'none';
    }
    get align() { return this._format.align || 'left'; }
    set align(v) { this._format.align = v; this.el.style.textAlign = v || 'left'; }

    get background() { return !!this._background; }
    set background(v) {
      this._background = !!v;
      this.el.style.backgroundColor = this._background ? colorToCss(this._backgroundColor || 0) : 'transparent';
    }
    get backgroundColor() { return this._backgroundColor || 0; }
    set backgroundColor(v) {
      this._backgroundColor = Number(v) >>> 0;
      if (this._background) this.el.style.backgroundColor = colorToCss(this._backgroundColor);
    }
    get border() { return !!this._border; }
    set border(v) {
      this._border = !!v;
      this.el.style.border = this._border ? ('1px solid ' + colorToCss(this._borderColor || 0)) : 'none';
    }
    get borderColor() { return this._borderColor || 0; }
    set borderColor(v) {
      this._borderColor = Number(v) >>> 0;
      if (this._border) this.el.style.border = '1px solid ' + colorToCss(this._borderColor);
    }

    get wordWrap() { return this._wordWrap; }
    set wordWrap(v) {
      this._wordWrap = !!v;
      this.el.style.whiteSpace = this._wordWrap ? 'pre-wrap' : 'pre';
      if (this._wordWrap && this._customWidth === undefined) this._customWidth = this._measure().w || 100;
      this._invalidateMeasure();
    }
    get multiline() { return this._multiline; }
    set multiline(v) { this._multiline = !!v; }

    setTextFormat(fmt) {
      if (!fmt) return;
      if (fmt.font !== undefined && fmt.font !== null) this.font = fmt.font;
      if (fmt.size !== undefined && fmt.size !== null) this.fontsize = fmt.size;
      if (fmt.color !== undefined && fmt.color !== null) this.color = fmt.color;
      if (fmt.bold !== undefined && fmt.bold !== null) this.bold = fmt.bold;
      if (fmt.italic !== undefined && fmt.italic !== null) this.italic = fmt.italic;
      if (fmt.underline !== undefined && fmt.underline !== null) this.underline = fmt.underline;
      if (fmt.align !== undefined && fmt.align !== null) this.align = fmt.align;
    }

    get defaultTextFormat() { return this._defaultTextFormat; }
    set defaultTextFormat(fmt) {
      this._defaultTextFormat = fmt;
      if (fmt) this.setTextFormat(fmt);
    }

    // override: size from metrics cache (autoSize=LEFT)
    _domWidth() { return this._measure().w; }
    _domHeight() { return this._measure().h; }

    _setWidth(v) {
      // width setter: clamp layout width (wordWrap case)
      if (!isFinite(v) || v <= 0) return;
      this._customWidth = v;
      this.el.style.width = v + 'px';
      this._invalidateMeasure();
    }

    __clone() {
      const c = new CommentField();
      c.name = this.name;
      c.data = this.data;   // clones keep data.text/data.pool readable
      c.text = this._text;
      c._format = Object.assign({}, this._format);
      c._selectable = this._selectable;
      c._wordWrap = this._wordWrap;
      c._multiline = this._multiline;
      c.font = this._format.font;
      c.fontsize = this._format.size;
      c.color = this._format.color;
      c.bold = this._format.bold;
      c.italic = this._format.italic;
      c.underline = this._format.underline;
      c.align = this._format.align;
      c._x = this._x; c._y = this._y; c._z = this._z;
      c._scaleX = this._scaleX; c._scaleY = this._scaleY;
      c._rotationX = this._rotationX; c._rotationY = this._rotationY; c._rotationZ = this._rotationZ;
      c._alpha = this._alpha; c._visible = this._visible;
      c._blendMode = this._blendMode;
      c._matrix3D = this._matrix3D;
      c.filters = this._filters.slice();
      c._applyTransform();
      return c;
    }
  }

  // ---------------- vector shapes (M8Shape) ----------------
  // DOM: <div> container (positions children) + inner <canvas> (draws graphics)
  // Separation: graphics bounds offset (_gfxOffX/Y) must move only the canvas,
  // not the container. Otherwise children drift as bounds grow (Duet
  // paper.graphics.lineTo() accumulates bounds -> everything misaligns).
  class M8Shape extends M8Element {
    constructor() {
      super('div');
      this.el.style.pointerEvents = 'none';
      this.el.style.overflow = 'visible';
      // inner canvas: drawing target with independent offset
      this._canvasEl = document.createElement('canvas');
      this._canvasEl.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;';
      this.el.appendChild(this._canvasEl);
      this.graphics = new M8.Graphics(this);
      // Graphics bounds may extend into negative coords,
      // so the canvas shifts by (minX, minY) to keep local coords consistent.
      // Affects only the _canvasEl transform, never the container/children.
      this._gfxOffX = 0;
      this._gfxOffY = 0;
      this._lastCanvasTransform = null;
    }
    // container transform excludes _gfxOffX/Y (children unaffected by bounds)
    _applyTransform() {
      let t = 'translate(' + this._x + 'px,' + this._y + 'px)';
      if (this._z !== null && this._z !== undefined) t += ' translateZ(' + this._z + 'px)';
      if (this._matrix3D) {
        t = m3dCss(this._matrix3D.rawData);
      } else if (this._rotationX || this._rotationY) {
        t = m3dCss(m3dCompose(this._x, this._y, this._rotationZ, this._rotationY, this._rotationX, this._scaleX, this._scaleY, this._z || 0));
        if (M8._enableStage3D) M8._enableStage3D();
      } else {
        if (this._rotationZ) t += ' rotate(' + this._rotationZ + 'deg)';
        if (this._scaleX !== 1 || this._scaleY !== 1) t += ' scale(' + this._scaleX + ',' + this._scaleY + ')';
      }
      const s = this.el.style;
      if (t !== this._lastTransform) {
        s.transform = t;
        this._lastTransform = t;
      }
      const op = String(this._alpha);
      if (op !== this._lastOpacity) {
        s.opacity = op;
        this._lastOpacity = op;
      }
      const vis = this._visible ? 'visible' : 'hidden';
      if (vis !== this._lastVisibility) {
        s.visibility = vis;
        this._lastVisibility = vis;
      }
    }
    // canvas offset: moves only the inner canvas
    _applyCanvasOffset() {
      const ox = this._gfxOffX || 0, oy = this._gfxOffY || 0;
      const ct = 'translate(' + ox + 'px,' + oy + 'px)';
      if (ct !== this._lastCanvasTransform) {
        this._canvasEl.style.transform = ct;
        this._lastCanvasTransform = ct;
      }
    }
    // canvas.width only exists once graphics flushed; an empty browser canvas
    // defaults to 300x150 - use recorded bounds instead (Flash: 0 when empty)
    _domWidth() {
      const g = this.graphics;
      return (g && g._bounds) ? Math.ceil(g._bounds.maxX) - Math.floor(g._bounds.minX) : 0;
    }
    _domHeight() {
      const g = this.graphics;
      return (g && g._bounds) ? Math.ceil(g._bounds.maxY) - Math.floor(g._bounds.minY) : 0;
    }
    _setWidth(v) {
      const lw = this._layoutWidth();
      if (lw > 0) this.scaleX = v / lw;
      else { this._customWidth = v; }
    }
    _setHeight(v) {
      const lh = this._layoutHeight();
      if (lh > 0) this.scaleY = v / lh;
      else { this._customHeight = v; }
    }
  }

  // ---------------- container canvas (CommentCanvas / Sprite) ----------------
  // Flash Sprite has both a child list and its own graphics (e.g. the Duet
  // endless-mode simpleRenderingText: createCanvas container + per-glyph
  // child canvases + drawPath fills). CommentCanvas therefore needs its own
  // _canvasEl, else drawPath drops silently and titles/graphics vanish.
  class CommentCanvas extends M8Element {
    constructor() {
      super('div');
      // pointerEvents auto: lets children (buttons) receive clicks.
      // Flash Sprite is an InteractiveObject; the canvas container matches that.
      // none would block events to children (dead maze start button).
      this.el.style.pointerEvents = 'auto';
      this._w = undefined;
      this._h = undefined;
      // inner canvas hosts own graphics (children stay on the container div)
      this._canvasEl = document.createElement('canvas');
      this._canvasEl.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;';
      this.el.appendChild(this._canvasEl);
      this._gfxOffX = 0;
      this._gfxOffY = 0;
      this._lastCanvasTransform = null;
      this.graphics = new M8.Graphics(this);
    }
    // like M8Shape: bounds offset moves only the inner canvas
    _applyCanvasOffset() {
      const ox = this._gfxOffX || 0, oy = this._gfxOffY || 0;
      const ct = 'translate(' + ox + 'px,' + oy + 'px)';
      if (ct !== this._lastCanvasTransform) {
        this._canvasEl.style.transform = ct;
        this._lastCanvasTransform = ct;
      }
    }
    _domWidth() {
      if (this._w !== undefined) return this._w;
      // Flash: width = child bounds span, INCLUDING children at negative x
      // (sprite centered at origin: child x=-30 w=60 -> width 60, not 30).
      // The inner canvas only counts when graphics were actually drawn: a
      // browser canvas defaults to 300x150 and an empty one must not leak
      // into bounds (ship container measured 330x180 instead of 60x60 ->
      // shield circle centered at 108,33 -> ring far off the ship).
      let minX = 0, maxX = 0;
      for (const c of this._children) {
        minX = Math.min(minX, c._x || 0);
        maxX = Math.max(maxX, (c._x || 0) + c.width);
      }
      const g = this.graphics;
      if (g && g._bounds) {
        minX = Math.min(minX, Math.floor(g._bounds.minX));
        maxX = Math.max(maxX, Math.ceil(g._bounds.maxX));
      }
      return maxX - minX;
    }
    _domHeight() {
      if (this._h !== undefined) return this._h;
      let minY = 0, maxY = 0;
      for (const c of this._children) {
        minY = Math.min(minY, c._y || 0);
        maxY = Math.max(maxY, (c._y || 0) + c.height);
      }
      const g = this.graphics;
      if (g && g._bounds) {
        minY = Math.min(minY, Math.floor(g._bounds.minY));
        maxY = Math.max(maxY, Math.ceil(g._bounds.maxY));
      }
      return maxY - minY;
    }
    _setWidth(v) { this._w = v; }
    _setHeight(v) { this._h = v; }
  }

  // ---------------- buttons (CommentButton) ----------------
  class CommentButton extends M8Element {
    constructor() {
      super('div');
      const s = this.el.style;
      s.pointerEvents = 'auto';
      s.cursor = 'pointer';
      s.userSelect = 'none';
      s.border = '1px solid #888888';
      s.borderRadius = '4px';
      s.boxShadow = '1px 1px 2px rgba(0,0,0,0.3)';
      s.overflow = 'hidden';
      s.display = 'flex';
      s.alignItems = 'center';
      s.justifyContent = 'center';
      s.background = 'linear-gradient(to bottom, #ffffff, #dddddd)';
      // label is a CommentField child: getChildAt(0) is the label
      this._label = new M8.CommentField();
      const ls = this._label.el.style;
      ls.whiteSpace = 'pre';
      ls.pointerEvents = 'none';
      ls.fontFamily = mapFont(null);
      ls.fontSize = '12px';
      ls.fontWeight = 'bold';
      ls.color = '#000000';
      ls.position = 'static';
      this._label._selectable = false;
      this._label._applyTransform();
      super.addChild(this._label);
      this._w = 0;
      this._h = 0;
      this._colors = [];
      this._alphas = [];
      this._over = false;
      const self = this;
      this.el.addEventListener('mouseenter', function () { self._over = true; self._updateLook(); });
      this.el.addEventListener('mouseleave', function () { self._over = false; self._updateLook(); });
    }

    get text() { return this._label.text; }
    set text(v) {
      this._label.text = (v === undefined || v === null) ? '' : String(v);
      this._updateRect();
    }

    initStyle(config) {
      this._x = Number(config.x) || 0;
      this._y = Number(config.y) || 0;
      this._z = config.z;
      this._alpha = (config.alpha === undefined) ? 1 : Number(config.alpha);
      this._scaleX = this._scaleY = (config.scale === undefined) ? 1 : Number(config.scale);
      if (config.width !== undefined) this._w = Number(config.width);
      if (config.height !== undefined) this._h = Number(config.height);
      this._applyTransform();
      this._updateRect();
    }

    // label measurement (12px bold, CJK full-width approx) - no reflow
    _labelW() {
      const t = this._label.text || '';
      let w = 0;
      for (let i = 0; i < t.length; i++) {
        const code = t.charCodeAt(i);
        w += (code >= 0x2E80 && code <= 0x9FFF) || (code >= 0xFF00 && code <= 0xFF60) ? 12 : 7.2;
      }
      return Math.ceil(w);
    }

    _updateRect() {
      if (this._w <= 0) this._w = this._labelW() + 12;
      if (this._h <= 0) this._h = 12 + 5;
      this.el.style.width = this._w + 'px';
      this.el.style.height = this._h + 'px';
      this._updateLook();
    }

    _updateLook() {
      const colors = this._colors.length ? this._colors : [0xFFFFFF, 0xDDDDDD];
      const n = colors.length;
      const stops = [];
      for (let i = 0; i < n; i++) {
        const a = (i < this._alphas.length) ? this._alphas[i] : (this._over ? 0.8 : 0.618);
        stops.push(colorToCss(colors[i], a) + ' ' + Math.floor(i / n * 100) + '%');
      }
      this.el.style.background = 'linear-gradient(to bottom,' + stops.join(',') + ')';
      this.el.style.boxShadow = this._over ? 'none' : '1px 1px 2px rgba(0,0,0,0.3)';
    }

    setStyle(name, value) {
      if (name === 'fillColors') this.fillColors = value;
      if (name === 'fillAlphas') this.fillAlphas = value;
    }
    get fillColors() { return this._colors; }
    set fillColors(v) { this._colors = v || []; this._updateLook(); }
    get fillAlphas() { return this._alphas; }
    set fillAlphas(v) { this._alphas = v || []; this._updateLook(); }

    _domWidth() { return this._w || 60; }
    _domHeight() { return this._h || 30; }
    _setWidth(v) { this._w = v; this.el.style.width = v + 'px'; }
    _setHeight(v) { this._h = v; this.el.style.height = v + 'px'; }
  }

  // ---------------- bitmap element (CommentBitmap) ----------------
  class CommentBitmap extends M8Element {
    constructor(bitmapData) {
      super('canvas');
      this.el.style.pointerEvents = 'none';
      this.bitmapData = bitmapData || null;
      if (bitmapData) {
        this.el.width = bitmapData.width;
        this.el.height = bitmapData.height;
        try {
          this.el.getContext('2d').drawImage(bitmapData._canvas, 0, 0);
        } catch (e) { }
      }
    }
    _domWidth() { return this.el.width || 0; }
    _domHeight() { return this.el.height || 0; }
  }

  // ---------------- BitmapData (libBitmap backing object) ----------------
  class BitmapData {
    constructor(width, height, transparent, fillColor) {
      width = Math.max(0, Math.min(8191, Math.floor(Number(width) || 0)));
      height = Math.max(0, Math.min(8191, Math.floor(Number(height) || 0)));
      this.width = width;
      this.height = height;
      this.transparent = (transparent === undefined) ? true : !!transparent;
      this._canvas = document.createElement('canvas');
      this._canvas.width = width;
      this._canvas.height = height;
      this._ctx = this._canvas.getContext('2d');
      if (fillColor === undefined) fillColor = 0xFFFFFFFF;
      this.fillRect(this._rectObj(), fillColor);
    }

    _rectObj() {
      return { x: 0, y: 0, width: this.width, height: this.height,
        get left() { return this.x; }, get top() { return this.y; },
        get right() { return this.x + this.width; }, get bottom() { return this.y + this.height; } };
    }

    get rect() { return this._rectObj(); }

    getPixels(rect) {
      // returns ARGB big-endian ByteArray (Flash semantics)
      const r = rect || this.rect;
      const ba = new M8.ByteArray();
      const img = this._ctx.getImageData(r.x, r.y, r.width, r.height).data;
      for (let i = 0; i < img.length; i += 4) {
        ba.writeByte(img[i + 3]);
        ba.writeByte(img[i]);
        ba.writeByte(img[i + 1]);
        ba.writeByte(img[i + 2]);
      }
      ba.position = 0;
      return ba;
    }

    setPixels(rect, ba) {
      const r = rect || this.rect;
      const img = this._ctx.createImageData(r.width, r.height);
      const d = ba.toUint8Array();
      let pos = ba.position || 0;
      for (let i = 0; i < img.data.length; i += 4) {
        img.data[i] = d[pos + 1] !== undefined ? d[pos + 1] : 0;
        img.data[i + 1] = d[pos + 2] !== undefined ? d[pos + 2] : 0;
        img.data[i + 2] = d[pos + 3] !== undefined ? d[pos + 3] : 0;
        img.data[i + 3] = d[pos] !== undefined ? d[pos] : 255;
        pos += 4;
      }
      this._ctx.putImageData(img, r.x, r.y);
    }

    copyPixels(source, rect, point) {
      if (!source || !source._canvas) return;
      const r = rect || source.rect;
      const p = point || { x: 0, y: 0 };
      // Flash copyPixels REPLACES destination pixels (alpha included);
      // drawImage composites. Clear the target first or transparent source
      // pixels leave the white BitmapData backing visible (explosion/ship
      // sprites rendered on white squares).
      this._ctx.clearRect(p.x, p.y, r.width, r.height);
      this._ctx.drawImage(
        source._canvas,
        r.x, r.y, r.width, r.height,
        p.x, p.y, r.width, r.height
      );
    }

    draw(source) {
      if (!source) return;
      if (source._canvas) {
        this._ctx.drawImage(source._canvas, 0, 0);
      } else if (source.el) {
        this._ctx.drawImage(source.el, 0, 0);
      }
    }

    _argbToCss(c) {
      const a = ((c >>> 24) & 0xff) / 255;
      const r = (c >>> 16) & 0xff, g = (c >>> 8) & 0xff, b = c & 0xff;
      return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
    }

    fillRect(rect, color) {
      const r = rect || this.rect;
      if (color === 0 || color === undefined) {
        this._ctx.clearRect(r.x, r.y, r.width, r.height);
      } else {
        this._ctx.fillStyle = this._argbToCss(Number(color) >>> 0);
        this._ctx.fillRect(r.x, r.y, r.width, r.height);
      }
    }

    getPixel32(x, y) {
      if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
      const d = this._ctx.getImageData(x, y, 1, 1).data;
      return ((d[3] << 24) | (d[0] << 16) | (d[1] << 8) | d[2]) >>> 0;
    }

    getPixel(x, y) {
      return this.getPixel32(x, y) & 0xFFFFFF;
    }

    setPixel32(x, y, c) {
      if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
      const img = this._ctx.createImageData(1, 1);
      c = Number(c) >>> 0;
      img.data[0] = (c >>> 16) & 0xff;
      img.data[1] = (c >>> 8) & 0xff;
      img.data[2] = c & 0xff;
      img.data[3] = (c >>> 24) & 0xff;
      this._ctx.putImageData(img, x, y);
    }

    setPixel(x, y, c) {
      const old = this.getPixel32(x, y);
      this.setPixel32(x, y, ((old & 0xFF000000) | (Number(c) & 0xFFFFFF)) >>> 0);
    }

    lock() { }
    unlock() { }
    dispose() {
      this._canvas.width = 1;
      this._canvas.height = 1;
    }
  }

  // ---------------- mode 7 (FixedPosComment port) ----------------
  // TODO: mode7 3D rendering is not pixel-perfect yet. Known gaps vs the
  // legacy Flash player: perspective composition inside nested scaled
  // containers (resizer pattern), registration-point semantics for rotated
  // panels, and glyph metrics. Pipeline is source-aligned (Ruffle Euler +
  // Adobe projection) but needs on-device comparison.
  // Port of org/lala/comments/FixedPosComment.as: pos/rotation/fade/motion/path.
  // Owns .data (CommentDataMode7 fields); complete is script-overridable
  // (the c7UF resizer script relies on comment.data.mode / comment.data.text
  //  and overwrites comment.complete).
  // absolutePos (legacy L182-187): (0,1) open interval scales by container size
  class Mode7Comment extends CommentField {
    constructor(item, stageW, stageH) {
      super();
      const W = stageW || 0, H = stageH || 0;
      this.data = item;           // own property: hasOwnProperty('data') works (AS3 trait)
      this._complete = null;
      this._tw = null;
      this._fired = false;
      const num = function (v, d) { const n = Number(v); return isFinite(n) ? n : (d || 0); };
      const duration = (num(item.duration) === 0) ? Number.MAX_VALUE : num(item.duration, 2.5);
      const inAlpha = (item.inAlpha === undefined) ? 1 : num(item.inAlpha, 1);
      const outAlpha = (item.outAlpha === undefined) ? 1 : num(item.outAlpha, 1);

      this.mouseEnabled = false;
      this.visible = false;
      this.x = Mode7Comment.absolutePos(num(item.x), W);
      this.y = Mode7Comment.absolutePos(num(item.y), H);
      if (num(item.rY) !== 0 || num(item.rZ) !== 0) {
        this.rotationY = num(item.rY);
        this.rotationZ = num(item.rZ);
      }
      this.alpha = inAlpha;
      // legacy init() order: format/text first, then ink filter by borderStyle
      this.font = item.fontFamily || 'SimHei';
      this.fontsize = num(item.size, 25);
      if (item.color !== undefined) this.color = item.color;
      this.text = item.text != null ? item.text : '';
      if (item.borderStyle !== false) {
        this._applyDefaultGlow();
      } else {
        this.filters = [];
      }

      const BetweenAS3 = M8.BetweenAS3;
      // tw1: alpha in->out over the whole lifetime (Quadratic.easeOut, legacy L100)
      const tw1 = BetweenAS3.tween(this, { alpha: outAlpha }, { alpha: inAlpha }, duration, M8.Easing.Quadratic.easeOut);
      let tw;
      if (!item.adv) {
        tw = tw1;
      } else if (!item.motionPath) {
        // motion: x/y -> toX/toY over mDuration; isAccelerated uses Quadratic.easeOut,
        // else Linear.easeIn; parallel with alpha, motion delayed by delay (L102-111)
        const tw2 = BetweenAS3.tween(this,
          { x: Mode7Comment.absolutePos(num(item.toX), W), y: Mode7Comment.absolutePos(num(item.toY), H) },
          { x: this.x, y: this.y },
          num(item.mDuration, 0.5),
          item.isAccelerated ? M8.Easing.Quadratic.easeOut : M8.Easing.Linear.easeIn);
        tw = BetweenAS3.parallelTweens([tw1, BetweenAS3.delay(tw2, num(item.delay))]);
      } else {
        // motionPath: "Mx,yLx,yL..." -> polyline points, progress 0->1 over mDuration
        const pts = [];
        try {
          const parts = String(item.motionPath).substring(1).split('L');
          for (const part of parts) {
            const xy = part.split(',');
            pts.push({ x: Number(xy[0]), y: Number(xy[1]) });
          }
        } catch (e) { }
        const tw2 = new M8.PolylineTween(this, pts, num(item.mDuration, 0.5));
        tw = BetweenAS3.parallelTweens([tw1, BetweenAS3.delay(tw2, num(item.delay))]);
      }
      const self = this;
      const onComplete = function () {
        tw.removeEventListener(M8.TweenEvent.COMPLETE, onComplete);
        self._fireComplete();
      };
      tw.addEventListener(M8.TweenEvent.COMPLETE, onComplete);
      this._tw = tw;
      // mode7: full matrix pipeline (TODO: not pixel-perfect, see class comment)
      this._use3DPipeline = true;
      this._stageW = stageW;
      this._stageH = stageH;
      // content renders to canvas (see _renderCanvas): font-metrics independent
      this._renderCanvas();
    }

    // Flash semantics: projection happens in the SWF stage coordinate space
    // (the semantic space of danmaku coords): focal=(W/2)/tan(FOV/2),
    // center=stage center; container scaling only magnifies the result.
    //   W_sem = (W - 2*accX)/accS  (accS/accX = accumulated parent scale/translate)
    // P is pre-multiplied into the element matrix (identity at z=0).
    // Without a resizer accS=1 and semantic space == stage space.
    _applyTransform() {
      const s = this.el.style;
      if ((this._rotationX || this._rotationY) && M8._enableStage3D) M8._enableStage3D();
      let m = m3dCompose(this._x, this._y, this._rotationZ, this._rotationY, this._rotationX,
        this._scaleX, this._scaleY, 0);
      if (this._matrix3D) m = this._matrix3D.rawData;
      if ((this._rotationX || this._rotationY || this._use3DPipeline) && this._stageW) {
        let accS = 1, accSY = 1, accX = 0, accY = 0;
        let px = this._parent;
        while (px) {
          accX += (px._x || 0) * accS;
          accY += (px._y || 0) * accSY;
          accS *= (px._scaleX || 1);
          accSY *= (px._scaleY || 1);
          px = px._parent;
        }
        if (accS > 0.001 && accSY > 0.001) {
          const Wd = (this._stageW - 2 * accX) / accS;
          const Hd = (this._stageH - 2 * accY) / accSY;
          const f = (Wd / 2) / Math.tan((55 * D2R) / 2);
          const P = m3dNew();
          P[8] = (Wd / 2) / f;
          P[9] = (Hd / 2) / f;
          // CSS w' = 1 - z/f (far shrinks); focal/center in semantic units
          P[11] = -1 / f;
          m = m3dMultiply(P, m);
        }
      }
      const t = m3dCss(m);
      if (t !== this._lastTransform) {
        s.transform = t;
        this._lastTransform = t;
      }
      const op = String(this._alpha);
      if (op !== this._lastOpacity) {
        s.opacity = op;
        this._lastOpacity = op;
      }
      const vis = this._visible ? 'visible' : 'hidden';
      if (vis !== this._lastVisibility) {
        s.visibility = vis;
        this._lastVisibility = vis;
      }
    }

    static absolutePos(v, ref) {
      if (v <= 0 || v >= 1) return v;
      return ref * v;
    }

    // ---- canvas content rendering (Flash device-text semantics) ----
    // Flash GDI device text: advance = font advance (SimHei fullwidth = 1em),
    // lineHeight = ascent+descent (SimHei exactly 1.0em), block chars are
    // grid-fitted to full em. DOM text cannot match all three at once,
    // which caused split blocks and misaligned pixel art.
    // Canvas: per-char grid at fs, block chars as full-em fillRect,
    // independent of font metrics; drawn once, transformed by CSS 3D.
    _renderCanvas() {
      if (this._cnv) this._cnv.remove();
      const fs = Math.max(1, Math.round(Number(this._format.size) || 25));
      const lines = String(this._text || '').split(/\r\n|\r|\n/);
      if (!this._advCache) this._advCache = new Map();
      const ctxKey = fs + 'px ' + mapFont(this._format.font);
      let measure = this._advCtx;
      if (!measure || this._advCtxKey !== ctxKey) {
        const mc = document.createElement('canvas');
        mc.width = 8; mc.height = 8;
        measure = mc.getContext('2d');
        measure.font = ctxKey;
        this._advCtx = measure;
        this._advCtxKey = ctxKey;
      }
      let cols = 1;
      const rowChars = lines.map(function (l) { return Array.from(l); });
      for (const row of rowChars) if (row.length > cols) cols = row.length;
      const w = cols * fs, h = lines.length * fs;
      const c = document.createElement('canvas');
      c.width = Math.max(1, w); c.height = Math.max(1, h);
      c.style.cssText = 'position:absolute;left:0;top:0;';
      const ctx = c.getContext('2d');
      ctx.font = ctxKey;
      ctx.textBaseline = 'top';
      ctx.fillStyle = colorToCss(this._format.color === undefined ? 0xFFFFFF : this._format.color);
      // outline (legacy borderStyle -> CommentConfig ink GlowFilter):
      // canvas equivalent = shadowBlur glow, drawn once (static content);
      // non-black text -> black outline, black text -> white outline
      const dark = (this._format.color === undefined) || (this._format.color !== 0);
      ctx.shadowColor = dark ? 'rgba(0,0,0,0.9)' : 'rgba(255,255,255,0.9)';
      ctx.shadowBlur = Math.max(1, Math.min(2, fs / 16));
      this._glowPasses = 2;
      for (let pass = 0; pass < 2; pass++) {
      if (pass === 1) ctx.shadowBlur = 0;
      for (let r = 0; r < rowChars.length; r++) {
        const row = rowChars[r];
        let x = 0;
        for (let i = 0; i < row.length; i++) {
          const ch = row[i];
          const code = ch.charCodeAt(0);
          if (code >= 0x2580 && code <= 0x259F) {
            // only Block Elements (U+2580-259F) draw as full rects; geometric shapes
            // (circles/triangles) keep glyph rendering - their shape carries meaning
            if (code >= 0x2591) {
              ctx.globalAlpha = (this._format.color === undefined ? 1 : 1) * (code === 0x2591 ? 0.25 : code === 0x2592 ? 0.5 : 0.75);
            }
            ctx.fillRect(x, y(r), fs, fs);
            ctx.globalAlpha = 1;
          } else if (ch !== ' ' && ch !== '\u3000') {
            ctx.fillText(ch, x, y(r));
          }
          const ck = fs + '|' + ch;
          let adv = this._advCache.get(ck);
          if (adv === undefined) { adv = measure.measureText(ch).width; this._advCache.set(ck, adv); }
          x += adv;
        }
      }
      }
      function y(r) { return r * fs; }
      this.el.appendChild(c);
      this._cnv = c;
      this._invalidateMeasure();
    }

    get text() { return this._text; }
    set text(v) {
      this._text = (v === undefined || v === null) ? '' : String(v);
      this._renderCanvas();
    }
    set fontsize(v) {
      this._format.size = Number(v) || 25;
      this.el.style.fontSize = this._format.size + 'px';
      this._renderCanvas();
    }
    set color(v) {
      this._format.color = Number(v) >>> 0;
      this.el.style.color = colorToCss(this._format.color);
      this._renderCanvas();
    }
    set font(v) {
      this._format.font = v;
      this.el.style.fontFamily = mapFont(v);
      this._renderCanvas();
    }

    // legacy complete property (script-overridable teardown hook)
    get complete() { return this._complete; }
    set complete(fn) { this._complete = fn; }

    _fireComplete() {
      if (this._fired) return;
      this._fired = true;
      if (typeof this._complete === 'function') {
        try { this._complete(); } catch (e) { M8.warn('mode7 complete error', e); }
      }
    }

    start() {
      this.visible = true;
      if (this._tw) this._tw.play();
    }

    stop() {
      if (this._tw) this._tw.stop();
      this._fireComplete();
    }
  }

  M8.M8Element = M8Element;
  M8.CommentField = CommentField;
  M8.M8Shape = M8Shape;
  M8.CommentCanvas = CommentCanvas;
  M8.CommentButton = CommentButton;
  M8.CommentBitmap = CommentBitmap;
  M8.BitmapData = BitmapData;
  M8.Mode7Comment = Mode7Comment;
  M8.mapFont = mapFont;
})(typeof window !== 'undefined' ? window : globalThis);
