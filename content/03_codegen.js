/* M8 code generator - port of scripting/CodeGenerator.as
 *
 * Bytecode model (identical to AS3):
 *  - code: array, code[pc] is the op name string, operands inline in next slots
 *  - "registers" are code slots: producing ops leave the last operand slot null,
 *    consumers backfill it with their operand index via putLoadStack;
 *    at runtime the op writes the value through that pointer
 *  - dropped value slots backfill 0; producing ops write to code[0] (trash slot, deleted on execute)
 *  - Labels support chained backfill (linked list until commit)
 */
(function (global) {
  "use strict";
  const M8 = global.M8RE;
  const Label = M8.Label;

  class CodeGenerator {
    constructor() {
      this.initialize();
    }

    initialize() {
      this.code = [];
      this.stackList = [];
      this.localVariableList = [];
      this.put(null);          // code[0] trash slot
      this.beginNewScope();
    }

    error(msg) {
      throw new Error("CodeGenerator [error] " + msg);
    }

    getCode() {
      return this.code;
    }

    put(v) {
      this.code.push(v);
      return this.code.length - 1;
    }

    putStoreStack() {
      this.stackList.push(this.put(null));
    }

    putLoadStack() {
      const code = this.code;
      let s = this.stackList.pop();          // slot to consume
      const n = this.put(null);              // new slot (operand position)
      for (;;) {
        const next = code[s];
        code[s] = n;                         // chain backfill
        if (next == null) break;
        s = next;
      }
    }

    popStack() {
      return this.stackList.pop();
    }

    pushStack(v) {
      this.stackList.push(v);
    }

    setStackPatch(target) {
      const top = this.stackList[this.stackList.length - 1];
      if (this.code[top] != null) {
        this.setStackPatchRecursive(this.code[top], target);
      } else {
        this.code[top] = target;
      }
    }

    setStackPatchRecursive(slot, target) {
      if (this.code[slot] == null) {
        this.code[slot] = target;
      } else {
        this.setStackPatchRecursive(this.code[slot], target);
      }
    }

    putCrossLoadStack() {
      this.swapStack(undefined, undefined);
      this.putLoadStack();
      this.putLoadStack();
    }

    swapStack(a, b) {
      const i = this.stackList.length - (a !== undefined ? a : 0) - 1;
      const j = this.stackList.length - (b !== undefined ? b : 1) - 1;
      const t = this.stackList[i];
      this.stackList[i] = this.stackList[j];
      this.stackList[j] = t;
    }

    getStackLength() {
      return this.stackList.length;
    }

    cleanUpStack(len) {
      if (len === undefined) len = 0;
      while (this.stackList.length > len) {
        this.popAndDestroyStack();
      }
    }

    popAndDestroyStack() {
      const code = this.code;
      let s = this.stackList.pop();
      for (;;) {
        const next = code[s];
        code[s] = 0;                         // destroy marker
        if (next == null) break;
        s = next;
      }
    }

    putLabel(label) {
      if (label.isExists) {
        this.put(label.address);
      } else {
        label.address = this.put(label.address); // chain: new slot points to old
      }
    }

    setLabel(label) {
      const addr = this.code.length;
      this.setLabelAddress(label, addr);
      label.commitAddress(addr);
    }

    setLabelAddress(label, addr) {
      const code = this.code;
      let cur = label.address;
      while (cur != null) {
        const next = code[cur];
        code[cur] = addr;
        cur = next;
      }
    }

    beginNewScope() {
      this.localVariableList.unshift({});
    }

    closeScope() {
      this.localVariableList.shift();
    }

    isLocalVariable(name) {
      return M8.hasOwn(this.localVariableList[0], String(name));
    }

    addLocalVariable(name) {
      this.localVariableList[0][name] = true;
    }

    putExpressionResult(er) {
      switch (er.type) {
        case "variable":
          this.putGetVariable(String(er.value));
          er.setType("stack");
          break;
        case "member":
          this.putGetMember(er.getObjectExpression(), er.getMemberExpression());
          er.setType("stack");
          break;
      }
    }

    putValue(er) {
      switch (er.type) {
        case "literal":
          this.put(er.value);
          break;
        case "stack":
          this.putLoadStack();
          break;
        default:
          this.error("putValueError");
      }
    }

    putBinaryValue(a, b) {
      if (a.isType("literal") && b.isType("literal")) {
        this.put(a.value);
        this.put(b.value);
      } else if (a.isType("stack") && b.isType("stack")) {
        this.putCrossLoadStack();
      } else if (a.isType("stack")) {
        this.putLoadStack();
        this.put(b.value);
      } else if (b.isType("stack")) {
        this.put(a.value);
        this.putLoadStack();
      } else {
        this.error("putBinaryValueError");
      }
    }

    putSuspend() {
      this.put("SPD");
    }

    putLiteral(er) {
      this.put("LIT");
      this.put(er.value);
      this.putStoreStack();
    }

    putCall(er, argc) {
      if (this.isLocalVariable(er.value)) {
        this.put("CALLL");
      } else {
        this.put("CALL");
      }
      this.put(er.value);
      this.put(argc);
      this.putStoreStack();
    }

    putCallMember(obj, member, argc) {
      this.put("CALLM");
      this.putBinaryValue(obj, member);
      this.put(argc);
      this.putStoreStack();
    }

    putCallFunctor(argc) {
      this.put("CALLF");
      this.putLoadStack();
      this.put(argc);
      this.putStoreStack();
    }

    putReturnFunction(er) {
      this.put("RET");
      this.putValue(er);
    }

    putReturnCoroutine(er) {
      this.put("CRET");
      this.putValue(er);
    }

    putFunction() {
      const label = new Label();
      this.put("FUNC");
      this.putLabel(label);
      this.putStoreStack();
      return label;
    }

    putCoroutine() {
      const label = new Label();
      this.put("COR");
      this.putLabel(label);
      this.putStoreStack();
      return label;
    }

    putArgument(index, name) {
      this.put("ARG");
      this.put(index);
      this.put(name);
      this.addLocalVariable(name);
    }

    putJump(label) {
      this.put("JMP");
      this.putLabel(label);
    }

    putIf(er, label) {
      this.put("IF");
      this.putValue(er);
      this.putLabel(label);
    }

    putNif(er, label) {
      this.put("NIF");
      this.putValue(er);
      this.putLabel(label);
    }

    putBinaryOperation(op, a, b) {
      this.put(op);
      this.putBinaryValue(a, b);
      this.putStoreStack();
    }

    putUnaryOperation(op, er) {
      this.put(op);
      this.putValue(er);
      this.putStoreStack();
    }

    putIncrement(er) {
      this.putIncDec("INC", false, er);
    }

    putDecrement(er) {
      this.putIncDec("DEC", false, er);
    }

    putPostfixIncrement(er) {
      this.putIncDec("INC", true, er);
    }

    putPostfixDecrement(er) {
      this.putIncDec("DEC", true, er);
    }

    putIncDec(op, postfix, er) {
      let slot;
      let obj, member, name;
      switch (er.type) {
        case "member":
          obj = er.getObjectExpression();
          member = er.getMemberExpression();
          if (!member.isLiteral()) {
            this.putExpressionResult(member);
            slot = this.popStack();
            this.putDuplicate(member);
            this.pushStack(slot);
            this.putDuplicate(obj);
            this.swapStack(1, 2);
          } else {
            this.putDuplicate(obj);
          }
          this.putGetMember(obj, member);
          er.setTypeStack();
          if (postfix) {
            this.putDuplicate(er);
            slot = this.popStack();
            this.putUnaryOperation(op, er);
            this.putSetMember(obj, member, er);
            this.popAndDestroyStack();
            this.pushStack(slot);
            break;
          }
          this.putUnaryOperation(op, er);
          this.putSetMember(obj, member, er);
          break;
        case "variable":
          name = String(er.value);
          this.putGetVariable(name);
          er.setTypeStack();
          if (postfix) {
            this.putDuplicate(er);
          }
          this.putUnaryOperation(op, er);
          this.putSetVariable(name, er);
          if (postfix) {
            this.popAndDestroyStack();
          }
          break;
        default:
          this.error("putIncDecError");
      }
    }

    putWith(er) {
      this.put("WITH");
      this.putValue(er);
    }

    putEndWith() {
      this.put("EWITH");
    }

    putPush(er) {
      this.put("PUSH");
      this.putValue(er);
    }

    putPop() {
      this.put("POP");
      this.putStoreStack();
    }

    putDuplicate(er) {
      this.put("DUP");
      this.putValue(er);
      this.putStoreStack();
      this.putStoreStack();
    }

    putThis() {
      this.put("THIS");
      this.putStoreStack();
    }

    putArrayLiteral(count) {
      this.put("ARRAY");
      this.put(count);
      this.putStoreStack();
    }

    putObjectLiteral(count) {
      this.put("OBJ");
      this.put(count);
      this.putStoreStack();
    }

    putGetVariable(name) {
      if (this.isLocalVariable(name)) {
        this.put("GETL");
      } else {
        this.put("GET");
      }
      this.put(name);
      this.putStoreStack();
    }

    putSetVariable(name, er) {
      if (this.isLocalVariable(name)) {
        this.put("SETL");
      } else {
        this.put("SET");
      }
      this.put(name);
      this.putValue(er);
      this.putStoreStack();
    }

    putSetLocalVariable(name, er) {
      this.put("SETL");
      this.put(name);
      this.putValue(er);
      this.putStoreStack();
      this.addLocalVariable(name);
    }

    putGetMember(obj, member) {
      if (member.isType("variable")) {
        // computed member access obj[var]: GETMV, 2nd operand marks load op
        this.put("GETMV");
        if (obj.isType("literal")) {
          this.put(obj.value);
        } else {
          this.putLoadStack();
        }
        if (this.isLocalVariable(member.value)) {
          this.put("GETL");
        } else {
          this.put("GET");
        }
        this.put(member.value);
        this.putStoreStack();
      } else {
        this.put("GETM");
        this.putBinaryValue(obj, member);
        this.putStoreStack();
      }
    }

    putSetMember(obj, member, val) {
      this.put("SETM");
      if (obj.isLiteral()) {
        if (member.isLiteral()) {
          if (val.isLiteral()) {
            this.put(obj.value);
            this.put(member.value);
            this.put(val.value);
          } else {
            this.put(obj.value);
            this.put(member.value);
            this.putLoadStack();
          }
        } else if (val.isLiteral()) {
          this.put(obj.value);
          this.putLoadStack();
          this.put(val.value);
        } else {
          this.put(obj.value);
          this.putCrossLoadStack();
        }
      } else if (member.isLiteral()) {
        if (val.isLiteral()) {
          this.putLoadStack();
          this.put(member.value);
          this.put(val.value);
        } else {
          this.swapStack(undefined, undefined);
          this.putLoadStack();
          this.put(member.value);
          this.putLoadStack();
        }
      } else if (val.isLiteral()) {
        this.putCrossLoadStack();
        this.put(val.value);
      } else {
        this.swapStack(0, 2);
        this.putLoadStack();
        this.putLoadStack();
        this.putLoadStack();
      }
      this.putStoreStack();
    }

    putNew(argc) {
      this.put("NEW");
      this.putLoadStack();
      this.put(argc);
      this.putStoreStack();
    }

    putDelete(er) {
      if (er.isType("variable") || er.isType("literal")) {
        if (this.isLocalVariable(er.value)) {
          this.put("DELL");
        } else {
          this.put("DEL");
        }
        this.put(er.value);
        this.putStoreStack();
      } else {
        this.put("DEL");
        this.putLoadStack();
        this.putStoreStack();
      }
    }

    putDeleteMember(obj, member) {
      this.put("DELM");
      this.putBinaryValue(obj, member);
      this.putStoreStack();
    }
  }
  M8.CodeGenerator = CodeGenerator;
})(typeof window !== 'undefined' ? window : globalThis);
