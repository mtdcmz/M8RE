/* M8 ByteArray + sync zlib inflate (tinf-style)
 * flash.utils.ByteArray equivalent - DanmaGame uses getPixels().clear()/
 * writeByte()/inflate() for embedded zlib bitmaps; must be synchronous.
 */
(function (global) {
  "use strict";
  const M8 = global.M8RE;

  // ---------------- DEFLATE (RFC1951) + zlib wrapper (RFC1950), sync ----------------
  const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  const CLCIDX = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  class Tinf {
    constructor() {
      this.bitbuf = 0;
      this.bitcnt = 0;
    }

    getbit(d) {
      if (this.bitcnt === 0) {
        this.bitbuf = d.data[d.pos++];
        this.bitcnt = 8;
      }
      const b = this.bitbuf & 1;
      this.bitbuf >>>= 1;
      this.bitcnt--;
      return b;
    }

    getbits(d, n) {
      let v = 0;
      for (let i = 0; i < n; i++) v |= this.getbit(d) << i;
      return v;
    }

    buildTree(lengths, num) {
      const counts = new Array(16).fill(0);
      for (let i = 0; i < num; i++) counts[lengths[i]]++;
      counts[0] = 0;
      const offs = new Array(16).fill(0);
      let sum = 0;
      for (let i = 1; i < 16; i++) { offs[i] = sum; sum += counts[i]; }
      const symbols = new Array(sum);
      for (let i = 0; i < num; i++) {
        if (lengths[i] !== 0) symbols[offs[lengths[i]]++] = i;
      }
      return { counts: counts, symbols: symbols };
    }

    decodeSymbol(d, tree) {
      let code = 0, first = 0, index = 0;
      for (let len = 1; len <= 15; len++) {
        code |= this.getbit(d);
        const count = tree.counts[len];
        if (code - first < count) {
          return tree.symbols[index + (code - first)];
        }
        index += count;
        first += count;
        first <<= 1;
        code <<= 1;
      }
      throw new Error("tinf: bad huffman code");
    }

    decodeTrees(d, lt, dt) {
      const lengthTable = new Array(19).fill(0);

      const hlit = this.getbits(d, 5) + 257;
      const hdist = this.getbits(d, 5) + 1;
      const hclen = this.getbits(d, 4) + 4;

      for (let i = 0; i < hclen; i++) {
        lengthTable[CLCIDX[i]] = this.getbits(d, 3);
      }
      const clTree = this.buildTree(lengthTable, 19);

      const lengths = new Array(hlit + hdist).fill(0);
      let i = 0;
      while (i < hlit + hdist) {
        const sym = this.decodeSymbol(d, clTree);
        if (sym < 16) {
          lengths[i++] = sym;
        } else if (sym === 16) {
          if (i === 0) throw new Error("tinf: repeat with no prev");
          const prev = lengths[i - 1];
          let n = 3 + this.getbits(d, 2);
          while (n-- && i < hlit + hdist) lengths[i++] = prev;
        } else if (sym === 17) {
          let n = 3 + this.getbits(d, 3);
          while (n-- && i < hlit + hdist) lengths[i++] = 0;
        } else {
          let n = 11 + this.getbits(d, 7);
          while (n-- && i < hlit + hdist) lengths[i++] = 0;
        }
      }
      // check EOB present
      if (lengths[256] === 0) throw new Error("tinf: no end-of-block code");

      lt.tree = this.buildTree(lengths, hlit);

      // dist tree: all-zero code lengths (single dist code) is legal
      let nonZero = 0;
      for (let j = hlit; j < hlit + hdist; j++) if (lengths[j] !== 0) nonZero++;
      if (nonZero === 0) {
        dt.tree = this.buildTree([1], 1);
      } else {
        dt.tree = this.buildTree(lengths.slice(hlit), hdist);
      }
    }

    inflateBlock(d, out) {
      const lt = { tree: null }, dt = { tree: null };
      this.decodeTrees(d, lt, dt);
      for (;;) {
        let sym = this.decodeSymbol(d, lt.tree);
        if (sym === 256) break;
        if (sym < 256) {
          out.push(sym);
        } else {
          sym -= 257;
          const length = LBASE[sym] + this.getbits(d, LEXT[sym]);
          const dsym = this.decodeSymbol(d, dt.tree);
          const dist = DBASE[dsym] + this.getbits(d, DEXT[dsym]);
          const from = out.length - dist;
          if (from < 0) throw new Error("tinf: distance too far back");
          for (let i = 0; i < length; i++) {
            out.push(out[from + i]);
          }
        }
      }
    }

    inflate(data) {
      // zlib header check
      if (data.length < 2) throw new Error("tinf: too short");
      const cmf = data[0], flg = data[1];
      if ((cmf & 0x0f) !== 8) throw new Error("tinf: not deflate");
      if (((cmf << 8) | flg) % 31 !== 0) throw new Error("tinf: bad zlib header");
      if (flg & 0x20) throw new Error("tinf: preset dictionary unsupported");
      return this._inflateBody(data, 2);
    }

    // raw deflate (no zlib header) - format used by legacy embedded bitmaps
    inflateRaw(data) {
      return this._inflateBody(data, 0);
    }

    _inflateBody(data, start) {
      const d = { data: data, pos: start };
      const out = [];
      for (;;) {
        const bfinal = this.getbit(d);
        const btype = this.getbits(d, 2);
        if (btype === 0) {
          // stored
          this.bitcnt = 0;
          if (d.pos + 4 > data.length) throw new Error("tinf: stored block overrun");
          const len = data[d.pos] | (data[d.pos + 1] << 8);
          const nlen = data[d.pos + 2] | (data[d.pos + 3] << 8);
          if ((len ^ 0xffff) !== nlen) throw new Error("tinf: stored block length mismatch");
          d.pos += 4;
          if (d.pos + len > data.length) throw new Error("tinf: stored block data overrun");
          for (let i = 0; i < len; i++) out.push(data[d.pos + i]);
          d.pos += len;
        } else if (btype === 3) {
          throw new Error("tinf: invalid block type");
        } else if (btype === 1) {
          // fixed huffman
          this._inflateFixed(d, out);
        } else {
          this.inflateBlock(d, out);
        }
        if (bfinal) break;
        if (d.pos > data.length) throw new Error("tinf: data overrun");
      }
      return new Uint8Array(out);
    }

    _inflateFixed(d, out) {
      const litLen = new Array(288);
      for (let i = 0; i < 144; i++) litLen[i] = 8;
      for (let i = 144; i < 256; i++) litLen[i] = 9;
      for (let i = 256; i < 280; i++) litLen[i] = 7;
      for (let i = 280; i < 288; i++) litLen[i] = 8;
      const distLen = new Array(30).fill(5);
      const lt = this.buildTree(litLen, 288);
      const dt = this.buildTree(distLen, 30);
      for (;;) {
        let sym = this.decodeSymbol(d, lt);
        if (sym === 256) break;
        if (sym < 256) {
          out.push(sym);
        } else {
          sym -= 257;
          const length = LBASE[sym] + this.getbits(d, LEXT[sym]);
          const dsym = this.decodeSymbol(d, dt);
          const dist = DBASE[dsym] + this.getbits(d, DEXT[dsym]);
          const from = out.length - dist;
          if (from < 0) throw new Error("tinf: distance too far back");
          for (let i = 0; i < length; i++) {
            out.push(out[from + i]);
          }
        }
      }
    }
  }

  // ---------------- ByteArray (flash.utils.ByteArray subset) ----------------
  class ByteArray {
    constructor() {
      this._data = new Uint8Array(64);
      this.length = 0;
      this.position = 0;
    }

    static _inflate(input) {
      const t = new Tinf();
      // try zlib first; on bad header fall back to raw deflate
      if (input.length >= 2 && (input[0] & 0x0f) === 8 &&
        (((input[0] << 8) | input[1]) % 31) === 0 && !(input[1] & 0x20)) {
        return t.inflate(input);
      }
      return t.inflateRaw(input);
    }

    _ensure(capacity) {
      if (capacity > this._data.length) {
        let newSize = this._data.length;
        while (newSize < capacity) newSize *= 2;
        const nd = new Uint8Array(newSize);
        nd.set(this._data.subarray(0, this.length));
        this._data = nd;
      }
    }

    get bytesAvailable() {
      return Math.max(0, this.length - this.position);
    }

    clear() {
      this.length = 0;
      this.position = 0;
    }

    writeByte(b) {
      this._ensure(this.position + 1);
      this._data[this.position++] = b & 0xff;
      if (this.position > this.length) this.length = this.position;
    }

    writeBytes(src, start, len) {
      start = start || 0;
      len = (len === undefined || len === 0) ? src.length - start : len;
      this._ensure(this.position + len);
      for (let i = 0; i < len; i++) {
        this._data[this.position++] = src[start + i];
      }
      if (this.position > this.length) this.length = this.position;
    }

    readByte() {
      return this._readSigned();
    }

    readUnsignedByte() {
      if (this.position >= this.length) throw new Error("ByteArray: read past end");
      return this._data[this.position++];
    }

    _readSigned() {
      const v = this.readUnsignedByte();
      return v < 128 ? v : v - 256;
    }

    readUnsignedInt() {
      let v = 0;
      for (let i = 0; i < 4; i++) v = (v * 256) + this.readUnsignedByte();
      return v >>> 0;
    }

    writeUTF(s) {
      // simplified: no length prefix (rarely used by scripts)
      for (let i = 0; i < s.length; i++) this.writeByte(s.charCodeAt(i) & 0xff);
    }

    readUTFBytes(len) {
      let s = "";
      for (let i = 0; i < len; i++) s += String.fromCharCode(this.readUnsignedByte());
      return decodeURIComponent(escape(s));
    }

    inflate() {
      const input = this._data.subarray(0, this.length);
      const out = ByteArray._inflate(input);
      this._data = out;
      this.length = out.length;
      this.position = 0;
    }

    toUint8Array() {
      return this._data.subarray(0, this.length);
    }

    get bytes() { return this.toUint8Array(); }

    toString() {
      let s = "";
      const d = this._data;
      for (let i = 0; i < this.length; i++) s += String.fromCharCode(d[i]);
      try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
    }
  }

  M8.ByteArray = ByteArray;
  M8.Tinf = Tinf;
})(typeof window !== 'undefined' ? window : globalThis);
