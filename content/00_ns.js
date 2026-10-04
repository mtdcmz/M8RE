/* M8RE namespace & shared utils (no build step; content scripts load in order) */
(function (global) {
  "use strict";
  const M8 = global.M8RE = global.M8RE || {};

  // AS3 int()/uint() semantics
  M8.int = function (v) { return Math.trunc(Number(v)) || 0; };
  M8.uint = function (v) { return Number(v) >>> 0; };

  // Safe hasOwnProperty (AS3 dynamic-object semantics)
  M8.hasOwn = function (obj, name) {
    return obj != null && Object.prototype.hasOwnProperty.call(obj, name);
  };

  // getTimer: Flash ms timer
  M8.getTimer = function () {
    return Math.floor((global.performance && performance.now) ? performance.now() : Date.now());
  };

  // uint RGB -> css hex
  M8.colorToCss = function (c) {
    c = Number(c) >>> 0;
    if (c > 0xFFFFFF) c = 0xFFFFFF;
    return '#' + c.toString(16).padStart(6, '0');
  };

  // Logging (EventBus equivalent). Verbose lines print by default;
  // set localStorage['m8re_debug'] = '0' to silence. Errors always go through.
  const logBuf = [];
  let debugOn = null;
  M8.isDebug = function () {
    if (debugOn === null) {
      try { debugOn = !(global.localStorage && global.localStorage.getItem('m8re_debug') === '0'); }
      catch (e) { debugOn = false; }
    }
    return debugOn;
  };
  M8.log = function () {
    if (!M8.isDebug()) return;
    const line = formatLogLine(arguments);
    logBuf.push(line);
    if (logBuf.length > 300) logBuf.shift();
    try { console.log('%c[M8]', 'color:#0f0;background:#111;padding:0 4px', line); } catch (e) { }
  };
  // Always-print log channel for engine errors and lifecycle milestones.
  M8.warn = function () {
    const line = formatLogLine(arguments);
    logBuf.push(line);
    if (logBuf.length > 300) logBuf.shift();
    try { console.warn('%c[M8]', 'color:#fe0;background:#111;padding:0 4px', line); } catch (e) { }
  };
  function formatLogLine(args) {
    return Array.prototype.map.call(args, function (a) {
      if (a === undefined) return '';
      if (a === null) return 'null';
      // JSON.stringify(new Error("x")) is "{}" (message/stack non-enumerable) -
      // print Error.message/stack so listener failures stay diagnosable
      if (a instanceof Error) return a.message;
      try { return (typeof a === 'object') ? JSON.stringify(a) : String(a); }
      catch (e) { return String(a); }
    }).join(' ');
  }
    M8.clearLog = function () { logBuf.length = 0; };
  M8.getLog = function () { return logBuf.slice(); };

  // AS3 Array.sortOn (biliscript array methods reach here via CALLM)
  // flags: CASEINSENSITIVE=1 DESCENDING=2 UNIQUESORT=4 RETURNINDEXEDARRAY=8 NUMERIC=16
  if (!Array.prototype.sortOn) {
    Object.defineProperty(Array.prototype, 'sortOn', {
      value: function (fields, flags) {
        flags = flags || 0;
        const desc = (flags & 2) !== 0;
        const numeric = (flags & 16) !== 0;
        const ci = (flags & 1) !== 0;
        const fa = Array.isArray(fields) ? fields : [fields];
        this.sort(function (a, b) {
          for (let i = 0; i < fa.length; i++) {
            let f = fa[i];
            let va, vb;
            if (typeof f === 'string') { va = a[f]; vb = b[f]; }
            else { va = a[f.name]; vb = b[f.name]; } // {name, options}
            if (numeric) { va = Number(va); vb = Number(vb); }
            else if (ci && typeof va === 'string' && typeof vb === 'string') {
              va = va.toLowerCase(); vb = vb.toLowerCase();
            }
            let r = 0;
            if (va < vb) r = -1; else if (va > vb) r = 1;
            if (r !== 0) return (f.options !== undefined ? (f.options & 2) : desc) ? -r : r;
          }
          return 0;
        });
        return this;
      },
      writable: true, configurable: true, enumerable: false
    });
  }

  // Deep clone (AS3 Utils.clone / AMF equivalent)
  // Follows ruffle avm2/amf.rs semantics:
  //   - cycles preserved via identity map
  //   - display elements use __clone (rebuilt element, visual state copied);
  //     legacy AMF dropped them to undefined, breaking games that rely on clone;
  //     keeping them playable is a deliberate compat enhancement
  //   - function values kept by reference
  //   - Array/Date/Map/Set/TypedArray/plain objects copied recursively
  M8.clone = function (obj) {
    if (obj === null || obj === undefined) return obj;
    const t = typeof obj;
    if (t !== 'object') {
      // functions kept by reference
      if (t === 'function') return obj;
      return obj; // primitive
    }
    // display elements go through __clone first
    if (typeof obj.__clone === 'function') return obj.__clone();
    const seen = new Map(); // source -> clone (cycle detection)
    const root = obj;
    function walk(src) {
      if (src === null || src === undefined) return src;
      if (typeof src !== 'object') return src;
      if (typeof src.__clone === 'function') return src.__clone();
      if (seen.has(src)) return seen.get(src);
      // Array
      if (Array.isArray(src)) {
        const arr = new Array(src.length);
        seen.set(src, arr);
        for (let i = 0; i < src.length; i++) arr[i] = walk(src[i]);
        return arr;
      }
      // Date
      if (src instanceof Date) return new Date(src.getTime());
      // Map / Set
      if (typeof Map !== 'undefined' && src instanceof Map) {
        const m = new Map();
        seen.set(src, m);
        for (const [k, v] of src) m.set(walk(k), walk(v));
        return m;
      }
      if (typeof Set !== 'undefined' && src instanceof Set) {
        const s = new Set();
        seen.set(src, s);
        for (const v of src) s.add(walk(v));
        return s;
      }
      // TypedArray
      if (ArrayBuffer.isView(src)) {
        const Ctor = src.constructor;
        try { return new Ctor(src); } catch (e) { return src; }
      }
      // plain objects / class instances: same prototype, own props copied
      let proto = null;
      try { proto = Object.getPrototypeOf(src); } catch (e) { }
      const dst = (proto && proto !== Object.prototype) ? Object.create(proto) : {};
      seen.set(src, dst);
      for (const k in src) {
        if (Object.prototype.hasOwnProperty.call(src, k)) {
          const v = src[k];
          // function props kept by reference for game compat
          dst[k] = (typeof v === 'function') ? v : walk(v);
        }
      }
      return dst;
    }
    return walk(root);
  };
})(typeof window !== 'undefined' ? window : globalThis);
