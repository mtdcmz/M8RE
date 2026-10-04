/* M8 host API - port of tv/bilibili/script/*.as
 * ScriptUtils / ScriptManager / GlobalVariables / ScriptDisplay / ScriptPlayer /
 * ScriptEventManager / ScriptSound / ScriptBitmap(libBitmap) / Storage(libStorage) /
 * CommentScriptFactory (exec entry point)
 */
(function (global) {
  "use strict";
  const M8 = global.M8RE;
  const hasOwn = M8.hasOwn;
  const getTimer = M8.getTimer;
  const colorToCss = M8.colorToCss;

  // ---------------- Timer (flash.utils.Timer semantics) ----------------
  class Timer {
    constructor(delay, repeatCount) {
      this.delay = Number(delay) || 1;
      this.repeatCount = (repeatCount === undefined) ? 0 : repeatCount; // 0 = infinite
      this.currentCount = 0;
      this.running = false;
      this._tid = null;
      this._listeners = {};
      this._dead = false;  // set after clearTimer; blocks queued callbacks
    }

    addEventListener(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    }

    removeEventListener(type, fn) {
      const l = this._listeners[type];
      if (!l) return;
      const i = l.indexOf(fn);
      if (i !== -1) l.splice(i, 1);
    }

    _fire(type) {
      const l = this._listeners[type];
      if (!l) return;
      const ev = { type: type, target: this };
      for (const fn of l.slice()) {
        try { fn(ev); } catch (e) {
          // same listener + same error logs once (prevents per-frame spam)
          if (!fn.__lastErr || fn.__lastErr !== (e && e.message)) {
            fn.__lastErr = e && e.message;
            M8.warn('Timer listener error', e);
          }
        }
      }
    }

    _schedule() {
      const self = this;
      // Frame-synced timing (flash.utils.Timer semantics): Flash fires Timer events
      // on stage frame boundaries (20ms at 30fps = every frame). Raw setTimeout
      // drifts against rendering, making game loops speed up/slow down.
      // Hooked to Ticker frame callbacks so logic stays in sync with rendering.
      if (!this._frameCb) {
        this._frameCb = function () { self._onFrame(); };
      }
      this._lastFire = null;
      M8.Ticker.addFrame(this._frameCb);
    }

    _onFrame() {
      if (!this.running || this._dead) return;
      const now = M8.Ticker._lastFrame;
      if (this._lastFire === null) this._lastFire = now;
      if (now - this._lastFire >= this.delay) {
        this._lastFire = now;
        this.currentCount++;
        this._fire("timer");
        if (this.repeatCount !== 0 && this.currentCount >= this.repeatCount) {
          this.running = false;
          M8.Ticker.removeFrame(this._frameCb);
          this._fire("timerComplete");
        }
      }
    }

    _tick() {
      // legacy path kept for compatibility; unused
      if (!this.running || this._dead) return;
      this.currentCount++;
      this._fire("timer");
      if (this.repeatCount !== 0 && this.currentCount >= this.repeatCount) {
        this.running = false;
        this._fire("timerComplete");
      } else if (this.running) {
        this._schedule();
      }
    }

    start() {
      if (this.running) return;
      // flash.utils.Timer: stop->start resumes (player pause/resume drives
      // onPause->stop / onPlay->start). _dead only means cleared via clearTimer;
      // without resetting it here, one pause kills every interval timer.
      this._dead = false;
      this.running = true;
      this._schedule();
    }

    stop() {
      this.running = false;
      this._dead = true;
      if (this._frameCb) {
        M8.Ticker.removeFrame(this._frameCb);
      }
    }

    reset() {
      this.stop();
      this.currentCount = 0;
    }
  }
  M8.Timer = Timer;

  // ---------------- geometry helpers ----------------
  class Point {
    constructor(x, y) { this.x = x || 0; this.y = y || 0; }
    get length() { return Math.sqrt(this.x * this.x + this.y * this.y); }
    add(p) { return new Point(this.x + p.x, this.y + p.y); }
    subtract(p) { return new Point(this.x - p.x, this.y - p.y); }
    clone() { return new Point(this.x, this.y); }
    toString() { return "(x=" + this.x + ", y=" + this.y + ")"; }
  }

  class Rectangle {
    constructor(x, y, w, h) {
      this.x = x || 0; this.y = y || 0;
      this.width = w || 0; this.height = h || 0;
    }
    get left() { return this.x; }
    get top() { return this.y; }
    get right() { return this.x + this.width; }
    get bottom() { return this.y + this.height; }
    clone() { return new Rectangle(this.x, this.y, this.width, this.height); }
    contains(x, y) { return x >= this.x && x < this.right && y >= this.y && y < this.bottom; }
    toString() { return "(x=" + this.x + ", y=" + this.y + ", w=" + this.width + ", h=" + this.height + ")"; }
  }

  class Matrix {
    constructor(a, b, c, d, tx, ty) {
      this.a = (a === undefined) ? 1 : a;
      this.b = b || 0;
      this.c = c || 0;
      this.d = (d === undefined) ? 1 : d;
      this.tx = tx || 0;
      this.ty = ty || 0;
    }
    createGradientBox(width, height, rotation, tx, ty) {
      this.a = width / 1638.4;
      this.d = height / 1638.4;
      rotation = rotation || 0;
      if (rotation !== 0) {
        const cos = Math.cos(rotation);
        const sin = Math.sin(rotation);
        this.b = sin * this.d;
        this.c = -sin * this.a;
        this.a *= cos;
        this.d *= cos;
      } else {
        this.b = 0;
        this.c = 0;
      }
      this.width = width; this.height = height; this.rotation = rotation; // for gradients
      this.tx = tx || 0;
      this.ty = ty || 0;
    }
    identity() { this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.tx = 0; this.ty = 0; }
    translate(dx, dy) { this.tx += dx; this.ty += dy; }
    scale(sx, sy) { this.a *= sx; this.d *= sy; }
    rotate(angle) {
      const cos = Math.cos(angle), sin = Math.sin(angle);
      const a1 = this.a, c1 = this.c;
      this.a = a1 * cos - this.b * sin;
      this.b = a1 * sin + this.b * cos;
      this.c = c1 * cos - this.d * sin;
      this.d = c1 * sin + this.d * cos;
    }
    clone() { return new Matrix(this.a, this.b, this.c, this.d, this.tx, this.ty); }
  }

  class Vector3D {
    constructor(x, y, z, w) { this.x = x || 0; this.y = y || 0; this.z = z || 0; this.w = (w === undefined) ? 0 : w; }
  }

  class Matrix3D {
    constructor(v) { this.rawData = v || null; }
  }

  class ColorTransform {
    constructor(rM, gM, bM, aM, rO, gO, bO, aO) {
      this.redMultiplier = (rM === undefined) ? 1 : rM;
      this.greenMultiplier = (gM === undefined) ? 1 : gM;
      this.blueMultiplier = (bM === undefined) ? 1 : bM;
      this.alphaMultiplier = (aM === undefined) ? 1 : aM;
      this.redOffset = rO || 0;
      this.greenOffset = gO || 0;
      this.blueOffset = bO || 0;
      this.alphaOffset = aO || 0;
    }
  }

  function TextFormat(font, size, color, bold, italic, underline, align, leftMargin, rightMargin, indent, leading) {
    this.font = font === undefined ? null : font;
    this.size = size === undefined ? null : size;
    this.color = color === undefined ? null : color;
    this.bold = bold === undefined ? null : bold;
    this.italic = italic === undefined ? null : italic;
    this.underline = underline === undefined ? null : underline;
    this.align = align === undefined ? null : align;
    this.leftMargin = leftMargin === undefined ? null : leftMargin;
    this.rightMargin = rightMargin === undefined ? null : rightMargin;
    this.indent = indent === undefined ? null : indent;
    this.leading = leading === undefined ? null : leading;
  }

  M8.Point = Point;
  M8.Rectangle = Rectangle;
  M8.Matrix = Matrix;
  M8.Vector3D = Vector3D;
  M8.Matrix3D = Matrix3D;
  M8.ColorTransform = ColorTransform;
  M8.TextFormat = TextFormat;

  // ---------------- ScriptUtils ----------------
  class ScriptUtils {
    constructor(scriptManager) {
      this._scriptManager = scriptManager;
    }

    hue(h) {
      h = M8.int(h);
      const a = [0, 120, 240];
      const b = [124, 240, 360];
      const c = [240, 360, 480];
      let r = 0, g = 0, bl = 0;
      h %= 360;
      if (h > a[0] && h < a[2]) {
        r = 100 - 50 * Math.abs(h - a[1]) / 120;
      }
      if (h > b[0] && h < b[2]) {
        g = 100 - 50 * Math.abs(h - b[1]) / 120;
      }
      if (h > c[0] && h <= c[1]) {
        bl = 100 - 50 * Math.abs(h - c[1]) / 120;
      } else if (h + 360 >= c[1] && h + 360 < c[2]) {
        bl = 100 - 50 * Math.abs(h + 360 - c[1]) / 120;
      }
      return (M8.int(r * 255 / 100) << 16) | (M8.int(g * 255 / 100) << 8) | M8.int(bl * 255 / 100);
    }

    rgb(r, g, b) {
      return (r << 16) | (g << 8) | b;
    }

    formatTimes(sec) {
      sec = Number(sec) || 0;
      if (sec < 0) {
        return "-" + this.formatTimes(-sec);
      }
      const s = Math.floor(sec % 60);
      const m = Math.floor(sec / 60);
      return (m < 10 ? "0" : "") + m.toString() + ":" + ("0" + s.toString()).slice(-2);
    }

    delay(f, time) {
      if (time === undefined) time = 1000;
      if (time < 1) time = 1;
      const self = this;
      let t = 0;
      t = setTimeout(function () {
        self._scriptManager.popTimeout(t);
        try { f(); } catch (e) { M8.warn('delay error', e); }
      }, time);
      this._scriptManager.pushTimeout(t);
      return t;
    }

    interval(f, time, times) {
      if (time === undefined) time = 1000;
      if (times === undefined) times = 1;
      const timer = new Timer(time, times);
      const self = this;
      const timerHandler = function () { f(); };
      const completeHandler = function () {
        self._scriptManager.popTimer(timer);
        timer.removeEventListener("timer", timerHandler);
        timer.removeEventListener("timerComplete", completeHandler);
      };
      this._scriptManager.pushTimer(timer);
      timer.addEventListener("timer", timerHandler);
      timer.addEventListener("timerComplete", completeHandler);
      timer.start();
      return timer;
    }

    distance(x1, y1, x2, y2) {
      return Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1));
    }

    rand(min, max) {
      return Math.floor(min + Math.random() * (max - min));
    }

    clone(obj) {
      return M8.clone(obj);
    }

    foreach(obj, f) {
      for (const k in obj) {
        f.call(null, k, obj[k]);
      }
    }
  }

  // ---------------- ScriptManager (lifecycle) ----------------
  class ScriptManager {
    constructor() {
      this._elements = new Set();
      this._timers = new Set();
      this._timeouts = new Set();   // raw setTimeout ids (delay/commentTrigger/keyTrigger)
      this.commentTriggerManager = new CommentTriggerManager();
      this.eventManager = null; // ScriptEventManager, backfilled by factory
    }

    pushTimeout(id) { if (id != null) this._timeouts.add(id); }
    popTimeout(id) { if (id == null) return; try { this._timeouts.delete(id); clearTimeout(id); } catch (e) { } }
    clearTimeouts() {
      for (const id of Array.from(this._timeouts)) {
        try { this._timeouts.delete(id); clearTimeout(id); } catch (e) { }
      }
    }

    // player linkage (invoked by main)
    onPlay() {
      for (const el of this._elements) {
        if (el.motionManager) el.motionManager.play();
      }
      for (const t of this._timers) {
        if (t instanceof Timer) t.start();
      }
    }

    onPause() {
      for (const el of this._elements) {
        if (el.motionManager) el.motionManager.stop();
      }
      for (const t of this._timers) {
        if (t instanceof Timer) t.stop();
      }
    }

    onComplete() {
      for (const el of this._elements) {
        el.visible = false;
      }
    }

    onSeek(tMs) {
      for (const el of this._elements) {
        if (el.motionManager) {
          el.visible = el.motionManager.forcasting(tMs);
        }
      }
    }

    pushTimer(t) { this._timers.add(t); }

    popTimer(t) {
      try {
        this._timers.delete(t);
        t.stop();
      } catch (e) { }
    }

    clearTimer() {
      this.clearTimeouts();
      for (const t of Array.from(this._timers)) {
        try {
          this._timers.delete(t);
          t.stop();
        } catch (e) { }
      }
    }

    pushEl(el) { this._elements.add(el); }

    popEl(el) {
      try {
        this._elements.delete(el);
        if (el.motionManager) el.motionManager.stop();
        el.remove();
      } catch (e) { }
    }

    clearEl() {
      for (const el of Array.from(this._elements)) {
        try {
          this._elements.delete(el);
          if (el.motionManager) el.motionManager.stop();
          el.remove();
        } catch (e) { }
      }
    }

    clearTrigger() {
      if (this.eventManager) this.eventManager.removeAll();
      this.commentTriggerManager.removeAll();
    }
  }

  // ---------------- comment triggers ----------------
  class CommentTriggerManager {
    constructor() {
      this._triggers = new Set();
    }
    addTrigger(fn) { this._triggers.add(fn); }
    removeTrigger(fn) { this._triggers.delete(fn); }
    removeAll() { this._triggers.clear(); }
    dispatch(data) {
      for (const fn of Array.from(this._triggers)) {
        try { fn(data); } catch (e) { M8.warn('commentTrigger error', e); }
      }
    }
  }

  // ---------------- keyboard events ----------------
  class ScriptEventManager {
    constructor() {
      this.hooks = [];
      this.hooksUp = [];
      this._bound = null;
      this._boundUp = null;
    }

    attach() {
      if (this._bound) return;
      this._bound = this._keyDown.bind(this);
      this._boundUp = this._keyUp.bind(this);
      document.addEventListener('keydown', this._bound, true);
      document.addEventListener('keyup', this._boundUp, true);
    }

    detach() {
      if (!this._bound) return;
      document.removeEventListener('keydown', this._bound, true);
      document.removeEventListener('keyup', this._boundUp, true);
      this._bound = null;
      this._boundUp = null;
    }

    _allow(code) {
      // legacy whitelist: ESC / numpad 0-9 / PgDn End Home arrows / W S A D
      return code == 27 || (code >= 96 && code <= 105) || (code >= 34 && code <= 40) ||
        code == 87 || code == 83 || code == 65 || code == 68;
    }

    _keyDown(ev) {
      if (!this.hooks.length) return;
      const code = ev.keyCode;
      if (!this._allow(code)) return;
      if (ev.repeat) { /* key repeat: legacy Flash re-dispatches too */ }
      ev.preventDefault();
      ev.stopPropagation();
      for (const f of this.hooks.slice()) {
        try { f(code); } catch (e) { }
      }
    }

    _keyUp(ev) {
      if (!this.hooksUp.length) return;
      const code = ev.keyCode;
      if (!this._allow(code)) return;
      ev.preventDefault();
      ev.stopPropagation();
      for (const f of this.hooksUp.slice()) {
        try { f(code); } catch (e) { }
      }
    }

    addKeyboardHook(fn, isUp) {
      this.attach();
      if (isUp) this.hooksUp.push(fn);
      else this.hooks.push(fn);
    }

    removeKeyboardHook(fn, isUp) {
      if (isUp) {
        const i = this.hooksUp.indexOf(fn);
        if (i !== -1) this.hooksUp.splice(i, 1);
      } else {
        const i = this.hooks.indexOf(fn);
        if (i !== -1) this.hooks.splice(i, 1);
      }
    }

    removeAll() {
      this.hooks = [];
      this.hooksUp = [];
    }
  }

  // ---------------- global variables dictionary ----------------
  class GlobalVariables {
    constructor() {
      this._dict = {};
    }
    _set(key, value) { this._dict[key] = value; }
    _get(key) { return this._dict[key]; }
    _(key) { return this._dict[key]; }
  }

  // ---------------- ScriptDisplay (display factory) ----------------
  class ScriptDisplay {
    constructor(player, layer, scriptManager) {
      this._layer = layer;        // M8Root (overlay container)
      this._player = player;      // player adapter
      this._scriptManager = scriptManager;
      this._defaultConfig = {
        x: 0, y: 0, z: null, scale: 1, alpha: 1,
        parent: this._layer, lifeTime: 3, motion: null
      };
    }

    static extend(config, defaults) {
      for (const k in defaults) {
        if (!hasOwn(config, k)) {
          config[k] = defaults[k];
        }
      }
      if (hasOwn(defaults, "motion") && config["motion"] === null) {
        config.motion = {};
      }
    }

    setupMotionElement(config, elm) {
      const complete = function () {
        if (elm.parent) {
          elm.parent.removeChild(elm);
        }
        this._scriptManager.popEl(elm);
      }.bind(this);
      if (elm.motionManager == null) {
        elm.motionManager = new M8.MotionManager(elm);
      }
      elm.motionManager.setPlayTime(this._player.time);
      if (config.motionGroup) {
        elm.motionManager.initTweenGroup(config.motionGroup, config.lifeTime);
      } else {
        const motionConfig = config.motion;
        if (motionConfig === undefined || motionConfig === null) {
          // legacy: motion always present (extend guarantees it)
          config.motion = {};
        }
        const mc = config.motion;
        if (isNaN(mc.lifeTime)) {
          mc.lifeTime = config.lifeTime;
        }
        if (mc.lifeTime < 0) {
          mc.lifeTime = 0.001;
        }
        elm.motionManager.initTween(mc);
      }
      elm.motionManager.setCompleteListener(complete);
      this._scriptManager.pushEl(elm);
      if (config.parent && typeof config.parent.addChild === 'function') {
        config.parent.addChild(elm);
      } else {
        this._layer.addChild(elm);
      }
      if (this._player.state == "playing") {
        elm.motionManager.play();
      }
    }

    get fullScreenWidth() { return screen.width; }
    get fullScreenHeight() { return screen.height; }
    get screenWidth() { return screen.width; }
    get screenHeight() { return screen.height; }
    // stage size from host cache (layoutOverlay), avoiding per-frame reflow
    get stageWidth() { return (this._layer._stageW != null) ? this._layer._stageW : this._layer.width; }
    get stageHeight() { return (this._layer._stageH != null) ? this._layer._stageH : this._layer.height; }
    get width() { return this.stageWidth; }
    get height() { return this.stageHeight; }
    get root() { return this._layer; }

    get frameRate() { return M8.Ticker.frameRate; }
    set frameRate(v) {
      if (v > 0 && v < 120) M8.Ticker.setFrameRate(v);
    }

    createComment(text, config) {
      config = config || {};
      ScriptDisplay.extend(config, this._defaultConfig);
      ScriptDisplay.extend(config, { color: 0xFFFFFF, font: "黑体", fontsize: 25 });
      const field = new M8.CommentField();
      field.text = text;
      this._initFieldStyle(field, config);
      this.setupMotionElement(config, field);
      return field;
    }

    _initFieldStyle(field, config) {
      field.x = config.x;
      field.y = config.y;
      field.z = config.z;
      field.alpha = config.alpha;
      field.scale = config.scale;
      field.font = config.font;
      field.fontsize = config.fontsize;
      field.color = config.color;
      // AS3 CommentField.initStyle: default ink GlowFilter
      // CommentConfig.getFilterByColor: black outline, or white on black text
      field._applyDefaultGlow();
    }

    createShape(config) {
      config = config || {};
      ScriptDisplay.extend(config, this._defaultConfig);
      const shape = new M8.M8Shape();
      shape.x = config.x;
      shape.y = config.y;
      shape.z = config.z;
      shape.alpha = config.alpha;
      shape.scale = config.scale;
      this.setupMotionElement(config, shape);
      return shape;
    }

    createCanvas(config) {
      config = config || {};
      ScriptDisplay.extend(config, this._defaultConfig);
      const canvas = new M8.CommentCanvas();
      canvas.x = config.x;
      canvas.y = config.y;
      canvas.z = config.z;
      canvas.alpha = config.alpha;
      canvas.scale = config.scale;
      this.setupMotionElement(config, canvas);
      return canvas;
    }

    createButton(config) {
      config = config || {};
      ScriptDisplay.extend(config, this._defaultConfig);
      ScriptDisplay.extend(config, { text: "Button", width: 60, height: 30 });
      const cb = new M8.CommentButton();
      cb.initStyle(config);
      cb.text = config.text;
      if (config.onclick) {
        cb.el.addEventListener('click', function () {
          config.onclick();
        });
      }
      this.setupMotionElement(config, cb);
      return cb;
    }

    createTextField() {
      return new M8.CommentField();
    }

    createTextFormat(font, size, color, bold, italic, underline, align, leftMargin, rightMargin, indent, leading) {
      return new TextFormat(font, size, color, bold, italic, underline, align, leftMargin, rightMargin, indent, leading);
    }

    createMatrix(a, b, c, d, tx, ty) {
      return new Matrix(a, b, c, d, tx, ty);
    }

    createGradientBox(w, h, rot, tx, ty) {
      const m = new Matrix();
      m.createGradientBox(w, h, rot, tx, ty);
      return m;
    }

    createPoint(x, y) { return new Point(x, y); }
    createRectangle(x, y, w, h) { return new Rectangle(x, y, w, h); }
    createVector3D(x, y, z, w) { return new Vector3D(x, y, z, w); }
    createMatrix3D(v) { return new Matrix3D(v); }
    createColorTransform(rM, gM, bM, aM, rO, gO, bO, aO) {
      return new ColorTransform(rM, gM, bM, aM, rO, gO, bO, aO);
    }

    toIntVector(arr) { return (arr || []).map(function (v) { return M8.int(v); }); }
    toUIntVector(arr) { return (arr || []).map(function (v) { return M8.uint(v); }); }
    toNumberVector(arr) { return (arr || []).map(function (v) { return Number(v); }); }

    // filter factories: descriptor objects (no direct DOM equivalent)
    createGlowFilter(color, alpha, blurX, blurY, strength, quality, inner, knockout) {
      return { __filter: 'glow', color: color === undefined ? 0xFF0000 : color, alpha: alpha === undefined ? 1 : alpha, blurX: blurX === undefined ? 6 : blurX, blurY: blurY === undefined ? 6 : blurY, strength: strength === undefined ? 2 : strength, quality: quality || 1, inner: !!inner, knockout: !!knockout };
    }
    createBlurFilter(blurX, blurY, quality) {
      return { __filter: 'blur', blurX: blurX || 0, blurY: blurY || 0, quality: quality || 1 };
    }
    createBevelFilter() { return { __filter: 'bevel' }; }
    createColorMatrixFilter(matrix) { return { __filter: 'colormatrix', matrix: matrix || null }; }
    createConvolutionFilter() { return { __filter: 'convolution' }; }
    createDisplacementMapFilter() { return { __filter: 'displacement' }; }
    createDropShadowFilter(distance, angle, color, alpha, blurX, blurY, strength, quality) {
      return { __filter: 'dropshadow', distance: distance === undefined ? 4 : distance, angle: angle === undefined ? 45 : angle, color: color === undefined ? 0 : color, alpha: alpha === undefined ? 1 : alpha, blurX: blurX === undefined ? 4 : blurX, blurY: blurY === undefined ? 4 : blurY, strength: strength === undefined ? 1 : strength, quality: quality || 1 };
    }
    createGradientBevelFilter() { return { __filter: 'gradientbevel' }; }
    createGradientGlowFilter() { return { __filter: 'gradientglow' }; }
  }

  // ---------------- ScriptPlayer (player control) ----------------
  class ScriptPlayer {
    constructor(adapter, config, scriptManager) {
      this._adapter = adapter;   // {play,pause,seek,jump,state,time,width,height,videoWidth,videoHeight,commentList}
      this._config = config;
      this._manager = scriptManager;
      this.scriptEventManager = new ScriptEventManager();
      this._commentTimeouts = new Map();
    }

    play() {
      if (!this._config.isPlayerControlApiEnable) return;
      this._adapter.play();
    }

    pause() {
      if (!this._config.isPlayerControlApiEnable) return;
      this._adapter.pause();
    }

    seek(offset) {
      if (!this._config.isPlayerControlApiEnable) return;
      this._adapter.seek(offset / 1000);
    }

    jump(av, page, newWindow) {
      if (!this._config.isPlayerControlApiEnable) return;
      this._adapter.jump(av, page, newWindow);
    }

    get state() { return this._adapter.state; }
    get time() { return this._adapter.time; }

    commentTrigger(func, timeout) {
      if (timeout === undefined) timeout = 1000;
      if (!this._config.isPlayerControlApiEnable) return 0;
      this._manager.commentTriggerManager.addTrigger(func);
      const self = this;
      let timer = 0;
      timer = setTimeout(function () {
        self._manager.popTimeout(timer);
        self._manager.commentTriggerManager.removeTrigger(func);
      }, timeout);
      this._manager.pushTimeout(timer);
      return timer;
    }

    keyTrigger(func, timeout, isUp) {
      if (timeout === undefined) timeout = 1000;
      if (!this._config.isPlayerControlApiEnable) return 0;
      this.scriptEventManager.addKeyboardHook(func, isUp);
      const self = this;
      let timer = 0;
      timer = setTimeout(function () {
        self._manager.popTimeout(timer);
        self.scriptEventManager.removeKeyboardHook(func, isUp);
      }, timeout);
      this._manager.pushTimeout(timer);
      return timer;
    }

    setMask(obj) {
      // DOM player has no full-stage mask; no-op (legacy anti-danmaku trick)
      M8.log('Player.setMask: not supported, ignored');
    }

    createSound(name, onLoad) {
      if (!this._config.isPlayerControlApiEnable) return null;
      return new ScriptSound(name, onLoad);
    }

    get commentList() {
      if (!this._config.isPlayerControlApiEnable) return [];
      return this._adapter.commentList;
    }

    get refreshRate() { return 0; }
    set refreshRate(v) { }
    get width() { return this._adapter.width; }
    get height() { return this._adapter.height; }
    get videoWidth() { return this._adapter.videoWidth; }
    get videoHeight() { return this._adapter.videoHeight; }
    get isContinueMode() { return false; }
  }

  // ---------------- ScriptSound ----------------
  class ScriptSound {
    constructor(name, onLoad) {
      this._audio = new Audio('/static/soundlib/' + name + '.mp3');
      this._loaded = false;
      const self = this;
      if (onLoad != null) {
        this._audio.addEventListener('canplaythrough', function () {
          if (!self._loaded) {
            self._loaded = true;
            onLoad();
          }
        });
      }
      this._audio.load();
    }

    loadPercent() {
      if (this._audio.duration && this._audio.buffered.length) {
        return Math.floor(100 * this._audio.buffered.end(this._audio.buffered.length - 1) / this._audio.duration);
      }
      return 0;
    }

    play(offset, loops) {
      try {
        if (offset) this._audio.currentTime = offset / 1000;
        this._audio.loop = loops > 0;
        const p = this._audio.play();
        if (p && p.catch) p.catch(function () { });
      } catch (e) { }
    }

    stop() {
      try { this._audio.pause(); } catch (e) { }
    }

    remove() {
      try {
        this._audio.pause();
        this._audio.src = '';
      } catch (e) { }
    }
  }

  // ---------------- libBitmap (ScriptBitmap) ----------------
  class ScriptBitmap {
    constructor(globals, clip, manager) {
      this.scope = globals;
      this.clip = clip;
      this.manager = manager;
    }

    createBitmapData(width, height, transparent, fillColor) {
      return new M8.BitmapData(width, height, transparent, fillColor);
    }

    createRectangle(x, y, w, h) {
      return new Rectangle(x, y, w, h);
    }

    createBitmap(config) {
      config = config || {};
      if (config.pixelSnapping === undefined) config.pixelSnapping = "auto";
      if (config.smoothing === undefined) config.smoothing = false;
      const bm = new M8.CommentBitmap(config.bitmapData);
      const display = this.scope["Display"];
      const defaults = display._defaultConfig;
      ScriptDisplay.extend(config, defaults);
      display.setupMotionElement(config, bm);
      if (config.scale !== undefined) {
        bm.scaleX = config.scale;
        bm.scaleY = config.scale;
      }
      return bm;
    }

    createParticle(config) {
      // simplified particle burst: snapshot pixels of the target element
      const param = config || {};
      const pic = param.obj;
      if (pic === undefined || !pic.el) return null;
      const radius = (param.radius === undefined) ? 200 : M8.int(param.radius);
      const w = pic.el.width || pic.el.offsetWidth || 0;
      const h = pic.el.height || pic.el.offsetHeight || 0;
      if (!w || !h) return null;

      const start = getTimer();
      const bm = new M8.BitmapData(w, h, true, 0);
      bm.draw(pic);
      const bw = w + radius * 2, bh = h + radius * 2;
      const bmd = new M8.BitmapData(bw, bh, true, 0);
      const bms = new M8.CommentBitmap(bmd);
      this.clip.addChild(bms);
      bms.x = 0; bms.y = 0;

      // one getImageData for all pixels (per-pixel getPixel32 was w*h calls)
      const imgData = bm._ctx.getImageData(0, 0, w, h).data;
      const particles = [];
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          const idx = (j * w + i) * 4;
          const a = imgData[idx + 3];
          if (a !== 0) {
            const c = (a << 24 | imgData[idx] << 16 | imgData[idx + 1] << 8 | imgData[idx + 2]) >>> 0;
            bmd.setPixel32(i + radius, j + radius, c);
            particles.push({
              x: i + radius, y: j + radius,
              vx: (Math.random() - Math.random()) * 5,
              vy: (Math.random() - Math.random()) * 5,
              life: 0.5 + Math.random() * 5,
              color: c
            });
          }
        }
      }
      bm.dispose();
      bmd._ctx.putImageData(bmd._ctx.getImageData(0, 0, bw, bh), 0, 0); // sync backing

      let out = 0;
      const ctx = bmd._ctx;
      const bmsEl = bms;
      const ef = function () {
        ctx.clearRect(0, 0, bw, bh);
        out = 0;
        for (const p of particles) {
          p.x += p.vx; p.y += p.vy; p.vy += 0.2;
          p.life -= 1 / 24;
          if (p.life > 0) {
            ctx.fillStyle = 'rgba(' + ((p.color >>> 16) & 0xff) + ',' + ((p.color >>> 8) & 0xff) + ',' + (p.color & 0xff) + ',1)';
            ctx.fillRect(p.x | 0, p.y | 0, 1, 1);
          } else {
            out++;
          }
        }
        if (out / particles.length > 0.8) {
          bmsEl.removeEventListener("enterFrame", ef);
          bmsEl.remove();
          bmd.dispose();
          M8.log("Particle Done @ " + (getTimer() - start));
        }
      };
      bms.addEventListener("enterFrame", ef);
      return bms;
    }
  }

  // ---------------- libStorage ----------------
  function makeStorageLib(cid) {
    const KEY = 'm8re_storage_' + (cid || 'global');
    let cache = null;
    try {
      const raw = global.localStorage ? localStorage.getItem(KEY) : null;
      if (raw) cache = JSON.parse(raw);
    } catch (e) { }
    const store = {
      saveData: function (data) {
        cache = data;
        try {
          if (global.localStorage) localStorage.setItem(KEY, JSON.stringify(data));
          if (global.chrome && chrome.storage && chrome.storage.local) {
            chrome.storage.local.set({ [KEY]: data });
          }
        } catch (e) { }
        return true;
      },
      loadData: function () {
        return cache;
      },
      loadRank: function (complete, err) {
        // legacy server ranking is gone; local fallback
        try {
          if (global.chrome && chrome.storage && chrome.storage.local) {
            chrome.storage.local.get(['m8re_rank_' + (cid || 'global')], function (r) {
              complete((r && r['m8re_rank_' + (cid || 'global')]) || []);
            });
          } else {
            complete([]);
          }
        } catch (e) {
          if (err) err(e);
        }
      },
      uploadScore: function (score, name) {
        try {
          if (global.chrome && chrome.storage && chrome.storage.local) {
            const rk = 'm8re_rank_' + (cid || 'global');
            chrome.storage.local.get([rk], function (r) {
              const list = (r && r[rk]) || [];
              list.push({ name: name || '', score: score, time: Date.now() });
              list.sort(function (a, b) { return b.score - a.score; });
              const top = list.slice(0, 20);
              const o = {}; o[rk] = top;
              chrome.storage.local.set(o);
            });
          }
        } catch (e) { }
        return true;
      }
    };
    return store;
  }

  // ---------------- CommentScriptFactory (runtime entry) ----------------
  class CommentScriptFactory {
    constructor() {
      this._display = null;
      this._player = null;
      this._utils = null;
      this._global = null;
      this._scriptManager = null;
      this.globals = null;
      this.config = {
        scriptEnabled: true,
        isPlayerControlApiEnable: true
      };
      this.cid = '';
      this.innerLibs = ["libBitmap", "libStorage"];
    }

    initial(playerAdapter, rootLayer) {
      this._scriptManager = new ScriptManager();
      this._player = new ScriptPlayer(playerAdapter, this.config, this._scriptManager);
      this._scriptManager.eventManager = this._player.scriptEventManager;
      this._display = new ScriptDisplay(playerAdapter, rootLayer, this._scriptManager);
      this._utils = new ScriptUtils(this._scriptManager);
      this._global = new GlobalVariables();
      const self = this;
      this.globals = {
        "trace": function () { M8.log.apply(null, Array.prototype.slice.call(arguments)); },
        "clear": function () { M8.clearLog(); },
        "getTimer": getTimer,
        "clearTimeout": function (id) { clearTimeout(id); },
        "parseInt": parseInt,
        "parseFloat": parseFloat,
        "Math": Math,
        "String": String,
        "interval": function (f, t, n) { return self._utils.interval(f, t, n); },
        "timer": function (f, t) { return self._utils.delay(f, t); },
        "clone": function (o) { return self._utils.clone(o); },
        "foreach": function (o, f) { return self._utils.foreach(o, f); },
        "Utils": this._utils,
        "Player": this._player,
        "Display": this._display,
        "$": this._display,
        "Global": this._global,
        "$G": this._global,
        "ScriptManager": this._scriptManager,
        "Tween": M8.BetweenAS3,
        "TweenEasing": M8.TweenEasingLib
      };
      const bitmapLib = new ScriptBitmap(this.globals, this._display.root, this._scriptManager);
      this.globals.Bitmap = bitmapLib;
    }

    installGlobals(vm) {
      const g = vm.getGlobalObject();
      for (const k in this.globals) {
        g[k] = this.globals[k];
      }
    }

    _installLib(vm, lib) {
      if (lib === "libStorage") {
        vm.getGlobalObject()["Storage"] = makeStorageLib(this.cid);
        return true;
      }
      if (lib === "libBitmap") {
        return true; // built in
      }
      return false;
    }

    exec(script, debugInfo) {
      if (debugInfo === undefined) debugInfo = true;
      if (!this.config.scriptEnabled) return;
      // Legacy protobuf path (CommentDataParser L185-191) applies no
      // normalization to mode 8 text (text_string is mode<7 only); source text
      // reaches the engine verbatim: comments, escapes, split("\n") all behave.
      // Exception: 2012-era scripts lost real newlines in modern storage and
      // carry literal "/n". Restore to "\n" only when the script has no real
      // newlines at all (Scanner treats \r as space; line comments end at \n).
      
      script = String(script);
      if (script.indexOf('\n') < 0 && script.indexOf('\r') < 0 && script.indexOf('/n') >= 0) {
        script = script.replace(/\/n/g, '\n');
      }
      script = script.replace(/\r\n?/g, '\n');
      const vm = new M8.VirtualMachine();
      this.installGlobals(vm);
      const self = this;
      vm.getGlobalObject().load = function (lib, callback) {
        if (self.innerLibs.indexOf(lib) !== -1) {
          self._installLib(vm, lib);
          callback();
          return;
        }
        M8.log("importExtendLibrary : unknown lib " + lib);
      };
      let startTime = 0;
      if (debugInfo && M8.isDebug()) startTime = getTimer();
      const s = new M8.Scanner(script);
      const p = new M8.Parser(s);
      vm.rewind();
      vm.setByteCode(p.parse(vm));
      const ret = vm.execute();
      // Paint script-created graphics synchronously at exec end. Graphics are
      // normally flushed on the next Ticker tick; that one-frame gap showed as
      // black flashes between phase scripts that recreate the background
      // (clearEl removes the old bg, the new one painted a frame later).
      if (M8.Graphics && M8.Graphics.flushAll) M8.Graphics.flushAll();
      if (debugInfo && M8.isDebug()) {
        M8.log("Execute in " + (getTimer() - startTime) + "ms");
      }
      return ret;
    }

    get scriptManager() { return this._scriptManager; }
    get player() { return this._player; }
    get display() { return this._display; }
  }

  M8.ScriptUtils = ScriptUtils;
  M8.ScriptManager = ScriptManager;
  M8.CommentTriggerManager = CommentTriggerManager;
  M8.ScriptEventManager = ScriptEventManager;
  M8.GlobalVariables = GlobalVariables;
  M8.ScriptDisplay = ScriptDisplay;
  M8.ScriptPlayer = ScriptPlayer;
  M8.ScriptBitmap = ScriptBitmap;
  M8.CommentScriptFactory = CommentScriptFactory;

  // ---------------- NativeCommentLayer ----------------
  // Mirrors legacy CommentManager.time: advances with playback and mounts
  // arriving comments on root with Event.ADDED (bubbles). Scripts hook via
  // $.root.addEventListener("added", added) to take over danmaku:
  //   - check e.target.selectable (native=true) -> clone -> removeChild
  //   - non-hooking scripts: layer renders itself (see setTakeover)
  // Elements are only created when root has an 'added' listener.
  class NativeCommentLayer {
    constructor(root, scriptManager, adapter, onSpawn) {
      this.root = root;
      this._sm = scriptManager;
      this._adapter = adapter;
      this._onSpawn = onSpawn || null;   // host callback on first spawn (hide native layer)
      this._list = [];            // CommentData sorted by stime
      this._ptr = 0;
      this._lastPos = -1;
      this._active = new Set();   // spawned danmaku (cleaned up on teardown)
      this._lanes = [];           // ScrollCommentSpaceManager lane table
    }
    setComments(list) {
      this._list = (list || []).slice().sort(function (a, b) { return a.stime - b.stime; });
      this._ptr = 0; this._lastPos = -1;
    }
    _hasListener() {
      const l = this.root._listeners && this.root._listeners['added'];
      return !!(l && l.length);
    }
    _bsearch(t) {
      const a = this._list; const n = a.length;
      if (n === 0) return 0;
      if (t < a[0].stime) return 0;
      if (t >= a[n - 1].stime) return n;
      let lo = 0, hi = n - 1;
      while (lo <= hi) {
        const mid = (lo + hi + 1) >> 1;
        if (a[mid - 1].stime <= t && a[mid].stime > t) return mid;
        if (a[mid - 1].stime > t) hi = mid - 1; else lo = mid;
      }
      return n;
    }
    tick(tSec) {
      const list = this._list;
      if (list.length === 0) return;
      // legacy 1ms lead; negative t unclamped so replays work after seek to 0
      const t = tSec - 0.001;
      // Legacy CommentManager.time: |jump|>=2 or exhausted pointer -> bsearch.
      // Live danmaku are not purged (legacy behavior; complete removes them).
      if (Math.abs(t - this._lastPos) >= 2 || this._lastPos < 0) {
        this._ptr = this._bsearch(t);
        this._lastPos = t;
        if (list.length <= this._ptr) return;
      } else {
        this._lastPos = t;
      }
      if (!this._hasListener()) {
        // no listener: advance pointer only, create nothing
        while (this._ptr < list.length && list[this._ptr].stime <= t) this._ptr++;
        return;
      }
      while (this._ptr < list.length && list[this._ptr].stime <= t) {
        const data = list[this._ptr];
        this._ptr++;
        // legacy validate: skip if data.on still live; drop blocked
        if (data.on) continue;
        if (data.blocked) continue;
        this._spawn(data);
      }
    }
    _spawn(data) {
      try {
        // A script hooks added -> tell host to hide the native scroll/adv layers
        // (else danmaku renders twice; cmd-dm buttons and BAS layer unaffected)
        if (typeof this._onSpawn === 'function') {
          try { this._onSpawn(); } catch (e) { }
        }
        // mode8 is never rendered as text - content is script source for the VM;
        // scripts iterate the list via Player.commentList.
        if (data.mode === 8) return;
        const self = this;
        if (data.mode === 7) {
          // mode7: FixedPosComment semantics (pos/fade/motion/path + overridable complete)
          const m7 = new M8.Mode7Comment(data, this._adapter.width, this._adapter.height);
          m7.complete = function () {
            data.on = false;
            try { if (m7._parent) m7._parent.removeChild(m7); } catch (e) { }
          };
          this.root.addChild(m7);   // dispatches Event.ADDED (scripts may re-hook)
          data.on = true;
          m7.start();
          this._active.add(m7);
          return;
        }
        // scroll/top/bottom danmaku: ADDED event carriers only (legacy scripts
        // received them via stage-child ADDED), for clone/removeChild takeover.
        // display:none + recycled after ~8s; otherwise tens of thousands of
        // nodes accumulate in the overlay (the "many danmaku = lag" cause).
        // On-screen rendering stays with the player (no double display).
        const f = new M8.CommentField();
        f.data = data;                   // legacy Comment exposes .data (own property)
        f.text = data.text != null ? data.text : '';
        if (data.color != null) f.color = data.color;
        if (data.fontsize != null) f.fontsize = data.fontsize;
        if (data.font) f.font = data.font;
        f._selectable = true;            // native TextField is selectable (scripts detect)
        // Legacy ScrollCommentSpaceManager: a scroll danmaku is placed in the
        // first vertical lane where it cannot catch the previous occupant
        // (time-based vCheck); when the screen is full the danmaku is DROPPED.
        // Without this, today's 10+ year danmaku pools all spawn and overlap.
        const scrollMode = (data.mode === 1 || data.mode === 2 || data.mode === 3 || data.mode === 6);
        if (scrollMode) {
          const now2 = data.stime;
          const w2 = Math.max(1, f.width);
          const h2 = Math.max(1, f.height);
          const W = this._adapter.width || 800;
          const speed = (W + w2) / 6;              // legacy: 6s full crossing at speede=1
          const middleTime = now2 + W / speed;      // head reaches the left edge
          this._lanes = this._lanes.filter(function (en) { return en.exitTime > now2; });
          const self2 = this;
          const vCheck = function (yTop) {
            const yBottom = yTop + h2;
            for (const en of self2._lanes) {
              if (en.yTop >= yBottom || en.yBottom <= yTop) continue;
              if (en.exitTime > middleTime) return false;
            }
            return true;
          };
          let placed = -1;
          let y = 0;
          const H = this._adapter.height || 450;
          while (y + h2 <= H) {
            if (vCheck(y)) { placed = y; break; }
            y += h2;
          }
          if (placed < 0) {
            // Legacy setY recurses into pool+1 and places at its top - never
            // drops. Helper scripts (danmus[0]) rely on every danmaku arriving.
            placed = 0;
          }
          this._lanes.push({ yTop: placed, yBottom: placed + h2, exitTime: now2 + 6, stime: now2 });
          f.y = placed;
        }
        f.x = (this._adapter.width) ? this._adapter.width : 0; // off right edge (scripts reposition)
        f.y = 0;
        f.el.style.display = 'none';
        this.root.addChild(f);     // dispatches Event.ADDED (scripts may clone)
        this._active.add(f);
        // No on flag: scroll danmaku count as finished (legacy replays them
        // on seek-back; replayable games rely on that via added handlers)
        setTimeout(function () {
          self._active.delete(f);
          try { if (f._parent === self.root) self.root.removeChild(f); } catch (e) { }
        }, 8000);
      } catch (e) { /* one bad entry must not break the rest */ }
    }
    _purgeActive() {
      for (const f of Array.from(this._active)) {
        try { if (f._parent === this.root) this.root.removeChild(f); } catch (e) { }
      }
      this._active.clear();
    }
    clear() { this._purgeActive(); this._list = []; this._ptr = 0; this._lastPos = -1; }
  }
  M8.NativeCommentLayer = NativeCommentLayer;
})(typeof window !== 'undefined' ? window : globalThis);
