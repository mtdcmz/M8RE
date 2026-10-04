/* M8 protobuf decoder - hand-written varint/length-delim + bilibili danmaku schema
 * schemas: DmSegMobileReply / DanmakuElem / DmWebViewReply (bilibili-API-collect)
 */
(function (global) {
  "use strict";
  const M8 = global.M8RE;

  // generic wire decode: returns [{fieldNo, wt, val}]
  function decode(buf) {
    const out = [];
    let i = 0;
    const n = buf.length;
    while (i < n) {
      let key = 0, shift = 0;
      let ok = false;
      while (i < n) {
        const b = buf[i++];
        key |= (b & 0x7f) << shift;
        if (!(b & 0x80)) { ok = true; break; }
        shift += 7;
        if (shift > 35) return out;
      }
      if (!ok) break;
      const fieldNo = key >>> 3, wt = key & 7;
      if (fieldNo === 0) break;
      let val;
      if (wt === 0) { // varint
        let v = 0n, s = 0n;
        while (i < n) {
          const b = buf[i++];
          v |= BigInt(b & 0x7f) << s;
          if (!(b & 0x80)) break;
          s += 7n;
        }
        val = v;
      } else if (wt === 1) { val = buf.slice(i, i + 8); i += 8; }
      else if (wt === 2) {
        let len = 0, s = 0;
        while (i < n) {
          const b = buf[i++];
          len |= (b & 0x7f) << s;
          if (!(b & 0x80)) break;
          s += 7;
        }
        val = buf.slice(i, i + len);
        i += len;
      } else if (wt === 5) { val = buf.slice(i, i + 4); i += 4; }
      else break;
      out.push({ fieldNo: fieldNo, wt: wt, val: val });
    }
    return out;
  }

  const textDec = (typeof TextDecoder !== 'undefined') ? new TextDecoder('utf-8') : null;
  function toStr(bytes) {
    if (textDec) return textDec.decode(bytes);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
  }

  // DanmakuElem -> flat object
  function parseElem(raw) {
    const fields = decode(raw);
    const e = {
      id: 0, idStr: '', progress: 0, mode: 1, fontsize: 25, color: 0xFFFFFF,
      midHash: '', content: '', ctime: 0, weight: 0, action: '', pool: 0, attr: 0
    };
    for (const f of fields) {
      switch (f.fieldNo) {
        case 1: e.id = Number(f.val); break;
        case 2: e.progress = Number(f.val); break;
        case 3: e.mode = Number(f.val); break;
        case 4: e.fontsize = Number(f.val); break;
        case 5: e.color = Number(f.val); break;
        case 6: e.midHash = toStr(f.val); break;
        case 7: e.content = toStr(f.val); break;
        case 8: e.ctime = Number(f.val); break;
        case 9: e.weight = Number(f.val); break;
        case 10: e.action = toStr(f.val); break;
        case 11: e.pool = Number(f.val); break;
        case 12: e.idStr = toStr(f.val); break;
        case 13: e.attr = Number(f.val); break;
      }
    }
    if (!e.idStr) e.idStr = String(e.id);
    return e;
  }

  // DmSegMobileReply -> elems array
  function parseSeg(buf) {
    const elems = [];
    for (const f of decode(buf)) {
      if (f.fieldNo === 1 && f.wt === 2) {
        elems.push(parseElem(f.val));
      }
    }
    return elems;
  }

  // DmWebViewReply -> { state, specialDms, count, commandDms }
  function parseView(buf) {
    const view = { state: 0, specialDms: [], count: 0, commandDms: [], text: '' };
    for (const f of decode(buf)) {
      switch (f.fieldNo) {
        case 1: view.state = Number(f.val); break;
        case 2: view.text = toStr(f.val); break;
        case 6: view.specialDms.push(toStr(f.val)); break;
        case 8: view.count = Number(f.val); break;
        case 9: {
          const cd = { id: 0, command: '', content: '', progress: 0 };
          for (const n of decode(f.val)) {
            if (n.fieldNo === 1) cd.id = Number(n.val);
            if (n.fieldNo === 4) cd.command = toStr(n.val);
            if (n.fieldNo === 5) cd.content = toStr(n.val);
            if (n.fieldNo === 6) cd.progress = Number(n.val);
          }
          view.commandDms.push(cd);
          break;
        }
      }
    }
    return view;
  }

  M8.PB = {
    decode: decode,
    toStr: toStr,
    parseElem: parseElem,
    parseSeg: parseSeg,
    parseView: parseView
  };
})(typeof window !== 'undefined' ? window : globalThis);
