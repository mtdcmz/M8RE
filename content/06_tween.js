/* M8 tween engine - BetweenAS3 (org.libspark.betweenas3) compatible port
 * Tween/ITween API (wiki Tween.html) + TweenEasing + global frame loop
 * Used by MotionManager and scripts directly.
 */
(function (global) {
  "use strict";
  const M8 = global.M8RE;

  // ---------------- easing (Penner formulas, BetweenAS3 names) ----------------
  function mk(cls) { return cls; }
  const Easing = {};

  Easing.Linear = {
    easeIn: t => t,
    easeOut: t => t,
    easeInOut: t => t,
    easeNone: t => t
  };
  Easing.Quadratic = Easing.Quad = {
    easeIn: t => t * t,
    easeOut: t => 1 - (1 - t) * (1 - t),
    easeInOut: t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
  };
  Easing.Cubic = {
    easeIn: t => t * t * t,
    easeOut: t => 1 - Math.pow(1 - t, 3),
    easeInOut: t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
  };
  Easing.Quartic = Easing.Quart = {
    easeIn: t => t * t * t * t,
    easeOut: t => 1 - Math.pow(1 - t, 4),
    easeInOut: t => t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2
  };
  Easing.Quintic = Easing.Quint = {
    easeIn: t => t * t * t * t * t,
    easeOut: t => 1 - Math.pow(1 - t, 5),
    easeInOut: t => t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2
  };
  Easing.Sine = {
    easeIn: t => 1 - Math.cos(t * Math.PI / 2),
    easeOut: t => Math.sin(t * Math.PI / 2),
    easeInOut: t => -(Math.cos(Math.PI * t) - 1) / 2
  };
  Easing.Exponential = Easing.Expo = {
    easeIn: t => t === 0 ? 0 : Math.pow(2, 10 * t - 10),
    easeOut: t => t === 1 ? 1 : 1 - Math.pow(2, -10 * t),
    easeInOut: t => t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2
  };
  Easing.Circular = Easing.Circ = {
    easeIn: t => 1 - Math.sqrt(1 - t * t),
    easeOut: t => Math.sqrt(1 - Math.pow(t - 1, 2)),
    easeInOut: t => t < 0.5 ? (1 - Math.sqrt(1 - Math.pow(2 * t, 2))) / 2 : (Math.sqrt(1 - Math.pow(-2 * t + 2, 2)) + 1) / 2
  };
  Easing.Back = {
    easeIn: t => { const c1 = 1.70158, c3 = c1 + 1; return c3 * t * t * t - c1 * t * t; },
    easeOut: t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
    easeInOut: t => {
      const c1 = 1.70158, c2 = c1 * 1.525;
      return t < 0.5 ? (Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2
        : (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2;
    }
  };
  Easing.Elastic = {
    easeIn: t => {
      if (t === 0) return 0; if (t === 1) return 1;
      const c4 = (2 * Math.PI) / 3;
      return -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * c4);
    },
    easeOut: t => {
      if (t === 0) return 0; if (t === 1) return 1;
      const c4 = (2 * Math.PI) / 3;
      return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
    },
    easeInOut: t => {
      if (t === 0) return 0; if (t === 1) return 1;
      const c5 = (2 * Math.PI) / 4.5;
      return t < 0.5
        ? -(Math.pow(2, 20 * t - 10) * Math.sin((20 * t - 11.125) * c5)) / 2
        : (Math.pow(2, -20 * t + 10) * Math.sin((20 * t - 11.125) * c5)) / 2 + 1;
    }
  };
  Easing.Bounce = {
    easeOut: t => {
      const n1 = 7.5625, d1 = 2.75;
      if (t < 1 / d1) return n1 * t * t;
      else if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
      else if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
      else return n1 * (t -= 2.625 / d1) * t + 0.984375;
    },
    easeIn: t => 1 - Easing.Bounce.easeOut(1 - t),
    easeInOut: t => t < 0.5
      ? (1 - Easing.Bounce.easeOut(1 - 2 * t)) / 2
      : (1 + Easing.Bounce.easeOut(2 * t - 1)) / 2
  };

  const TweenEvent = { COMPLETE: "complete", PLAY: "play", STOP: "stop", UPDATE: "update" };

  // ---------------- global frame loop (tweens + enterFrame) ----------------
  // Perf: iteration snapshots rebuilt only on add/remove (_dirty),
  // avoiding per-frame Array.from allocations (GC pressure with many targets).
  const Ticker = {
    _tweens: new Set(),
    _tweensArr: [],
    _frameCbs: new Set(),
    _frameCbsArr: [],
    _dirty: false,
    _lastFrame: 0,
    _frameAcc: 0,
    frameRate: 24,           // Flash stage default
    _rafId: null,
    _running: false,

    _sync() {
      if (!this._dirty) return;
      this._tweensArr = Array.from(this._tweens);
      this._frameCbsArr = Array.from(this._frameCbs);
      this._dirty = false;
    },

    _loop(now) {
      const self = Ticker;
      if (!self._running) return;
      if (self._dirty) self._sync();
      // advance tweens
      const tweens = self._tweensArr;
      for (let i = 0; i < tweens.length; i++) {
        const tw = tweens[i];
        try { tw.__tick(now); } catch (e) { M8.warn('tween error', e); self._tweens.delete(tw); self._dirty = true; }
      }
      // enterFrame dispatch (throttled by frameRate, like the Flash stage)
      const dt = now - self._lastFrame;
      self._lastFrame = now;
      self._frameAcc += dt;
      const interval = 1000 / Math.max(1, Math.min(120, self.frameRate || 24));
      if (self._frameAcc >= interval - 0.5) {
        self._frameAcc = 0;
        const cbs = self._frameCbsArr;
        for (let i = 0; i < cbs.length; i++) {
          try { cbs[i](); } catch (e) { M8.warn('frame cb error', e); }
        }
      }
      // render: flush dirty graphics AFTER the frame's event phase - Flash
      // renders the stage once per frame AFTER enterFrame/timer handlers ran,
      // so remove+create+draw within one handler paints atomically. Flushing
      // before the handlers left a one-frame hole between bg-swap scripts
      // (Utils.interval changeBg): old bg removed, new bg painted next frame
      // -> visible blink at every color switch.
      try { if (M8.Graphics && M8.Graphics.flushAll) M8.Graphics.flushAll(); } catch (e) { }
      self._rafId = global.requestAnimationFrame(self._loop);
    },

    ensure() {
      if (!this._running) {
        this._running = true;
        this._lastFrame = performance.now();
        this._rafId = global.requestAnimationFrame(this._loop);
      }
    },
    stopIfIdle() {
      if (this._tweens.size === 0 && this._frameCbs.size === 0) {
        this._running = false;
        if (this._rafId != null) global.cancelAnimationFrame(this._rafId);
        this._rafId = null;
      }
    },
    addTween(tw) { this._tweens.add(tw); this._dirty = true; this.ensure(); },
    removeTween(tw) { this._tweens.delete(tw); this._dirty = true; },
    addFrame(cb) { this._frameCbs.add(cb); this._dirty = true; this.ensure(); },
    removeFrame(cb) { this._frameCbs.delete(cb); this._dirty = true; },
    setFrameRate(n) { if (n > 0 && n < 120) this.frameRate = n; }
  };
  // Ticker._loop bound to Ticker (no this-binding issues)
  Ticker._loop = Ticker._loop.bind(Ticker);

  // ---------------- ITween base ----------------
  class ITween {
    constructor() {
      this.stopOnComplete = true;
      this._playing = false;
      this._listeners = {};
      this._pos = 0;              // time position (seconds)
      this._lastTick = 0;
    }

    get _duration() { return 0; }

    play() {
      if (this._playing) return;
      this._playing = true;
      this._resetComplete();
      this._lastTick = performance.now();
      this.__onPlayState();
      Ticker.addTween(this);
      this._fire(TweenEvent.PLAY);
    }

    // COMPLETE fires once per play (BetweenAS3); group replays must reset
    // children too, or the second pass never fires the onComplete chain
    _resetComplete() {
      this._completeFired = false;
    }

    stop() {
      if (!this._playing) return;
      this._playing = false;
      Ticker.removeTween(this);
      Ticker.stopIfIdle();
      this._fire(TweenEvent.STOP);
    }

    togglePause() {
      if (this._playing) this.stop(); else this.play();
    }

    gotoAndPlay(t) {
      this._seek(Math.max(0, Math.min(this._duration, t)));
      this.play();
    }

    gotoAndStop(t) {
      this._seek(Math.max(0, Math.min(this._duration, t)));
      if (this._playing) this.stop();
    }

    __tick(now) {
      if (!this._playing) return;
      const dt = (now - this._lastTick) / 1000;
      this._lastTick = now;
      this._seek(this._pos + dt);
    }

    __onPlayState() { /* subclass hook (PropTween captures start values) */ }

    _seek(t) {
      this._pos = t;
      this.__apply(t);
      if (this._duration > 0 && t >= this._duration && !this._completeFired) {
        // group tweens re-seek passed children to their end; COMPLETE/onComplete
        // must fire only once per play
        this._completeFired = true;
        if (this.stopOnComplete) this.stop();
        this._fire(TweenEvent.COMPLETE);
        // script-side idiom: tween.onComplete = function(){...} (dynamic prop)
        if (typeof this.onComplete === 'function') {
          try { this.onComplete(); } catch (e) { M8.warn('tween onComplete error', e); }
        }
      }
    }

    __apply(t) { /* subclass impl */ }

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
        try { fn(ev); } catch (e) { M8.warn('tween listener error', e); }
      }
    }
  }

  // property tween
  class PropTween extends ITween {
    constructor(target, to, from, duration, easing) {
      super();
      this.target = target;
      this.to = to || {};
      this.from = from || null;
      this._dur = Math.max(0, Number(duration) || 0);
      this.easing = easing || null;
      this._captured = null;
      this._played = false;
    }

    get _duration() { return this._dur; }

    __onPlayState() {
      this._played = true;
      // no from: capture current values as start
      if (this.from == null) {
        this._captured = {};
        for (const k in this.to) this._captured[k] = this.target[k];
      } else {
        this._captured = null;
      }
    }

    __apply(t) {
      const dur = this._dur;
      let p = dur > 0 ? t / dur : 1;
      if (p > 1) p = 1;
      if (p < 0) p = 0;
      const e = this.easing ? this.easing(p) : p;
      const to = this.to;
      if (this.from == null && this._captured == null && !this._played) {
        // children never play()d (driven by serial/parallel parent _seek):
        // capture start values on first apply (BetweenAS3 captures at start)
        this._captured = {};
        for (const k in to) this._captured[k] = this.target[k];
      }
      for (const k in to) {
        let fromVal = this.from ? this.from[k] : (this._captured ? this._captured[k] : this.target[k]);
        if (fromVal === undefined) fromVal = this.target[k];
        try { this.target[k] = fromVal + (to[k] - fromVal) * e; } catch (err) { }
      }
      this._fire(TweenEvent.UPDATE);
    }
  }

  // bezier tween (wiki: Tween.bezier(mc, dest, src, control))
  class BezierTween extends ITween {
    constructor(target, dest, src, control) {
      super();
      this.target = target;
      this.dest = dest || {};
      this.src = src;
      this.control = control || {};
      this._dur = 1;
    }
    get _duration() { return this._dur; }
    __apply(t) {
      let p = this._dur > 0 ? t / this._dur : 1;
      if (p > 1) p = 1;
      const cx = this.control.x || [], cy = this.control.y || [];
      for (const axis of ['x', 'y']) {
        const pts = (axis === 'x' ? cx : cy) || [];
        let start = this.src ? this.src[axis] : undefined;
        const end = this.dest[axis];
        if (end === undefined) continue;
        if (start === undefined) start = this.target[axis];
        if (!pts || pts.length === 0) {
          this.target[axis] = start + (end - start) * p;
        } else {
          // piecewise-linear through control points
          const all = [start].concat(pts).concat([end]);
          const n = all.length - 1;
          const seg = Math.min(n - 1e-9, p * n);
          const i = Math.floor(seg);
          const f = seg - i;
          this.target[axis] = all[i] + (all[i + 1] - all[i]) * f;
        }
      }
    }
  }

  // group tweens: children are driven by parent _seek only (BetweenAS3 semantics).
  // Old impl play()ed all children at once, running serial sequences in
  // parallel (overlapping captions).
  class GroupTween extends ITween {
    constructor(children) {
      super();
      this.children = children || [];
    }
    _resetComplete() {
      this._completeFired = false;
      for (const c of this.children) {
        if (c && typeof c._resetComplete === 'function') c._resetComplete();
      }
    }
  }

  class SerialTween extends GroupTween {
    get _duration() {
      let s = 0;
      for (const c of this.children) s += c._duration;
      return s;
    }
    __apply(t) {
      // BetweenAS3 serial: passed children pin to end state, active one drives,
      // future children are untouched (their from values are not the current
      // state - e.g. caption2 fade-out has from alpha:1; seeking it to 0
      // would keep it visible through the whole serial (overlapping captions)
      let acc = 0;
      for (const c of this.children) {
        const d = c._duration;
        if (t >= acc + d) {
          c._seek(d);
        } else if (t > acc) {
          c._seek(t - acc);
        }
        acc += d;
      }
    }
  }

  class ParallelTween extends GroupTween {
    get _duration() {
      let m = 0;
      for (const c of this.children) if (c._duration > m) m = c._duration;
      return m;
    }
    __apply(t) {
      for (const c of this.children) c._seek(t);
    }
  }

  class DelayTween extends ITween {
    constructor(child, delay) {
      super();
      this.child = child;
      this.delay = Math.max(0, Number(delay) || 0);
    }
    _resetComplete() {
      this._completeFired = false;
      if (this.child && typeof this.child._resetComplete === 'function') this.child._resetComplete();
    }
    get _duration() { return this.delay + this.child._duration; }
    __apply(t) {
      if (t <= this.delay) this.child._seek(0);
      else this.child._seek(t - this.delay);
    }
  }

  class RepeatTween extends ITween {
    constructor(child, times) {
      super();
      this.child = child;
      this.times = Math.max(1, Math.floor(Number(times) || 1));
    }
    _resetComplete() {
      this._completeFired = false;
      if (this.child && typeof this.child._resetComplete === 'function') this.child._resetComplete();
    }
    get _duration() { return this.child._duration * this.times; }
    __apply(t) {
      const d = this.child._duration;
      if (d <= 0) { this.child._seek(0); return; }
      const idx = Math.min(this.times - 1, Math.floor(t / d));
      this.child._seek(t - idx * d);
    }
  }

  class ScaleTween extends ITween {
    constructor(child, scale) {
      super();
      this.child = child;
      this.scale = Number(scale) || 1;
    }
    _resetComplete() {
      this._completeFired = false;
      if (this.child && typeof this.child._resetComplete === 'function') this.child._resetComplete();
    }
    get _duration() { return this.child._duration * this.scale; }
    __apply(t) {
      const s = this.scale !== 0 ? t / this.scale : this.child._duration;
      this.child._seek(Math.max(0, s));
    }
  }

  class ReverseTween extends ITween {
    constructor(child) {
      super();
      this.child = child;
    }
    _resetComplete() {
      this._completeFired = false;
      if (this.child && typeof this.child._resetComplete === 'function') this.child._resetComplete();
    }
    get _duration() { return this.child._duration; }
    __apply(t) {
      this.child._seek(this.child._duration - t);
    }
  }

  class SliceTween extends ITween {
    constructor(child, from, to) {
      super();
      this.child = child;
      this.from = Math.max(0, Number(from) || 0);
      this.to = Math.max(this.from, Number(to) || 0);
    }
    _resetComplete() {
      this._completeFired = false;
      if (this.child && typeof this.child._resetComplete === 'function') this.child._resetComplete();
    }
    get _duration() { return this.to - this.from; }
    __apply(t) {
      this.child._seek(this.from + Math.min(t, this.to - this.from));
    }
  }

  // polyline path tween (mode7 motionPath "Mx,yLx,yL..." linear follow,
  // matches legacy FixedPosComment TweenMax LinePath2D follower)
  class PolylineTween extends ITween {
    constructor(target, points, duration) {
      super();
      this.target = target;
      this.points = points || [];
      this._dur = Math.max(0, Number(duration) || 0);
    }
    get _duration() { return this._dur; }
    __apply(t) {
      const pts = this.points;
      const n = pts.length;
      if (!n) return;
      if (n === 1 || this._dur <= 0) {
        const last = pts[n - 1];
        try { this.target.x = last.x; this.target.y = last.y; } catch (e) { }
        return;
      }
      let p = t / this._dur;
      if (p > 1) p = 1;
      if (p < 0) p = 0;
      const segs = n - 1;
      const seg = Math.min(segs - 1e-9, p * segs);
      const i = Math.floor(seg);
      const f = seg - i;
      try {
        this.target.x = pts[i].x + (pts[i + 1].x - pts[i].x) * f;
        this.target.y = pts[i].y + (pts[i + 1].y - pts[i].y) * f;
      } catch (e) { }
    }
  }

  // ---------------- BetweenAS3 facade ----------------
  const BetweenAS3 = {
    tween(target, to, from, duration, easing) {
      return new PropTween(target, to, from, duration, easing);
    },
    to(target, to, duration, easing) {
      return new PropTween(target, to, null, duration, easing);
    },
    from(target, from, duration, easing) {
      const to = {};
      for (const k in from) to[k] = undefined; // captured at runtime
      return new PropTween(target, to, from, duration, easing);
    },
    bezier(target, dest, src, control) {
      return new BezierTween(target, dest, src, control);
    },
    delay(child, delay) {
      return new DelayTween(child, delay);
    },
    reverse(child) {
      return new ReverseTween(child);
    },
    repeat(child, times) {
      return new RepeatTween(child, times);
    },
    scale(child, s) {
      return new ScaleTween(child, s);
    },
    slice(child, from, to) {
      return new SliceTween(child, from, to);
    },
    serial(...children) {
      return new SerialTween(children);
    },
    parallel(...children) {
      return new ParallelTween(children);
    },
    serialTweens(children) {
      return new SerialTween(children);
    },
    parallelTweens(children) {
      return new ParallelTween(children);
    }
  };

  M8.Easing = Easing;
  M8.TweenEvent = TweenEvent;
  M8.Ticker = Ticker;
  M8.BetweenAS3 = BetweenAS3;
  M8.ITween = ITween;
  M8.PolylineTween = PolylineTween;
  // TweenEasing global (script-side TweenEasing.Sine.easeInOut etc.)
  M8.TweenEasingLib = Easing;
})(typeof window !== 'undefined' ? window : globalThis);
