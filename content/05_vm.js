/* M8 VM - port of scripting/VirtualMachine.as (61 ops)
 * Dispatch: this[code[pc]](code, pc) -> next pc or null (SPD halts)
 * Safety: execution time budget throws; caught by exec try/catch
 */
(function (global) {
  "use strict";
  const M8 = global.M8RE;
  const hasOwn = M8.hasOwn;

  // Time budget mirrors Flash AVM2 ScriptTimeout semantics
  // Legacy games iterate Player.commentList during exec (long valid loops),
  // so an instruction cap would false-kill them. Wall-clock budget instead:
  // checked every 65536 ops, aborts past EXEC_TIME_BUDGET_MS.
  // Real infinite loops still abort within ~10s.
  const EXEC_TIME_BUDGET_MS = 10 * 1000;
  const BUDGET_CHECK_INTERVAL = 0x10000;

  // All op names - 1:1 with scripting/VirtualMachine.as public methods
  const OP_NAMES = [
    "NOP", "SPD", "LIT", "CALL", "CALLL", "CALLM", "CALLF", "RET", "CRET",
    "FUNC", "COR", "ARG", "JMP", "IF", "NIF",
    "ADD", "SUB", "MUL", "DIV", "MOD", "AND", "OR", "XOR", "NOT", "LNOT",
    "LSH", "RSH", "URSH", "INC", "DEC",
    "CEQ", "CSEQ", "CNE", "CSNE", "CLT", "CGT", "CLE", "CGE",
    "DUP", "THIS", "ARRAY", "OBJ",
    "SETL", "GETL", "SET", "GET", "SETM", "GETM", "GETMV", "NEW",
    "DEL", "DELL", "DELM", "TYPEOF", "INSOF", "NUM", "STR", "WITH", "EWITH",
    "PUSH", "POP"
  ];

  class VirtualMachine {
    constructor() {
      this.initialize();
      this.optimized = false;
      // Op dispatch table: avoids this[op] lookup in hot loops
      this._ops = Object.create(null);
      for (const name of OP_NAMES) {
        this._ops[name] = this[name].bind(this);
      }
    }

    initialize() {
      this.programCounter = 1;
      this.byteCode = [];
      this.stack = [];
      this.global = {};
      this.global.__scope = null;
      this.localObject = this.global;
      this.thisObject = this.global;
      this.returnValue = undefined;
      // Re-entrancy depth map: original VM keeps operand slots in the shared
      // bytecode array, so recursion overwrites outer operands (real legacy bug).
      // We snapshot/restore bytecode on re-entry; non-reentrant path is free.
      this._fnDepth = new Map();
    }

    rewind() {
      this.programCounter = 1;
    }

    setProgramCounter(pc) {
      this.programCounter = pc;
    }

    runCoroutine(name, args) {
      const a = args == null ? [] : args;
      return this.executeFunction(new Object(), a, this.global[name].__entryPoint, this.global[name].__scope);
    }

    getGlobalObject() {
      return this.global;
    }

    getLocalObject() {
      return this.localObject;
    }

    setByteCode(code) {
      this.byteCode = code;
      this.byteCodeLength = code.length;
    }

    getByteCode() {
      return this.byteCode;
    }

    getByteCodeLength() {
      return this.byteCodeLength;
    }

    execute() {
      const code = this.byteCode;
      const ops = this._ops;
      let pc = this.programCounter;
      const len = this.byteCodeLength;
      const startT = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      let sinceCheck = 0;
      while (pc < len) {
        if (sinceCheck === 0) {
          // time budget check (every 65536 ops)
          const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
          if (now - startT > EXEC_TIME_BUDGET_MS) {
            this.programCounter = pc;
            throw new Error("VirtualMachine [OutOfTime] : exceeded " + EXEC_TIME_BUDGET_MS +
              "ms, suspected infinite loop at pc" + pc);
          }
        }
        if (++sinceCheck >= BUDGET_CHECK_INTERVAL) sinceCheck = 0;
        const fn = ops[code[pc]];
        if (fn === undefined) {
          this.programCounter = pc;
          throw new Error("VirtualMachine [UnknownOperation] : " + code[pc] + " at pc" + pc);
        }
        const next = fn(code, pc);
        if (next == null) {
          this.programCounter = pc + 1;
          delete code[0];
          return true;
        }
        pc = next;
      }
      this.programCounter = pc;
      delete code[0];
      return false;
    }

    executeFunction(thisObj, args, entryPoint, scope) {
      const savedThis = this.thisObject;
      const savedLocal = this.localObject;
      const savedPc = this.programCounter;
      const depth = this._fnDepth.get(entryPoint) || 0;
      this._fnDepth.set(entryPoint, depth + 1);
      const reentrant = depth > 0;
      let savedCode = null;
      if (reentrant) {
        savedCode = this.byteCode.slice();
      }
      try {
        this.thisObject = thisObj;
        this.localObject = { arguments: args, __scope: scope };
        this.programCounter = entryPoint;
        while (this.execute()) { }
      } finally {
        if (reentrant) {
          // restore outer operands (inner writes to slots are temporary)
          const code = this.byteCode;
          for (let i = 0; i < savedCode.length; i++) code[i] = savedCode[i];
        }
        this._fnDepth.set(entryPoint, depth);
        this.programCounter = savedPc;
        this.localObject = savedLocal;
        this.thisObject = savedThis;
      }
      return this.returnValue;
    }

    // ---- instruction set ----

    NOP(code, pc) {
      return pc + 1;
    }

    SPD(code, pc) {
      return null;
    }

    LIT(code, pc) {
      code[code[pc + 2]] = code[pc + 1];
      return pc + 3;
    }

    CALL(code, pc) {
      const name = code[pc + 1];
      let fn = null;
      let scope = this.localObject;
      while (scope != null) {
        if (hasOwn(scope, name)) {
          fn = scope[name];
          break;
        }
        scope = scope.__scope;
      }
      if (fn == null) {
        throw new Error("1006: " + name + " is not a function (undefined)");
      }
      let n = code[pc + 2] + 1;
      const stack = this.stack;
      const args = [];
      while (--n) {
        args.push(stack.pop());
      }
      args.reverse();
      if (hasOwn(fn, "__entryPoint")) {
        stack.push(pc + 4);
        stack.push(this.thisObject);
        stack.push(this.localObject);
        stack.push(code[pc + 3]);
        this.thisObject = this.global;
        this.localObject = { arguments: args, __scope: fn.__scope };
        return fn.__entryPoint;
      }
      if (typeof fn !== "function") {
        throw new Error("1006: " + name + " is not a function");
      }
      code[code[pc + 3]] = fn.apply(this.global, args);
      return pc + 4;
    }

    CALLL(code, pc) {
      const fn = this.localObject[code[pc + 1]];
      let n = code[pc + 2] + 1;
      const stack = this.stack;
      const args = [];
      while (--n) {
        args.push(stack.pop());
      }
      args.reverse();
      if (fn == null) {
        throw new Error("1006: " + code[pc + 1] + " is not a function (undefined local)");
      }
      if (hasOwn(fn, "__entryPoint")) {
        stack.push(pc + 4);
        stack.push(this.thisObject);
        stack.push(this.localObject);
        stack.push(code[pc + 3]);
        this.thisObject = this.global;
        this.localObject = { arguments: args, __scope: fn.__scope };
        return fn.__entryPoint;
      }
      if (typeof fn !== "function") {
        throw new Error("1006: " + code[pc + 1] + " is not a function");
      }
      code[code[pc + 3]] = fn.apply(this.global, args);
      return pc + 4;
    }

    CALLM(code, pc) {
      const obj = code[pc + 1];
      const method = obj[code[pc + 2]];
      if (method == null) {
        throw new Error("1009: method " + code[pc + 2] + " does not exist");
      }
      let n = code[pc + 3] + 1;
      const stack = this.stack;
      const args = [];
      while (--n) {
        args.push(stack.pop());
      }
      args.reverse();
      if (hasOwn(method, "__entryPoint")) {
        stack.push(pc + 5);
        stack.push(this.thisObject);
        stack.push(this.localObject);
        stack.push(code[pc + 4]);
        this.thisObject = obj;
        this.localObject = { arguments: args, __scope: method.__scope };
        return method.__entryPoint;
      }
      if (typeof method !== "function") {
        throw new Error("1009: property " + code[pc + 2] + " is not a function");
      }
      code[code[pc + 4]] = method.apply(obj, args);
      return pc + 5;
    }

    CALLF(code, pc) {
      const fn = code[pc + 1];
      if (fn == null || typeof fn !== "function") {
        throw new Error("1006: expression is not a function");
      }
      let n = code[pc + 2] + 1;
      const stack = this.stack;
      const args = [];
      while (--n) {
        args.push(stack.pop());
      }
      args.reverse();
      if (hasOwn(fn, "__entryPoint")) {
        stack.push(pc + 4);
        stack.push(this.thisObject);
        stack.push(this.localObject);
        stack.push(code[pc + 3]);
        this.thisObject = this.global;
        this.localObject = { arguments: args, __scope: fn.__scope };
        return fn.__entryPoint;
      }
      code[code[pc + 3]] = fn.apply(this.global, args);
      return pc + 4;
    }

    RET(code, pc) {
      this.returnValue = code[pc + 1];
      return this.byteCodeLength;
    }

    CRET(code, pc) {
      const stack = this.stack;
      code[stack.pop()] = code[pc + 1];
      this.localObject = stack.pop();
      this.thisObject = stack.pop();
      return Number(stack.pop());
    }

    FUNC(code, pc) {
      const vm = this;
      const entryPoint = pc + 3;
      const scope = this.localObject;
      code[code[pc + 2]] = function () {
        return vm.executeFunction(this, Array.prototype.slice.call(arguments), entryPoint, scope);
      };
      return code[pc + 1];
    }

    COR(code, pc) {
      code[code[pc + 2]] = {
        __entryPoint: pc + 3,
        __scope: this.localObject
      };
      return code[pc + 1];
    }

    ARG(code, pc) {
      this.localObject[code[pc + 2]] = this.localObject.arguments[code[pc + 1]];
      if (this.localObject.parameters === undefined) {
        this.localObject.parameters = [];
      }
      this.localObject.parameters.push(code[pc + 2]);
      return pc + 3;
    }

    JMP(code, pc) {
      return code[pc + 1];
    }

    IF(code, pc) {
      if (code[pc + 1]) {
        return pc + 3;
      }
      return code[pc + 2];
    }

    NIF(code, pc) {
      if (code[pc + 1]) {
        return code[pc + 2];
      }
      return pc + 3;
    }

    ADD(code, pc) {
      code[code[pc + 3]] = code[pc + 1] + code[pc + 2];
      return pc + 4;
    }

    SUB(code, pc) {
      code[code[pc + 3]] = code[pc + 1] - code[pc + 2];
      return pc + 4;
    }

    MUL(code, pc) {
      code[code[pc + 3]] = code[pc + 1] * code[pc + 2];
      return pc + 4;
    }

    DIV(code, pc) {
      code[code[pc + 3]] = code[pc + 1] / code[pc + 2];
      return pc + 4;
    }

    MOD(code, pc) {
      code[code[pc + 3]] = code[pc + 1] % code[pc + 2];
      return pc + 4;
    }

    AND(code, pc) {
      code[code[pc + 3]] = code[pc + 1] & code[pc + 2];
      return pc + 4;
    }

    OR(code, pc) {
      code[code[pc + 3]] = code[pc + 1] | code[pc + 2];
      return pc + 4;
    }

    XOR(code, pc) {
      code[code[pc + 3]] = code[pc + 1] ^ code[pc + 2];
      return pc + 4;
    }

    NOT(code, pc) {
      code[code[pc + 2]] = ~code[pc + 1];
      return pc + 3;
    }

    LNOT(code, pc) {
      code[code[pc + 2]] = !code[pc + 1];
      return pc + 3;
    }

    LSH(code, pc) {
      code[code[pc + 3]] = code[pc + 1] << code[pc + 2];
      return pc + 4;
    }

    RSH(code, pc) {
      code[code[pc + 3]] = code[pc + 1] >> code[pc + 2];
      return pc + 4;
    }

    URSH(code, pc) {
      code[code[pc + 3]] = code[pc + 1] >>> code[pc + 2];
      return pc + 4;
    }

    INC(code, pc) {
      code[code[pc + 2]] = code[pc + 1] + 1;
      return pc + 3;
    }

    DEC(code, pc) {
      code[code[pc + 2]] = code[pc + 1] - 1;
      return pc + 3;
    }

    CEQ(code, pc) {
      code[code[pc + 3]] = code[pc + 1] == code[pc + 2];
      return pc + 4;
    }

    CSEQ(code, pc) {
      code[code[pc + 3]] = code[pc + 1] === code[pc + 2];
      return pc + 4;
    }

    CNE(code, pc) {
      code[code[pc + 3]] = code[pc + 1] != code[pc + 2];
      return pc + 4;
    }

    CSNE(code, pc) {
      code[code[pc + 3]] = code[pc + 1] !== code[pc + 2];
      return pc + 4;
    }

    CLT(code, pc) {
      code[code[pc + 3]] = code[pc + 1] < code[pc + 2];
      return pc + 4;
    }

    CGT(code, pc) {
      code[code[pc + 3]] = code[pc + 1] > code[pc + 2];
      return pc + 4;
    }

    CLE(code, pc) {
      code[code[pc + 3]] = code[pc + 1] <= code[pc + 2];
      return pc + 4;
    }

    CGE(code, pc) {
      code[code[pc + 3]] = code[pc + 1] >= code[pc + 2];
      return pc + 4;
    }

    DUP(code, pc) {
      const v = code[pc + 1];
      code[code[pc + 2]] = v;
      code[code[pc + 3]] = v;
      return pc + 4;
    }

    THIS(code, pc) {
      code[code[pc + 1]] = this.thisObject;
      return pc + 2;
    }

    ARRAY(code, pc) {
      const count = code[pc + 1];
      const arr = new Array(count);
      const stack = this.stack;
      for (let i = 0; i < count; i++) {
        arr[i] = stack.pop();
      }
      arr.reverse();
      code[code[pc + 2]] = arr;
      return pc + 3;
    }

    OBJ(code, pc) {
      const count = code[pc + 1];
      const obj = {};
      const stack = this.stack;
      for (let i = 0; i < count; i++) {
        const val = stack.pop();
        obj[stack.pop()] = val;
      }
      code[code[pc + 2]] = obj;
      return pc + 3;
    }

    SETL(code, pc) {
      if (String(code[pc + 1]) == "__scope") {
        throw new Error("cannot assign __scope!");
      }
      this.localObject[code[pc + 1]] = code[code[pc + 3]] = code[pc + 2];
      return pc + 4;
    }

    GETL(code, pc) {
      code[code[pc + 2]] = this.localObject[code[pc + 1]];
      return pc + 3;
    }

    SET(code, pc) {
      const name = code[pc + 1];
      if (name == "__scope") {
        throw new Error("cannot assign __scope!");
      }
      let scope = this.localObject;
      while (scope != null) {
        if (hasOwn(scope, name)) {
          scope[name] = code[code[pc + 3]] = code[pc + 2];
          return pc + 4;
        }
        scope = scope.__scope;
      }
      this.global[name] = code[code[pc + 3]] = code[pc + 2];
      return pc + 4;
    }

    GET(code, pc) {
      const name = code[pc + 1];
      let scope = this.localObject;
      while (scope != null) {
        if (hasOwn(scope, name)) {
          code[code[pc + 2]] = scope[name];
          return pc + 3;
        }
        scope = scope.__scope;
      }
      code[code[pc + 2]] = undefined;
      return pc + 3;
    }

    SETM(code, pc) {
      if (String(code[pc + 2]) == "__scope") {
        throw new Error("cannot assign __scope!");
      }
      code[pc + 1][code[pc + 2]] = code[code[pc + 4]] = code[pc + 3];
      return pc + 5;
    }

    // Legacy security limits (VirtualMachine.as L621-638/L660-674):
    // elements cannot read root/parent/stage/loaderInfo (no display-list climbing)
    _guardDisplayProp(obj, name) {
      const El = M8.M8Element;
      if (El && obj instanceof El) {
        const n = String(name);
        if (n === "root" || n === "parent" || n === "stage") {
          throw new Error("property denied (no climbing the display list)");
        }
        if (n === "loaderInfo") {
          throw new Error("property not accessible.");
        }
      }
    }

    GETM(code, pc) {
      const name = code[pc + 2];
      this._guardDisplayProp(code[pc + 1], name);
      code[code[pc + 3]] = code[pc + 1][name];
      return pc + 4;
    }

    GETMV(code, pc) {
      let member = undefined;
      if (code[pc + 2] == "GETL") {
        member = this.localObject[code[pc + 3]];
      } else {
        let scope = this.localObject;
        while (scope != null) {
          if (hasOwn(scope, code[pc + 3])) {
            member = scope[code[pc + 3]];
          }
          scope = scope.__scope;
        }
      }
      this._guardDisplayProp(code[pc + 1], member);
      code[code[pc + 4]] = code[pc + 1][member];
      return pc + 5;
    }

    NEW(code, pc) {
      const fn = code[pc + 1];
      if (typeof fn !== "function") {
        throw new Error("1006: new target is not a function");
      }
      let n = code[pc + 2] + 1;
      const stack = this.stack;
      const args = [];
      while (--n) {
        args.push(stack.pop());
      }
      code[code[pc + 3]] = fn.apply(fn, args) || fn;
      return pc + 4;
    }

    DEL(code, pc) {
      const name = code[pc + 1];
      let scope = this.localObject;
      while (scope != null) {
        if (hasOwn(scope, name)) {
          code[code[pc + 2]] = delete scope[name];
          return pc + 3;
        }
        scope = scope.__scope;
      }
      code[code[pc + 2]] = false;
      return pc + 3;
    }

    DELL(code, pc) {
      code[code[pc + 2]] = delete this.localObject[code[pc + 1]];
      return pc + 3;
    }

    DELM(code, pc) {
      code[code[pc + 3]] = delete code[pc + 1][code[pc + 2]];
      return pc + 4;
    }

    TYPEOF(code, pc) {
      code[code[pc + 2]] = typeof code[pc + 1];
      return pc + 3;
    }

    INSOF(code, pc) {
      code[code[pc + 3]] = code[pc + 1] instanceof code[pc + 2];
      return pc + 4;
    }

    NUM(code, pc) {
      code[code[pc + 2]] = Number(code[pc + 1]);
      return pc + 3;
    }

    STR(code, pc) {
      code[code[pc + 2]] = String(code[pc + 1]);
      return pc + 3;
    }

    WITH(code, pc) {
      const obj = code[pc + 1];
      obj.__scope = this.localObject;
      this.localObject = obj;
      return pc + 2;
    }

    EWITH(code, pc) {
      this.localObject = this.localObject.__scope;
      return pc + 1;
    }

    PUSH(code, pc) {
      this.stack.push(code[pc + 1]);
      return pc + 2;
    }

    POP(code, pc) {
      code[code[pc + 1]] = this.stack.pop();
      return pc + 2;
    }
  }
  M8.VirtualMachine = VirtualMachine;
})(typeof window !== 'undefined' ? window : globalThis);
