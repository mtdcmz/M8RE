/* M8 main entry - video page bootstrap: overlay mount, player adapter, mode8 scheduling, SPA watch */
(function (global) {
  "use strict";
  const M8 = global.M8RE;

  const VIDEO_AREA_MIN = 50;      // min video area px
  const POLL_MS = 500;

  // Engine lifecycle info: gated behind m8re_debug to keep the console clean.
  function log() {
    if (!M8.isDebug()) return;
    try { console.log('%c[M8RE]', 'color:#fff;background:#e11;padding:0 4px', ...arguments); } catch (e) { }
  }

  // Optional overlay status badge. Disabled by default; enable via
  // localStorage.setItem('m8re_badge', '1') for debugging.
  function setBadge(text, isError) {
    try {
      if (global.localStorage && global.localStorage.getItem('m8re_badge') !== '1') return;
    } catch (e) { return; }
    let badge = document.getElementById('m8re-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'm8re-badge';
      badge.style.cssText =
        'position:fixed;right:12px;top:56px;z-index:2147483647;pointer-events:none;' +
        'font:11px/1.6 Consolas,monospace;color:#fff;background:rgba(0,0,0,0.65);' +
        'padding:2px 8px;border-radius:3px;border:1px solid #2a2;max-width:420px;';
      document.documentElement.appendChild(badge);
    }
    badge.style.borderColor = isError ? '#e11' : '#2a2';
    badge.textContent = text;
  }
  M8.setBadge = setBadge;


  class M8App {
    constructor() {
      this.video = null;
      this.container = null;
      this.overlay = null;
      this.root = null;
      this.factory = null;
      this.fetcher = null;
      this.mode8 = [];
      this._m8Ptr = 0;        // mode8 timeline pointer (CommentManager.time semantics)
      this._lastPos = 0;      // last scheduled pos (s); |jump|>=2 -> bsearch (legacy oldPosition)
      this._firstSchedule = true;  // first schedule: replay missed entries on late data
      this.comments = [];
      this._nativeLayer = null;  // native danmaku layer (Event.ADDED compat)
      this.videoInfo = null;
      this._frameCb = null;
      this._layoutTimer = null;
      this._destroyed = false;   // aborts pending start() awaits after teardown
      this._dmTakeover = false;  // script took over the stage (hide native layers)
      this._dmLayerSaved = undefined;
      this._dmLayerEls = null;
      this._advSaved = undefined;  // saved adv-layer visibility (mode7 double-render guard)
      this._dmObserver = null;
      this._bridgeDmOpen = null;   // bridged danmaku switch state (null = unknown)
      this._onBridgeMsg = null;
      this._userSwitchOff = false;
      this._dmOpacity = 1;
      this._rectCache = null;      // per-frame display rect cache
      this._rectFrame = -1;
      this._lastCt = -1;          // last currentTime (stall detection)
      this._stallCount = 0;
      this._rebindTries = 0;
      this._schedTimer = null;    // timeupdate / 250ms fallback scheduling
    }

    // ---------- startup ----------
    async start() {
      setBadge('M8RE initializing...');
      if (!(await this.waitForPlayer())) {
        if (!this._destroyed) setBadge('M8RE: player not found', true);
        return;
      }
      if (this._destroyed) return;
      this.mountOverlay();
      this.wirePlayer();
      this.injectPageBridge();
      this.factory = new M8.CommentScriptFactory();
      const adapter = this.makeAdapter();
      this.factory.initial(adapter, this.root);
      this.startFrameLoop();
      this.setupStageTakeover();
      this.setupDmSwitchSync();

      // fetch danmaku
      this.fetcher = new M8.DanmakuFetcher();
      this.videoInfo = await this.fetcher.resolveVideo();
      if (this._destroyed) return;
      if (!this.videoInfo) {
        setBadge('M8RE: cannot resolve video info (aid/cid)', true);
        log('cannot resolve video info (aid/cid)');
        return;
      }
      this.factory.cid = String(this.videoInfo.cid);
      log('video info: aid', this.videoInfo.aid, 'cid', this.videoInfo.cid, 'duration', this.videoInfo.duration);

      // wait for videoWidth (determines picture area)
      await this.waitForMetadata();
      if (this._destroyed) return;
      this.layoutOverlay();

      const data = await this.fetcher.loadAll(this.videoInfo.aid, this.videoInfo.cid, this.videoInfo.duration || (this.video.duration || 360));
      if (this._destroyed) return;
      this.mode8 = data.mode8;
      this.comments = data.comments;
      // native danmaku layer (scripts hook $.root "added"; idle otherwise)
      const app = this;
      this._nativeLayer = new M8.NativeCommentLayer(this.root, this.factory.scriptManager, this.makeAdapter(), function () {
        // A script hooks added and takes over danmaku (clone/removeChild
        // pattern). The player's own scroll layer must hide or danmaku
        // renders twice (game clone + native row) at double density.
        // _applyDmLayer uses visibility and keeps cmd-dm buttons clickable.
        app._onStageManage();
      });
      this._nativeLayer.setComments(this.comments);
      if (this.mode8.length === 0) {
        setBadge('M8RE ready (no code danmaku, ' + this.comments.length + ' native)');
      } else {
        setBadge('M8RE ready, ' + this.mode8.length + ' code danmaku');
      }
      log('engine ready: ' + this.mode8.length + ' scripts, ' + this.comments.length + ' native danmaku');

      // schedule once immediately (t=0 scripts)
      this.schedule();
    }

    waitForPlayer() {
      const self = this;
      return new Promise(function (resolve) {
        let tries = 0;
        const timer = setInterval(function () {
          if (self._destroyed) {
            clearInterval(timer);
            resolve(false);
            return;
          }
          const found = M8App.findVideo();
          const video = found && found.video;
          const container = found && found.container;
          if (video && container && video.clientWidth > VIDEO_AREA_MIN) {
            clearInterval(timer);
            self.video = video;
            self.container = container;
            resolve(true);
            return;
          }
          if (++tries > 120) { // give up after 60s
            clearInterval(timer);
            log('player not found, giving up');
            resolve(false);
          }
        }, POLL_MS);
      });
    }

    waitForMetadata() {
      const self = this;
      return new Promise(function (resolve) {
        if (self.video.videoWidth) { resolve(); return; }
        const t = setTimeout(resolve, 3000);
        self.video.addEventListener('loadedmetadata', function () {
          clearTimeout(t);
          resolve();
        }, { once: true });
      });
    }

    // ---------- overlay ----------
    mountOverlay() {
      const self = this;
      const overlay = document.createElement('div');
      overlay.id = 'm8re-overlay';
      // Deliberately no transform-style:preserve-3d / perspective / will-change here:
            // composited layer (major lag source); preserve-3d+perspective would force
      // every 2D child onto a 3D path. _enableStage3D turns it on only when
      // real 3D elements appear (matrix3D/rotateX/rotateY detected).
      overlay.style.cssText =
        'position:absolute;left:0;top:0;width:100%;height:100%;' +
        'overflow:hidden;pointer-events:none;z-index:30;';
      // overlay is pointer-events:none; interactive children opt into auto
      // (CSS lets children override a parent none).
      this.container.appendChild(overlay);
      this.overlay = overlay;

      const root = new M8.M8Element('div');
      root.el.remove();
      root.el = overlay;
      root.el.style.transform = 'none';
      root.el.style.opacity = '';
      root.el.style.visibility = '';
      this.root = root;
      // 3D compositing enabled only when real 3D elements appear
      M8._enableStage3D = function () {
        if (self._stage3dOn || !self.overlay) return;
        self._stage3dOn = true;
        M8._stage3dOn = true;
        // Projection is fully composed inside Mode7Comment matrices in the
        // semantic space (see 09_elements.js); the overlay must never add CSS
        // perspective on top (double projection). preserve-3d chain only keeps
        // 3D elements from being flattened by intermediate containers.
        const flatten = function (el) {
          el.style.transformStyle = 'preserve-3d';
          for (const c of el.children) flatten(c);
        };
        flatten(self.overlay);
        self._stage3dFlatten = flatten;
        log('stage 3D compositing enabled (mode7 matrix pipeline)');
      };

      // Stage-level mouse tracking: the overlay itself is pointer-events:none,
      // but Flash mouseX/mouseY are stage-level: readable regardless of
      // interactivity. Danmaku games (maze, shooters) rely on this to track
      // the player mouse. Coords are relative to the overlay rect (= video picture),
      // with no secondary container/letterbox conversion.
      this._stageMouseX = 0;
      this._stageMouseY = 0;
      this._onStageMouseMove = function (ev) {
        const r = (self.overlay || self.container).getBoundingClientRect();
        self._stageMouseX = ev.clientX - r.left;
        self._stageMouseY = ev.clientY - r.top;
      };
      this.container.addEventListener('mousemove', this._onStageMouseMove);
      // exposed for element mouseX/mouseY
      M8._stageMouse = { x: 0, y: 0, container: null };
      M8._stageMouse.container = this.container;

      // Layout polling (ResizeObserver is primary; this is the fallback).
      // Danmaku switch detection is event-driven (bridge + MutationObserver);
      // localStorage polled only when the bridge is unavailable
      this._layoutTimer = setInterval(function () {
        self.layoutOverlay();
        if (self._dmTakeover) self._applyDmLayer(); // layers may appear after takeover
        if (self._bridgeDmOpen === null) self._syncDmSwitch();
      }, 2000);
      try {
        this._ro = new ResizeObserver(function () { self.layoutOverlay(); });
        this._ro.observe(this.container);
        this._ro.observe(this.video);
      } catch (e) { }
      document.addEventListener('fullscreenchange', function () {
        setTimeout(function () { self.layoutOverlay(); }, 200);
      });
      this.layoutOverlay();
    }

    // Video picture rect (letterbox-aware for 4:3 in a 16:9 container).
    // zero rect when video is null (teardown/replaced)
    videoDisplayRect() {
      const v = this.video;
      if (!v) return { left: 0, top: 0, width: 0, height: 0 };
      const vr = v.getBoundingClientRect();
      const vw = v.videoWidth, vh = v.videoHeight;
      if (!vw || !vh) return { left: vr.left, top: vr.top, width: vr.width, height: vr.height };
      const containerAR = vr.width / vr.height;
      const videoAR = vw / vh;
      let w = vr.width, h = vr.height;
      if (containerAR > videoAR) {
        w = vr.height * videoAR;
      } else if (containerAR < videoAR) {
        h = vr.width / videoAR;
      }
      return {
        left: vr.left + (vr.width - w) / 2,
        top: vr.top + (vr.height - h) / 2,
        width: w,
        height: h
      };
    }

    // display rect cached per frame (Player.width is read every frame)
    _cachedRect() {
      const frame = M8.Ticker._lastFrame || 0;
      if (this._rectFrame === frame && this._rectCache) return this._rectCache;
      this._rectCache = this.videoDisplayRect();
      this._rectFrame = frame;
      return this._rectCache;
    }

    layoutOverlay() {
      if (this._destroyed || !this.overlay || !this.video || !this.container) return;
      try {
        const vr = this.videoDisplayRect();
        const cr = this.container.getBoundingClientRect();
        const o = this.overlay.style;
        o.left = (vr.left - cr.left) + 'px';
        o.top = (vr.top - cr.top) + 'px';
        o.width = vr.width + 'px';
        o.height = vr.height + 'px';
        // cache stage size on root (stageWidth/height read it, zero reflow)
        if (this.root) {
          this.root._stageW = Math.round(vr.width);
          this.root._stageH = Math.round(vr.height);
          this.root._customWidth = Math.round(vr.width);
          this.root._customHeight = Math.round(vr.height);
        }
      } catch (e) { }
    }

    // ---------- stage takeover (legacy removeScrollComment semantics) ----------
    // Legacy: regular danmaku share the stage with scripts; DanmaGame
    // removes native scroll danmaku via setChildIndex/removeChildAt and
    // redraws obstacles. Such calls here = stage takeover -> hide native layers.
    setupStageTakeover() {
      const self = this;
      const root = this.root;
      const origSetChildIndex = root.setChildIndex.bind(root);
      root.setChildIndex = function (child, index) {
        self._onStageManage();
        return origSetChildIndex(child, index);
      };
      const origRemoveChildAt = root.removeChildAt.bind(root);
      root.removeChildAt = function (i) {
        self._onStageManage();
        return origRemoveChildAt(i);
      };
      // takeover via $.root.removeChild(...) (added handlers removing native danmaku)
      const origRemoveChild = root.removeChild.bind(root);
      root.removeChild = function (child) {
        self._onStageManage();
        return origRemoveChild(child);
      };
      // ScriptManager.clearEl (called by every mode8 script on entry) must NOT
      // release stage takeover - releasing re-shows the native scroll layer
      // between danmaku, rendering danmaku twice. Takeover lives until teardown.
      const sm = this.factory.scriptManager;
      const origClearEl = sm.clearEl.bind(sm);
      sm.clearEl = function () {
        origClearEl();
      };
    }

    _onStageManage() {
      if (this._destroyed || this._dmTakeover) return;
      this.setTakeover(true);
      log('script stage takeover: hiding native danmaku layers');
    }

    // mode7 double-render guard: hide the player adv layer while our
    // Mode7Comment renders; regular danmaku stay player-rendered.
    _hidePlayerAdvLayer() {
      if (this._destroyed) return;
      const adv = document.querySelector('.bpx-player-adv-dm-wrap');
      if (!adv) return;
      if (this._advSaved === undefined) this._advSaved = adv.style.visibility;
      adv.style.setProperty('visibility', 'hidden', 'important');
    }

    _restorePlayerAdvLayer() {
      if (this._advSaved === undefined) return;
      const adv = document.querySelector('.bpx-player-adv-dm-wrap');
      if (adv) adv.style.visibility = this._advSaved;
      this._advSaved = undefined;
    }

    setTakeover(on) {
      if (on === this._dmTakeover) return;
      this._dmTakeover = on;
      this._applyDmLayer();
      this._syncDmSwitch();
    }

    _applyDmLayer() {
      // visibility over display: children can override a hidden parent,
      // so the cmd-dm layer (interactive buttons) can stay visible;
      // display:none cannot do that.
      // fallback: hide scroll/adv layers individually if the parent is missing.
      const wrap = document.querySelector('.bpx-player-render-dm-wrap');
      const cmd = document.querySelector('.bpx-player-cmd-dm-wrap');
      const layers = this._findDmLayers();
      if (this._dmTakeover) {
        if (this._dmLayerSaved === undefined) {
          const saved = { wrap: wrap ? wrap.style.visibility : null, layers: layers.map(function (l) { return l.style.visibility; }) };
          this._dmLayerSaved = saved;
        }
        if (wrap) wrap.style.setProperty('visibility', 'hidden', 'important');
        for (const l of layers) {
          l.style.setProperty('visibility', 'hidden', 'important');
        }
        if (cmd) cmd.style.setProperty('visibility', 'visible', 'important');
      } else if (this._dmLayerSaved !== undefined) {
        const saved = this._dmLayerSaved;
        if (wrap && saved.wrap !== null) wrap.style.visibility = saved.wrap;
        layers.forEach(function (l, i) { l.style.visibility = saved.layers[i] || ''; });
        if (cmd) cmd.style.removeProperty('visibility');
        this._dmLayerSaved = undefined;
      }
    }

    // bpx scroll danmaku layers (.bpx-player-dm-mask-wrap children: adv+row).
    // Full hierarchy (core.js template): render-dm-wrap > [dm-svg-mask-wrap,
    // dm-mask-wrap > (adv-dm-wrap, row-dm-wrap), bas-dm-wrap, cmd-dm-wrap].
    // On takeover _applyDmLayer hides render-dm-wrap via visibility and
    // re-shows cmd-dm-wrap; this list backs switch detection and fallbacks.
    _findDmLayers() {
      if (this._dmLayerEls && this._dmLayerEls.length && this._dmLayerEls[0].isConnected) {
        return this._dmLayerEls;
      }
      const sels = ['.bpx-player-dm-mask-wrap', '.bpx-player-row-dm-wrap', '.bpx-player-adv-dm-wrap'];
      const found = [];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && found.indexOf(el) === -1) found.push(el);
      }
      this._dmLayerEls = found;
      return found;
    }

    _findDmLayer() {
      const layers = this._findDmLayers();
      return layers[0] || null;
    }

    // ---------- danmaku switch sync ----------
    // Injects the page-world bridge: reads window.player.danmaku.isOpen()
    // and profile writes. Isolated world cannot reach page JS without this bridge.
    injectPageBridge() {
      try {
        if (document.getElementById('m8re-inject-script')) return;
        if (!(global.chrome && chrome.runtime && chrome.runtime.getURL)) {
          log('non-extension env: bridge skipped, switch sync falls back to polling');
          return;
        }
        const s = document.createElement('script');
        s.id = 'm8re-inject-script';
        s.src = chrome.runtime.getURL('content/inject.js');
        s.async = false;
        (document.head || document.documentElement).appendChild(s);
        log('page-world bridge injected');
      } catch (e) {
        log('bridge injection failed: ' + e.message);
      }
    }

    setupDmSwitchSync() {
      const self = this;
      try {
        this._dmObserver = new MutationObserver(function () {
          if (!self._destroyed) self._syncDmSwitch();
        });
        for (const layer of this._findDmLayers()) {
          this._dmObserver.observe(layer, { attributes: true, attributeFilter: ['style', 'class'] });
        }
      } catch (e) { }
      // bridge messages (page world -> content script)
      this._onBridgeMsg = function (ev) {
        if (ev.source !== window) return;
        const d = ev.data;
        if (!d || d.source !== 'm8re-inject') return;
        if (self._destroyed) return;
        if (d.type === 'dm-state') {
          if (self._bridgeDmOpen !== d.open) {
            self._bridgeDmOpen = d.open;
            log('bridge: danmaku switch = ' + (d.open ? 'on' : 'off'));
            self._applyDmVisibility();
          }
        } else if (d.type === 'profile-write') {
          self._syncDmSwitch(); // profile written; sync now (incl. opacity)
        }
      };
      window.addEventListener('message', this._onBridgeMsg);
    }

    // read bpx danmaku settings (localStorage['bpx_player_profile'] -> dmSetting)
    _readProfileDmSetting() {
      try {
        const raw = localStorage.getItem('bpx_player_profile') ||
          localStorage.getItem('bilibili_player_settings');
        if (!raw) return null;
        const obj = JSON.parse(raw);
        const find = function (o, depth) {
          if (!o || typeof o !== 'object' || depth > 4) return null;
          if ('dmSwitch' in o || 'dmSwitchState' in o) return o;
          for (const k in o) {
            const r = find(o[k], depth + 1);
            if (r) return r;
          }
          return null;
        };
        return find(obj, 0);
      } catch (e) {
        return null;
      }
    }

    // player-side switch detection (bpx tri-state: 1 on / 2 smart / 3 off)
    _detectPlayerDmOff() {
      const st = this._readProfileDmSetting();
      if (st) {
        if (typeof st.dmSwitchState === 'number' && st.dmSwitchState > 0) {
          return st.dmSwitchState === 3;
        }
        if (st.dmSwitch !== undefined && st.dmSwitch !== null) {
          return st.dmSwitch === false || st.dmSwitch === 0 || st.dmSwitch === '0';
        }
      }
      const layer = this._findDmLayer();
      if (layer) {
        const cs = getComputedStyle(layer);
        if (cs.display === 'none' || cs.visibility === 'hidden') return true;
      }
      return false;
    }

    // apply danmaku visibility (bridge state first, localStorage fallback)
    _applyDmVisibility() {
      if (this._destroyed || !this.overlay) return;
      if (this._dmTakeover) return; // layers controlled by us during takeover
      let off;
      if (this._bridgeDmOpen === true) {
        off = false;
      } else if (this._bridgeDmOpen === false) {
        off = true;
      } else {
        off = this._detectPlayerDmOff();
      }
      if (off !== this._userSwitchOff) {
        this._userSwitchOff = off;
        this.overlay.style.visibility = off ? 'hidden' : 'visible';
        log('danmaku switch: ' + (off ? 'hide code layer' : 'restore code layer'));
      }
    }

    _syncDmSwitch() {
      if (this._destroyed || !this.overlay) return;
      this._applyDmVisibility();
      // opacity sync (bpx settings panel)
      if (!this._userSwitchOff) {
        const st = this._readProfileDmSetting();
        const op = st ? Number(st.opacity) : NaN;
        if (isFinite(op) && op > 0 && op <= 1 && Math.abs(op - this._dmOpacity) > 0.01) {
          this._dmOpacity = op;
          this.overlay.style.opacity = String(op);
        }
      }
    }

    // ---------- player linkage ----------
    wirePlayer() {
      const v = this.video;
      const self = this;
      this._onPlay = function () {
        if (self.factory) self.factory.scriptManager.onPlay();
      };
      this._onPause = function () {
        if (self.factory) self.factory.scriptManager.onPause();
      };
      this._onEnded = function () {
        if (self.factory) self.factory.scriptManager.onComplete();
      };
      this._onSeeked = function () {
        if (self.factory && self.video) self.factory.scriptManager.onSeek(self.video.currentTime * 1000);
      };
      v.addEventListener('play', this._onPlay);
      v.addEventListener('pause', this._onPause);
      v.addEventListener('ended', this._onEnded);
      v.addEventListener('seeked', this._onSeeked);
    }

    makeAdapter() {
      const self = this;
      return {
        play: function () {
          if (!self.video) return;
          const p = self.video.play();
          if (p && p.catch) p.catch(function () { });
        },
        pause: function () { if (self.video) self.video.pause(); },
        seek: function (sec) {
          try {
            if (self.video) self.video.currentTime = sec;
          } catch (e) { }
        },
        jump: function (av, page, newWindow) {
          let s = String(av).replace(/^av/i, '');
          const url = 'https://www.bilibili.com/video/av' + s + '/?p=' + (page || 1);
          if (newWindow) window.open(url);
          else location.assign(url);
        },
        get state() {
          if (!self.video) return 'pause';
          if (self.video.ended) return 'stop';
          return self.video.paused ? 'pause' : 'playing';
        },
        get time() { return self.video ? self.video.currentTime * 1000 : 0; },
        // Player.width/height must be stable: scaleGameCanvas treats changes as
        // resize and pauses immediately; per-frame getBoundingClientRect drifts
        // 1px between frames -> game pauses every frame. Use cached _stageW/_stageH.
        
        get width() {
          if (self.root && self.root._stageW != null) return self.root._stageW;
          return Math.round(self._cachedRect().width);
        },
        get height() {
          if (self.root && self.root._stageH != null) return self.root._stageH;
          return Math.round(self._cachedRect().height);
        },
        get videoWidth() { return self.video ? self.video.videoWidth : 0; },
        get videoHeight() { return self.video ? self.video.videoHeight : 0; },
        get commentList() { return self.comments; }
      };
    }

    // ---------- frame loop (enterFrame + mode8 scheduling + video rebinding) ----------
    startFrameLoop() {
      const self = this;
      this._frameCb = function () {
        if (self._destroyed) return;
        // Video element invalidation: the player swaps <video> on quality/episode
        // changes; stale refs get re-selected and rebound.
        if (!self.video || !self.video.isConnected) {
          self._tryRebindVideo();
          return;
        }
        const ct = self.video.currentTime;
        if (!self.video.paused && ct === self._lastCt) {
          if (++self._stallCount > 30) { self._tryRebindVideo(); return; }  // ~1.25s stalled
        } else { self._stallCount = 0; }
        self._lastCt = ct;
        // refresh stage mouse coords (for mouseX/mouseY)
        if (M8._stageMouse) {
          M8._stageMouse.x = self._stageMouseX;
          M8._stageMouse.y = self._stageMouseY;
        }
        // enterFrame events (root + all registered targets)
        // iterate cached snapshot (_efSync rebuilds on change only)
        self.root.dispatchEvent('enterFrame', { type: 'enterFrame', target: self.root });
        const efArr = M8._efSync();
        for (let i = 0; i < efArr.length; i++) {
          efArr[i].dispatchEvent('enterFrame', { type: 'enterFrame', target: efArr[i] });
        }
        self.schedule();
      };
      M8.Ticker.addFrame(this._frameCb);
      // timeupdate fallback (scheduling continues when rAF is throttled)
      if (this.video) this.video.addEventListener('timeupdate', this._onTimeUpdate = function () {
        if (!self._destroyed) self.schedule();
      });
      // 250ms fallback scheduling (rAF fully unavailable)
      this._schedTimer = setInterval(function () {
        if (self._destroyed) return;
        if (!self.video || !self.video.isConnected) { self._tryRebindVideo(); return; }
        self.schedule();
      }, 250);
    }

    // re-select the video element and rebind listeners
    _tryRebindVideo() {
      if (this._destroyed) return;
      if (this._rebindTries++ > 8) return; // give up; layout poll retries later
      log('video element stale, rebinding...');
      const found = M8App.findVideo();
      if (!found || !found.video || !found.container) return;
      if (found.video === this.video) return;
      // unbind old listeners
      if (this.video) {
        try { this.video.removeEventListener('play', this._onPlay); } catch (e) { }
        try { this.video.removeEventListener('pause', this._onPause); } catch (e) { }
        try { this.video.removeEventListener('ended', this._onEnded); } catch (e) { }
        try { this.video.removeEventListener('seeked', this._onSeeked); } catch (e) { }
        try { this.video.removeEventListener('timeupdate', this._onTimeUpdate); } catch (e) { }
      }
      this.video = found.video;
      this.container = found.container;
      this._stallCount = 0;
      this._lastCt = -1;
      this._rectCache = null;
      this.wirePlayer();
      try { this.video.addEventListener('timeupdate', this._onTimeUpdate); } catch (e) { }
      // container may have changed; move the overlay across
      if (this.overlay && this.overlay.parentElement !== this.container) {
        this.container.appendChild(this.overlay);
      }
      this.layoutOverlay();
      this._rebindTries = 0;
      log('video element rebound');
    }

    static findVideo() {
      // container candidates: bpx > legacy > fallback (multiple DOM variants)
      const containerSels = [
        '.bpx-player-container', '#bilibili-player',
        '.bpx-player-video-wrap', '.player-box', '.video-box'
      ];
      let container = null;
      for (const s of containerSels) {
        const el = document.querySelector(s);
        if (el) { container = el; break; }
      }
      // video inside the candidate container, else the largest visible one
      let video = container ? container.querySelector('video') : null;
      if (!video) {
        const all = Array.from(document.querySelectorAll('video'));
        let best = null, bestArea = 0;
        for (const v of all) {
          const r = v.getBoundingClientRect();
          const area = r.width * r.height;
          if (area > bestArea && area > 2500 && v.readyState !== 0) { best = v; bestArea = area; }
        }
        video = best;
        if (video && !container) {
          container = video.closest('.bpx-player-container') || video.closest('#bilibili-player') ||
            video.parentElement;
        }
      }
      return { video: video, container: container };
    }

    // ---------- mode8 scheduling (CommentManager.time port) ----------
    // Legacy semantics (CommentManager.as L347-367):
    //   t = currentTime - 0.001 (may be negative)
    //   if (pointer done || |oldPosition - t| >= 2) -> bsearch reset
    //   while (pointer valid && timeLine[ptr].stime <= t) -> fire, ++ptr
    // mode8 has no "on" lifecycle flag; replay is purely pointer-driven:
    // after a seek-back, scripts re-fire as playback advances (legacy replay).
    _bsearchMode8(tSec) {
      // legacy bsearch: first index with stime > tSec; length if past the end
      const arr = this.mode8;
      if (arr.length === 0) return 0;
      if (tSec < arr[0].progress / 1000) return 0;
      if (tSec >= arr[arr.length - 1].progress / 1000) return arr.length;
      let lo = 0, hi = arr.length - 1;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi + 1) / 2);
        if (mid > 0 && mid < arr.length &&
          arr[mid - 1].progress / 1000 <= tSec && arr[mid].progress / 1000 > tSec) {
          return mid;
        }
        if (mid === 0) { lo = 1; continue; }
        if (arr[mid - 1].progress / 1000 > tSec) {
          hi = mid - 1;
        } else {
          lo = mid;
        }
      }
      return arr.length;
    }

    schedule() {
      if (!this.factory || !this.video || this._destroyed) return;
      if (this.mode8.length === 0 && !this._nativeLayer) return;
      const t = this.video.currentTime - 0.001;
      if (this.mode8.length) {
        const arr = this.mode8;
        if (this._firstSchedule) {
          // First schedule after data ready: fire all missed scripts in order.
          // Legacy data was ready before playback; async fetch here can lag autoplay,
          // and bsearch would skip stime=0 game scripts forever.
          // In-order execution preserves ordering; legacy pointer semantics resume after.
          this._firstSchedule = false;
          this._lastPos = t;
          while (this._m8Ptr < arr.length && arr[this._m8Ptr].progress / 1000 <= t) {
            this.fireScript(arr[this._m8Ptr]);
            this._m8Ptr++;
          }
        } else if (this._m8Ptr >= arr.length || Math.abs(this._lastPos - t) >= 2) {
          // legacy time(): exhausted pointer or jump >= 2s -> bsearch reset
          this._m8Ptr = this._bsearchMode8(t);
          this._lastPos = t;
          while (this._m8Ptr < arr.length && arr[this._m8Ptr].progress / 1000 <= t) {
            this.fireScript(arr[this._m8Ptr]);
            this._m8Ptr++;
          }
        } else {
          this._lastPos = t;
          while (this._m8Ptr < arr.length && arr[this._m8Ptr].progress / 1000 <= t) {
            this.fireScript(arr[this._m8Ptr]);
            this._m8Ptr++;
          }
        }
      }
      // native danmaku (Event.ADDED layer) - always advanced to playback time
      if (this._nativeLayer) {
        try { this._nativeLayer.tick(t); } catch (e) { }
      }
    }

    fireScript(item) {
      log('fire M8 script id=' + item.id + ' @' + (item.progress / 1000).toFixed(1) + 's (' + item.content.length + ' chars)');
      setBadge('M8RE running code danmaku #' + item.id);
      try {
        this.factory.exec(item.content, true);
      } catch (e) {
        setBadge('M8RE: script error #' + item.id, true);
        log('script error id=' + item.id + ':', e && e.stack || e);
      }
    }

    // ---------- teardown ----------
    teardown() {
      this._destroyed = true;
      try {
        if (this.factory) {
          this.factory.scriptManager.clearTimer();
          this.factory.scriptManager.clearTrigger();
          this.factory.scriptManager.clearEl();
          const em = this.factory.player && this.factory.player.scriptEventManager;
          if (em) em.detach();
        }
        if (this._nativeLayer) { try { this._nativeLayer.clear(); } catch (e) { } }
        // release stage takeover (restore native layers)
        this._dmTakeover = false;
        this._applyDmLayer();
        this._restorePlayerAdvLayer();
        M8._stage3dOn = false;
        if (this._dmObserver) { try { this._dmObserver.disconnect(); } catch (e) { } }
        if (this._onBridgeMsg) window.removeEventListener('message', this._onBridgeMsg);
        if (this._frameCb) M8.Ticker.removeFrame(this._frameCb);
        if (this._schedTimer) clearInterval(this._schedTimer);
        if (this._layoutTimer) clearInterval(this._layoutTimer);
        if (this._ro) { try { this._ro.disconnect(); } catch (e) { } }
        if (this._onStageMouseMove && this.container) {
          this.container.removeEventListener('mousemove', this._onStageMouseMove);
        }
        if (this.video) {
          this.video.removeEventListener('play', this._onPlay);
          this.video.removeEventListener('pause', this._onPause);
          this.video.removeEventListener('ended', this._onEnded);
          this.video.removeEventListener('seeked', this._onSeeked);
          if (this._onTimeUpdate) this.video.removeEventListener('timeupdate', this._onTimeUpdate);
        }
        if (this.overlay) this.overlay.remove();
        // clear enterFrame targets
        M8._efTargets.clear();
        M8._efTargetsArr = [];
        M8._efDirty = false;
      } catch (e) {
        log('teardown error', e);
      }
      this.video = null;
      this.container = null;
      this.overlay = null;
      this.root = null;
      this.factory = null;
      this.mode8 = [];
      this.comments = [];
      this._nativeLayer = null;
      this._m8Ptr = 0;
      this._lastPos = 0;
      this._firstSchedule = true;
      this._frameCb = null;
      this._layoutTimer = null;
      this._schedTimer = null;
    }
  }

  // ---------------- bootstrap + SPA watch ----------------
  // Rebuild only when the video identity (BV/av + page) changes;
  // spm_id_from/vd_source params must not trigger a rebuild
  function videoIdentity() {
    const m = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+|av\d+)/);
    if (!m) return null;
    const p = (location.search.match(/[?&]p=(\d+)/) || [])[1] || '1';
    return m[1] + '?p=' + p;
  }

  let currentApp = null;
  let lastIdentity = undefined;

  async function boot() {
    const id = videoIdentity();
    if (!id) {
      if (currentApp) {
        currentApp.teardown();
        currentApp = null;
        lastIdentity = undefined;
        const badge = document.getElementById('m8re-badge');
        if (badge) badge.remove();
      }
      return;
    }
    if (id === lastIdentity && currentApp) return;   // ignore query-only changes
    lastIdentity = id;
    if (currentApp) {
      currentApp.teardown();
      currentApp = null;
    }
    currentApp = new M8App();
    await currentApp.start();
  }

  setInterval(function () {
    boot().catch(function (e) { log('boot error', e); });
  }, 800);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { boot().catch(function () { }); });
  } else {
    boot().catch(function (e) { log('boot error', e); });
  }

  M8.App = M8App;
})(typeof window !== 'undefined' ? window : globalThis);
