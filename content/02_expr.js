/* M8 Label / ExpressionResult - port of scripting/Label.as + ExpressionResult.as */
(function (global) {
  "use strict";
  const M8 = global.M8RE;

  class Label {
    constructor() {
      this.initialize();
    }
    initialize() {
      this.address = null;
      this.isExists = false;
    }
    commitAddress(a) {
      this.address = a;
      this.isExists = true;
    }
  }
  M8.Label = Label;

  class ExpressionResult {
    constructor() {
      this.initialize();
    }

    static createLiteral(v) {
      const r = new ExpressionResult();
      r.setTypeLiteral(v);
      return r;
    }

    static createStack() {
      const r = new ExpressionResult();
      r.setTypeStack();
      return r;
    }

    clone() {
      const r = new ExpressionResult();
      r.setTypeAndValue(this.type, this.value);
      return r;
    }

    initialize() {
      this.type = "empty";
      this.value = null;
    }

    setType(t) { this.type = t; }

    isType(t) { return this.type == t; }

    setValue(v) { this.value = v; }

    setTypeAndValue(t, v) {
      this.type = t;
      this.value = v;
    }

    isLiteral() { return this.isType("literal"); }

    isVariableOrMember() { return this.isVariable() || this.isMember(); }

    isVariable() { return this.isType("variable"); }

    isMember() { return this.isType("member"); }

    setTypeStack() { this.setType("stack"); }

    setTypeLiteral(v) { this.setTypeAndValue("literal", v); }

    setTypeMember(obj, member) {
      this.setTypeAndValue("member", { object: obj, member: member });
    }

    getObjectExpression() {
      if (!this.isMember()) return null;
      return this.value.object;
    }

    getMemberExpression() {
      if (!this.isMember()) return null;
      return this.value.member;
    }
  }
  M8.ExpressionResult = ExpressionResult;
})(typeof window !== 'undefined' ? window : globalThis);
