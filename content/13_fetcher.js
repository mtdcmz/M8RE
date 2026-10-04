/* M8 danmaku fetcher - pulls view / seg.so / specialDms packs independently
 * Fetch path: background proxy in extension env (CORS), direct fetch otherwise
 */
(function (global) {
  "use strict";
  const M8 = global.M8RE;

  const isExt = !!(global.chrome && chrome.runtime && chrome.runtime.id);

  function bgFetch(url) {
    return new Promise(function (resolve, reject) {
      chrome.runtime.sendMessage({ type: 'm8re-fetch', url: url }, function (resp) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!resp || !resp.ok) {
          reject(new Error('fetch failed: ' + url + ' ' + (resp && resp.status)));
          return;
        }
        if (!resp.b64) {
          reject(new Error('empty pack: ' + url));
          return;
        }
        const bin = atob(resp.b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        resolve(bytes.buffer);
      });
    });
  }

  // Fallbacks: credentialed direct -> no-credential direct -> background proxy
  // specialDm URLs come as http://; upgrade to https (mixed-content block)
  async function fetchBuf(url) {
    url = String(url).replace(/^http:\/\//i, 'https://');
    // hdslb CDN answers ACAO:* which forbids credentialed reads - those page
    // fetches ALWAYS fail. In extension env go to the bg proxy first.
    const isCdn = /hdslb[.]com[//]/.test(url);
    if (isExt && isCdn) {
      try { return await bgFetch(url); } catch (e0) { /* fall through */ }
    }
    try {
      const resp = await fetch(url, { credentials: 'include' });
      if (resp.ok) return await resp.arrayBuffer();
      throw new Error('HTTP ' + resp.status);
    } catch (e1) {
      try {
        const resp = await fetch(url);
        if (resp.ok) return await resp.arrayBuffer();
        throw new Error('HTTP ' + resp.status);
      } catch (e2) {
        if (isExt) return await bgFetch(url);
        throw e2;
      }
    }
  }

  // ---------------- BAS-carrier M8 extraction ----------------
  // M8 scripts ride the modern BAS channel (mode 9, pool 2): the server
  // accepts large multi-line payloads there (verified live: a 20KB raw M8
  // script round-tripped byte-identical; observed entries up to 514KB).
  // Carrier convention: content starts with "//M8v1" -> the whole content
  // is M8 source and fires at the danmaku's own progress. "//" is a comment
  // in biliscript (harmless to the VM) and a lexer error in the official BAS
  // renderer, so plain viewers see nothing.
  M8.BasCarrier = (function () {
    const RAW_RE = /^\s*\/\/M8v1/;

    function extract(entries) {
      const out = [];
      for (const e of entries) {
        const c = String(e.content || '');
        // raw carrier: M8 source verbatim
        if (RAW_RE.test(c)) {
          out.push({ id: 'bas-' + (e.idStr || e.id), progress: e.progress, content: c, mode: 8 });
        }
      }
      return out;
    }
    return { extract: extract };
  })();

  async function fetchJson(url) {
    const buf = await fetchBuf(url);
    return JSON.parse(M8.PB.toStr(new Uint8Array(buf)));
  }

  class DanmakuFetcher {
    constructor() {
    }

    // Parse BV/av id + page from URL (legacy videos often shared as av links)
    static parsePageInfo() {
      const m = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+|av\d+)/i);
      if (!m) return null;
      const id = m[1];
      const p = parseInt((location.search.match(/[?&]p=(\d+)/) || [])[1] || '1', 10);
      if (/^av\d+$/i.test(id)) return { aid: parseInt(id.slice(2), 10), page: p };
      return { bvid: id, page: p };
    }

    // bvid/av -> aid/cid (x/web-interface/view needs no wbi)
    async resolveVideo() {
      const info = DanmakuFetcher.parsePageInfo();
      if (!info) return null;
      try {
        const q = info.bvid ? ('bvid=' + info.bvid) : ('aid=' + info.aid);
        const json = await fetchJson('https://api.bilibili.com/x/web-interface/view?' + q);
        if (json.code !== 0 || !json.data) throw new Error('view api code ' + json.code);
        const d = json.data;
        const pages = d.pages || [{ cid: d.cid, page: 1 }];
        const pg = pages[Math.min(Math.max(1, info.page), pages.length) - 1];
        return {
          aid: d.aid, bvid: d.bvid, cid: pg.cid,
          title: d.title, duration: d.duration, page: info.page
        };
      } catch (e) {
        // fallback: scrape page __INITIAL_STATE__
        M8.log('view api failed, trying __INITIAL_STATE__: ' + e.message);
        return await DanmakuFetcher.fromInitialState();
      }
    }

    static async fromInitialState() {
      // HTML fallback: extract aid/cid from __INITIAL_STATE__ / meta
      try {
        const html = await (await fetch(location.href, { credentials: 'include' })).text();
        const bvid = (location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/) || [])[1];
        const aidM = html.match(/"aid"\s*:\s*(\d+)/);
        const cidM = html.match(/"cid"\s*:\s*(\d+)/);
        const durM = html.match(/"duration"\s*:\s*(\d+)/);
        if (!aidM || !cidM) return null;
        return {
          aid: parseInt(aidM[1], 10),
          bvid: bvid,
          cid: parseInt(cidM[1], 10),
          duration: durM ? parseInt(durM[1], 10) : 0,
          page: 1
        };
      } catch (e) {
        return null;
      }
    }

    // dm/web/view -> specialDms
    async fetchView(aid, cid) {
      const url = 'https://api.bilibili.com/x/v2/dm/web/view?type=1&oid=' + cid + '&pid=' + aid;
      const buf = new Uint8Array(await fetchBuf(url));
      return M8.PB.parseView(buf);
    }

    async fetchSeg(aid, cid, index) {
      const url = 'https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid=' + cid + '&pid=' + aid +
        '&segment_index=' + index + '&fontsize=0&screen_state=1';
      const buf = new Uint8Array(await fetchBuf(url));
      return M8.PB.parseSeg(buf);
    }

    async fetchSpecialDm(url) {
      const buf = new Uint8Array(await fetchBuf(url));
      return M8.PB.parseSeg(buf);
    }

    // Load all: view -> special packs -> segments
    // Returns { mode8: [...], comments: [...] } (deduped by id)
    async loadAll(aid, cid, durationSec) {
      const mode8 = [];
      const basEntries = [];   // mode 9 BAS carriers (M8 springboard)
      const comments = [];
      const seen = new Set();
      let truncatedSkipped = 0;
      const self = this;

      // source: 'special' (full) | 'seg' (mode8 server-truncated to ~300 chars)
      const pushElem = (e, source) => {
        const key = e.id || (e.idStr + '|' + e.progress + '|' + e.content.length);
        if (seen.has(key)) return;
        seen.add(key);
        if (e.mode === 8 && e.content) {
          if (source === 'seg' && e.content.length >= 300) {
            // seg mode8 is always a truncated fragment; full text lives in specialDms
            truncatedSkipped++;
            return;
          }
          mode8.push(e);
          // Legacy CommentDataParser: mode8 entries also join commentList
          // (text kept verbatim; scripts filter by length/mode themselves)
          comments.push(self.toCommentData(e, e.content));
        } else if (e.mode === 9) {
          // mode 9 BAS: potential M8 springboard carrier (raw //M8v1 or
          // [M8v1|...] chunk markers); legit BAS DSL is filtered in extract()
          basEntries.push(e);
        } else if (e.content && e.content.replace(/\r/g, '')) {
          let text = e.content;
          const cd = self.toCommentData(e, text);
          if (e.mode === 7) {
            // mode7: JSON array; field semantics per legacy CommentDataParser
            // L193-257 + CommentDataMode7 defaults (parse failure drops the entry)
            try {
              const j = JSON.parse(e.content);
              if (!Array.isArray(j) || j.length <= 4) return;
              const num = function (v) { const n = Number(v); return isFinite(n) ? n : 0; };
              // mode7 display text: legacy ran text_string on json[4] (L201/L408);
              // literal "/n" is the legacy stored newline - restore before display
              text = String(j[4]).replace(/\/n/g, '\n');
              cd.text = text; cd.txt = text;
              cd.x = num(j[0]);
              cd.y = num(j[1]);
              cd.rZ = 0; cd.rY = 0;
              if (j.length >= 7) { cd.rZ = num(j[5]); cd.rY = num(j[6]); }
              cd.adv = false; cd.toX = 0; cd.toY = 0; cd.mDuration = 0; cd.delay = 0;
              if (j.length >= 11) {
                cd.adv = true;
                cd.toX = num(j[7]);
                cd.toY = num(j[8]);
                cd.mDuration = 0.5; cd.delay = 0;
                if (j[9] !== '' && j[9] !== undefined) cd.mDuration = num(j[9]) / 1000;
                if (j[10] !== '' && j[10] !== undefined) cd.delay = num(j[10]) / 1000;
              }
              cd.borderStyle = (j.length >= 12) ? (String(j[11]) === 'true') : true;
              cd.fontFamily = (j.length >= 13 && j[12]) ? String(j[12]) : 'SimHei';
              cd.isAccelerated = (j.length >= 14) ? (String(j[13]) === '0') : false;
              cd.motionPath = (j.length >= 15 && j[14]) ? String(j[14]) : null;
              cd.duration = 2.5;
              if (j.length > 3 && isFinite(Number(j[3])) && num(j[3]) < 12 && num(j[3]) !== 1) {
                cd.duration = num(j[3]);
              }
              cd.inAlpha = 1; cd.outAlpha = 1;
              const aa = String(j[2] === undefined ? '' : j[2]).split('-');
              if (aa.length >= 2) {
                cd.inAlpha = num(aa[0]);
                cd.outAlpha = num(aa[1]);
              }
            } catch (err) { return; }
          }
          comments.push(cd);
        }
      };

      // 1. view metadata + specialDms packs (only full-text source for mode8)
      try {
        const view = await this.fetchView(aid, cid);
        M8.log('dm view: count=' + view.count + ' specialDms=' + view.specialDms.length);
        for (const u of view.specialDms) {
          try {
            const elems = await this.fetchSpecialDm(u);
            let m8 = 0, maxLen = 0;
            for (const e of elems) {
              if (e.mode === 8) { m8++; if (e.content.length > maxLen) maxLen = e.content.length; }
              pushElem(e, 'special');
            }
            M8.log('specialDm pack: ' + elems.length + ' entries (mode8=' + m8 + ', longest ' + maxLen + ' chars)');
          } catch (e) {
            M8.warn('specialDm fetch failed: ' + u + ' - ' + e.message);
          }
        }
      } catch (e) {
        M8.warn('dm view fetch failed: ' + e.message);
      }

      // 2. regular segments (comment text; mode8 only truncated fragments)
      const dur = durationSec || 360;
      const segCount = Math.max(1, Math.ceil(dur / 360));
      for (let i = 1; i <= segCount; i++) {
        try {
          const elems = await this.fetchSeg(aid, cid, i);
          for (const e of elems) pushElem(e, 'seg');
        } catch (e) {
          M8.warn('seg ' + i + ' fetch failed: ' + e.message);
        }
      }

      // 3. BAS-carrier M8 scripts -> same timeline as native mode 8
      if (basEntries.length) {
        const basScripts = M8.BasCarrier.extract(basEntries);
        M8.log('BAS carriers: ' + basEntries.length + ' mode9 entries -> ' + basScripts.length + ' M8 scripts');
        for (const s of basScripts) {
          mode8.push(s);
          M8.log('BAS M8 script id=' + s.id + ' @' + (s.progress / 1000).toFixed(2) + 's (' + s.content.length + ' chars)');
        }
      }

      mode8.sort(function (a, b) { return a.progress - b.progress; });
      comments.sort(function (a, b) { return a.stime - b.stime; });
      M8.log('danmaku loaded: mode8=' + mode8.length + ' comments=' + comments.length +
        (truncatedSkipped ? ' (skipped ' + truncatedSkipped + ' truncated fragments)' : ''));
      return { mode8: mode8, comments: comments };
    }

    // DanmakuElem -> legacy CommentData shape (stime sec / text / color ...)
    toCommentData(e, text) {
      return {
        id: e.id,
        idStr: e.idStr,
        mode: e.mode,
        text: text,
        txt: text,
        stime: e.progress / 1000,
        time: e.progress / 1000,
        size: e.fontsize,
        fontsize: e.fontsize,
        color: e.color,
        pool: e.pool,
        midHash: e.midHash,
        ctime: e.ctime,
        weight: e.weight,
        blocked: false
      };
    }
  }

  M8.DanmakuFetcher = DanmakuFetcher;
  M8.fetchBuf = fetchBuf;
  M8.fetchJson = fetchJson;
})(typeof window !== 'undefined' ? window : globalThis);
