/* M8 parser - port of scripting/Parser.as (2086 lines).
 * The original parse(vm) "optimized" mode embeds VM method objects in the
 * bytecode; this port always uses op-name strings (equivalent, keeps GETMV checks).
 */
(function (global) {
  "use strict";
  const M8 = global.M8RE;
  const ExpressionResult = M8.ExpressionResult;
  const Label = M8.Label;
  const VMSyntaxError = M8.VMSyntaxError;

  class Parser {
    constructor(scanner) {
      this.scanner = scanner;
      this.parseForceCoroutine = false;
      this.vmtarget = null;
    }

    getToken() {
      return this.token;
    }

    nextToken() {
      this.token = this.scanner.getToken();
      return this.token;
    }

    isToken(type) {
      if (this.token == null) return false;
      return this.token.type == type;
    }

    isNextToken(type) {
      return this.nextToken().type == type;
    }

    initialize() {
      this.scanner.rewind();
      this.generator = new M8.CodeGenerator();
      this.breakLabelList = [];
      this.continueLabelList = [];
      this.functionStack = [];
      this.hasLastReturn = false;
      this.lastReturnCaution = 0;
      this.nextToken();
    }

    setForceCoroutine(v) {
      this.parseForceCoroutine = v;
    }

    parse(vm) {
      this.initialize();
      if (vm != null) {
        this.generator.vmtarget = vm;
        this.vmtarget = vm;
      }
      this.parse_program();
      return this.generator.getCode();
    }

    causeSyntaxError(msg) {
      throw new VMSyntaxError("Parser [causeSyntaxError] on line " + this.scanner.getLineNumber() + " " + msg + " (" + (this.getToken() ? this.getToken().type : 'EOF') + ")" + " " + this.scanner.getLine());
    }

    pushBreakLabel(l) { this.breakLabelList.unshift(l); }
    popBreakLabel() { return this.breakLabelList.shift(); }
    getBreakLabel() {
      if (this.breakLabelList.length < 1) {
        this.causeSyntaxError("break cannot be used here");
      }
      return this.breakLabelList[0];
    }

    pushContinueLabel(l) { this.continueLabelList.unshift(l); }
    popContinueLabel() { return this.continueLabelList.shift(); }
    getContinueLabel() {
      if (this.continueLabelList.length < 1) {
        this.causeSyntaxError("continue cannot be used here");
      }
      return this.continueLabelList[0];
    }

    beginFunction() { this.functionStack.unshift(true); }
    endFunction() { this.functionStack.shift(); }
    beginCoroutine() { this.functionStack.unshift(false); }
    endCoroutine() { this.functionStack.shift(); }

    isAllowReturn() {
      return this.functionStack.length > 0;
    }

    isInFunction() {
      return this.functionStack.length > 0 && !!this.functionStack[0];
    }

    parse_program() {
      this.parse_sourceElements();
    }

    parse_sourceElements() {
      this.parse_sourceElement();
      while (this.getToken() != null) {
        if (this.isToken("}")) {
          return;
        }
        this.parse_sourceElement();
      }
    }

    parse_sourceElement() {
      if (this.isToken("function")) {
        if (this.parseForceCoroutine == true) {
          this.token.type = "coroutine";
          this.parse_coroutineDeclaration();
        } else {
          this.parse_functionDeclaration();
        }
      } else if (this.isToken("coroutine")) {
        this.parse_coroutineDeclaration();
      } else if (this.isStatementFirst(this.getToken() == null ? null : this.getToken().type)) {
        this.parse_statement();
      } else {
        this.causeSyntaxError("SourceElement found an unexpected token");
      }
    }

    parse_functionDeclaration() {
      if (!this.isToken("function")) {
        this.causeSyntaxError("'function' not found in function declaration");
      }
      if (!this.isNextToken("identifier")) {
        this.causeSyntaxError("function name not found in function declaration");
      }
      const name = String(this.getToken().value);
      const label = this.generator.putFunction();
      this.beginFunction();
      this.generator.beginNewScope();
      if (!this.isNextToken("(")) {
        this.causeSyntaxError("'(' not found in function declaration");
      }
      if (this.isNextToken("identifier")) {
        this.parse_formalParameterList();
      }
      if (!this.isToken(")")) {
        this.causeSyntaxError("')' not found in function declaration");
      }
      if (!this.isNextToken("{")) {
        this.causeSyntaxError("'{' not found in function declaration");
      }
      if (!this.isNextToken("}")) {
        this.parse_functionBody();
      }
      if (!this.hasLastReturn) {
        this.generator.putReturnFunction(ExpressionResult.createLiteral(undefined));
      }
      if (!this.isToken("}")) {
        this.causeSyntaxError("'}' not found in function declaration");
      }
      this.endFunction();
      this.generator.closeScope();
      this.generator.setLabel(label);
      this.generator.putSetLocalVariable(name, ExpressionResult.createStack());
      this.generator.popAndDestroyStack();
      this.nextToken();
    }

    parse_functionExpression(er) {
      if (!this.isToken("function")) {
        this.causeSyntaxError("'function' not found in function expression");
      }
      let name = null;
      if (this.isNextToken("identifier")) {
        name = String(this.getToken().value);
        this.nextToken();
      }
      const label = this.generator.putFunction();
      this.beginFunction();
      this.generator.beginNewScope();
      if (!this.isToken("(")) {
        this.causeSyntaxError("'(' not found in function expression");
      }
      if (this.isNextToken("identifier")) {
        this.parse_formalParameterList();
      }
      if (!this.isToken(")")) {
        this.causeSyntaxError("')' not found in function expression");
      }
      if (!this.isNextToken("{")) {
        this.causeSyntaxError("'{' not found in function expression");
      }
      if (!this.isNextToken("}")) {
        this.parse_functionBody();
      }
      if (!this.hasLastReturn) {
        this.generator.putReturnFunction(ExpressionResult.createLiteral(undefined));
      }
      if (!this.isToken("}")) {
        this.causeSyntaxError("'}' not found in function expression");
      }
      this.generator.closeScope();
      this.endFunction();
      this.generator.setLabel(label);
      if (name != null) {
        this.generator.putSetLocalVariable(name, ExpressionResult.createStack());
      }
      er.setTypeStack();
      this.nextToken();
    }

    parse_coroutineDeclaration() {
      if (!this.isToken("coroutine")) {
        this.causeSyntaxError("'coroutine' not found in coroutine declaration");
      }
      if (!this.isNextToken("identifier")) {
        this.causeSyntaxError("coroutine name not found in coroutine declaration");
      }
      const name = String(this.getToken().value);
      const label = this.generator.putCoroutine();
      this.beginCoroutine();
      this.generator.beginNewScope();
      if (!this.isNextToken("(")) {
        this.causeSyntaxError("'(' not found in coroutine declaration");
      }
      if (this.isNextToken("identifier")) {
        this.parse_formalParameterList();
      }
      if (!this.isToken(")")) {
        this.causeSyntaxError("')' not found in coroutine declaration");
      }
      if (!this.isNextToken("{")) {
        this.causeSyntaxError("'{' not found in coroutine declaration");
      }
      if (!this.isNextToken("}")) {
        this.parse_functionBody();
      }
      if (!this.hasLastReturn) {
        this.generator.putReturnCoroutine(ExpressionResult.createLiteral(undefined));
      }
      if (!this.isToken("}")) {
        this.causeSyntaxError("'}' not found in coroutine declaration");
      }
      this.generator.closeScope();
      this.endCoroutine();
      this.generator.setLabel(label);
      this.generator.putSetLocalVariable(name, ExpressionResult.createStack());
      this.generator.popAndDestroyStack();
      this.nextToken();
    }

    parse_coroutineExpression(er) {
      if (!this.isToken("coroutine")) {
        this.causeSyntaxError("'coroutine' not found in coroutine expression");
      }
      let name = null;
      if (this.isNextToken("identifier")) {
        name = String(this.getToken().value);
        this.nextToken();
      }
      const label = this.generator.putCoroutine();
      this.beginCoroutine();
      this.generator.beginNewScope();
      if (!this.isToken("(")) {
        this.causeSyntaxError("'(' not found in coroutine expression");
      }
      if (this.isNextToken("identifier")) {
        this.parse_formalParameterList();
      }
      if (!this.isToken(")")) {
        this.causeSyntaxError("')' not found in coroutine expression");
      }
      if (!this.isNextToken("{")) {
        this.causeSyntaxError("'{' not found in coroutine expression");
      }
      if (!this.isNextToken("}")) {
        this.parse_functionBody();
      }
      if (!this.hasLastReturn) {
        this.generator.putReturnCoroutine(ExpressionResult.createLiteral(undefined));
      }
      if (!this.isToken("}")) {
        this.causeSyntaxError("'}' not found in coroutine expression");
      }
      this.generator.closeScope();
      this.endCoroutine();
      this.generator.setLabel(label);
      if (name != null) {
        this.generator.putSetLocalVariable(name, ExpressionResult.createStack());
      }
      er.setTypeStack();
      this.nextToken();
    }

    parse_formalParameterList() {
      let index = 0;
      for (;;) {
        if (!this.isToken("identifier")) {
          this.causeSyntaxError("Parameter name is required");
        }
        this.generator.putArgument(index, String(this.getToken().value));
        index++;
        if (!this.isNextToken(",")) break;
        this.nextToken();
      }
    }

    parse_functionBody() {
      this.parse_sourceElements();
    }

    parse_statement() {
      this.hasLastReturn = false;
      const stackLen = this.generator.getStackLength();
      const t = this.getToken() ? this.getToken().type : null;
      switch (t) {
        case "{":
          this.parse_block();
          break;
        case "var":
          this.parse_variableStatement();
          break;
        case ";":
          this.parse_emptyStatement();
          break;
        case "if":
          this.parse_ifStatement();
          break;
        case "do":
        case "while":
        case "for":
          this.parse_iterationStatement();
          break;
        case "continue":
          this.parse_continueStatement();
          break;
        case "break":
          this.parse_breakStatement();
          break;
        case "return":
          this.parse_returnStatement();
          break;
        case "with":
          this.parse_withStatement();
          break;
        case "switch":
          this.parse_switchStatement();
          break;
        case "yield":
          this.parse_yieldStatement();
          break;
        case "suspend":
          this.parse_suspendStatement();
          break;
        case "loop":
          this.parse_loopStatement();
          break;
        case "function":
          this.causeSyntaxError("Functions are not defined in statements");
          break;
        default:
          if (this.isExpressionFirst(t)) {
            this.parse_expressionStatement();
            break;
          }
          this.causeSyntaxError("Unexpected statement token");
      }
      this.generator.cleanUpStack(stackLen);
    }

    isStatementFirst(type) {
      return type == "{" || type == "var" || type == ";" || type == "if" || type == "do" || type == "while" || type == "for" || type == "for" || type == "continue" || type == "break" || type == "return" || type == "with" || type == "switch" || type == "yield" || type == "suspend" || type == "loop" || (type != "function" && type != "coroutine" && this.isExpressionFirst(type));
    }

    parse_block() {
      if (!this.isToken("{")) {
        this.causeSyntaxError("'{' not found in block");
      }
      if (!this.isNextToken("}")) {
        this.parse_statementList();
      }
      if (!this.isToken("}")) {
        this.causeSyntaxError("'}' not found in block");
      }
      this.nextToken();
    }

    parse_statementList() {
      this.parse_statement();
      while (!this.isToken("}")) {
        if (!this.isStatementFirst(this.getToken() ? this.getToken().type : null)) {
          return;
        }
        this.parse_statement();
      }
    }

    parse_variableStatement() {
      if (!this.isToken("var")) {
        this.causeSyntaxError("'var' not found in variable declaration");
      }
      this.nextToken();
      this.parse_variableDeclarationList();
      if (!this.isToken(";")) {
        this.causeSyntaxError("Variable declaration must end with ;");
      }
      this.nextToken();
    }

    parse_variableDeclarationList() {
      this.parse_variableDeclaration();
      while (this.isToken(",")) {
        this.nextToken();
        this.parse_variableDeclaration();
      }
    }

    parse_variableDeclaration() {
      let er = null;
      if (!this.isToken("identifier")) {
        this.causeSyntaxError("Variable name not found in variable declaration");
      }
      const name = String(this.getToken().value);
      if (this.isNextToken("=")) {
        er = new ExpressionResult();
        this.parse_initialiser(er);
        this.generator.putExpressionResult(er);
        this.generator.putSetLocalVariable(name, er);
        this.generator.popAndDestroyStack();
      } else {
        this.generator.putSetLocalVariable(name, ExpressionResult.createLiteral(undefined));
        this.generator.popAndDestroyStack();
      }
    }

    parse_initialiser(er) {
      if (!this.isToken("=")) {
        this.causeSyntaxError("'=' not found in variable initialization");
      }
      this.nextToken();
      this.parse_assignmentExpression(er);
    }

    parse_emptyStatement() {
      if (!this.isToken(";")) {
        this.causeSyntaxError("';' not found in empty statement");
      }
      this.nextToken();
    }

    parse_expressionStatement() {
      if (this.isToken("{") || this.isToken("function")) {
        this.causeSyntaxError("Ambiguity found in ExpressionStatement");
      }
      const er = new ExpressionResult();
      this.parse_expression(er);
      this.generator.putExpressionResult(er);
      if (!this.isToken(";")) {
        this.causeSyntaxError("';' not found in expression statement");
      }
      this.nextToken();
    }

    parse_ifStatement() {
      let elseLabel = null;
      ++this.lastReturnCaution;
      if (!this.isToken("if")) {
        this.causeSyntaxError("'if' not found in if statement");
      }
      if (!this.isNextToken("(")) {
        this.causeSyntaxError("'(' not found in if statement");
      }
      this.nextToken();
      const cond = new ExpressionResult();
      this.parse_expression(cond);
      if (!this.isToken(")")) {
        this.causeSyntaxError("')' not found in if statement");
      }
      this.generator.putExpressionResult(cond);
      const falseLabel = new Label();
      this.generator.putIf(cond, falseLabel);
      this.nextToken();
      this.parse_statement();
      if (this.isToken("else")) {
        elseLabel = new Label();
        this.generator.putJump(elseLabel);
        this.generator.setLabel(falseLabel);
        this.nextToken();
        this.parse_statement();
        this.generator.setLabel(elseLabel);
      } else {
        this.generator.setLabel(falseLabel);
      }
      --this.lastReturnCaution;
    }

    parse_iterationStatement() {
      ++this.lastReturnCaution;
      if (this.isToken("for")) {
        this.parse_forStatement();
      } else if (this.isToken("while")) {
        this.parse_whileStatement();
      } else if (this.isToken("do")) {
        this.parse_doStatement();
      } else {
        this.causeSyntaxError("unexpected token found in loop statement");
      }
      --this.lastReturnCaution;
    }

    parse_forStatement() {
      let stackLen;
      let init = null, cond = null, step = null;
      if (!this.isNextToken("(")) {
        this.causeSyntaxError("'(' not found in for statement");
      }
      const condLabel = new Label();
      const stepLabel = new Label();
      const bodyLabel = new Label();
      const endLabel = new Label();
      this.pushBreakLabel(endLabel);
      this.pushContinueLabel(stepLabel);
      if (this.isNextToken("var")) {
        this.nextToken();
        this.parse_variableDeclaration();
      } else if (!this.isToken(";")) {
        stackLen = this.generator.getStackLength();
        init = new ExpressionResult();
        this.parse_expression(init);
        this.generator.putExpressionResult(init);
        this.generator.cleanUpStack(stackLen);
      }
      if (!this.isToken(";")) {
        this.causeSyntaxError("';' not found in for statement");
      }
      this.generator.setLabel(condLabel);
      if (!this.isNextToken(";")) {
        stackLen = this.generator.getStackLength();
        cond = new ExpressionResult();
        this.parse_expression(cond);
        this.generator.putExpressionResult(cond);
        this.generator.putIf(cond, endLabel);
        this.generator.cleanUpStack(stackLen);
      }
      if (!this.isToken(";")) {
        this.causeSyntaxError("';' not found in for statement");
      }
      this.generator.putJump(bodyLabel);
      this.generator.setLabel(stepLabel);
      if (!this.isNextToken(")")) {
        stackLen = this.generator.getStackLength();
        step = new ExpressionResult();
        this.parse_expression(step);
        this.generator.putExpressionResult(step);
        this.generator.cleanUpStack(stackLen);
      }
      this.generator.putJump(condLabel);
      if (!this.isToken(")")) {
        this.causeSyntaxError("')' not found in for statement");
      }
      this.nextToken();
      this.generator.setLabel(bodyLabel);
      this.parse_statement();
      this.generator.putJump(stepLabel);
      this.generator.setLabel(endLabel);
      this.popContinueLabel();
      this.popBreakLabel();
    }

    parse_whileStatement() {
      if (!this.isNextToken("(")) {
        this.causeSyntaxError("'(' not found in while statement");
      }
      this.nextToken();
      const condLabel = new Label();
      const endLabel = new Label();
      this.pushBreakLabel(endLabel);
      this.pushContinueLabel(condLabel);
      this.generator.setLabel(condLabel);
      const cond = new ExpressionResult();
      this.parse_expression(cond);
      this.generator.putExpressionResult(cond);
      this.generator.putIf(cond, endLabel);
      if (!this.isToken(")")) {
        this.causeSyntaxError("')' not found in while statement");
      }
      this.nextToken();
      this.parse_statement();
      this.generator.putJump(condLabel);
      this.generator.setLabel(endLabel);
      this.popContinueLabel();
      this.popBreakLabel();
    }

    parse_doStatement() {
      this.nextToken();
      const bodyLabel = new Label();
      const condLabel = new Label();
      const endLabel = new Label();
      this.pushBreakLabel(endLabel);
      this.pushContinueLabel(condLabel);
      this.generator.setLabel(bodyLabel);
      this.parse_statement();
      if (!this.isToken("while")) {
        this.causeSyntaxError("'while' not found in do statement");
      }
      if (!this.isNextToken("(")) {
        this.causeSyntaxError("'(' not found in do-while statement");
      }
      this.nextToken();
      this.generator.setLabel(condLabel);
      const cond = new ExpressionResult();
      this.parse_expression(cond);
      this.generator.putExpressionResult(cond);
      this.generator.putIf(cond, endLabel);
      this.generator.putJump(bodyLabel);
      if (!this.isToken(")")) {
        this.causeSyntaxError("')' not found in do-while statement");
      }
      this.generator.setLabel(endLabel);
      this.popContinueLabel();
      this.popBreakLabel();
      this.nextToken();
    }

    parse_continueStatement() {
      if (!this.isToken("continue")) {
        this.causeSyntaxError("'continue' not found in continue statement");
      }
      if (!this.isNextToken(";")) {
        this.causeSyntaxError("';' not found in continue statement");
      }
      this.generator.putJump(this.getContinueLabel());
      this.nextToken();
    }

    parse_breakStatement() {
      if (!this.isToken("break")) {
        this.causeSyntaxError("'break' not found in break statement");
      }
      if (!this.isNextToken(";")) {
        this.causeSyntaxError("';' not found in break statement");
      }
      this.generator.putJump(this.getBreakLabel());
      this.nextToken();
    }

    parse_returnStatement() {
      let er = null;
      if (!this.isToken("return")) {
        this.causeSyntaxError("'return' not found in return statement");
      }
      if (!this.isAllowReturn()) {
        this.causeSyntaxError("return is only used in functions or coroutines");
      }
      if (this.lastReturnCaution == 0) {
        this.hasLastReturn = true;
      }
      const afterReturn = this.nextToken();
      if (this.isExpressionFirst(afterReturn ? afterReturn.type : null)) {
        er = new ExpressionResult();
        this.parse_expression(er);
        this.generator.putExpressionResult(er);
      } else {
        er = ExpressionResult.createLiteral(undefined);
      }
      if (this.isInFunction()) {
        this.generator.putReturnFunction(er);
      } else {
        this.generator.putReturnCoroutine(er);
      }
      if (!this.isToken(";")) {
        this.causeSyntaxError("';' not found in return statement");
      }
      this.nextToken();
    }

    parse_withStatement() {
      if (!this.isToken("with")) {
        this.causeSyntaxError("'with' not found in with statement");
      }
      if (!this.isNextToken("(")) {
        this.causeSyntaxError("'(' not found in with statement");
      }
      throw new Error("with is not allowed!");
    }

    parse_switchStatement() {
      if (!this.isToken("switch")) {
        this.causeSyntaxError("'switch' not found in switch statement");
      }
      if (!this.isNextToken("(")) {
        this.causeSyntaxError("'(' not found in switch statement");
      }
      this.nextToken();
      const target = new ExpressionResult();
      this.parse_expression(target);
      this.generator.putExpressionResult(target);
      if (!this.isToken(")")) {
        this.causeSyntaxError("')' not found in switch statement");
      }
      const breakLabel = new Label();
      this.pushBreakLabel(breakLabel);
      this.nextToken();
      this.parse_caseBlock(target);
      this.generator.setLabel(breakLabel);
      this.popBreakLabel();
    }

    parse_caseBlock(target) {
      if (!this.isToken("{")) {
        this.causeSyntaxError("'{' not found in switch-case statement");
      }
      const caseChainLabel = new Label();
      const stmtChainLabel = new Label();
      if (this.isNextToken("case")) {
        this.parse_caseClauses(target, caseChainLabel, stmtChainLabel);
      }
      if (this.isToken("default")) {
        const defaultLabel = new Label();
        this.generator.setLabel(defaultLabel);
        this.parse_defaultClause(stmtChainLabel);
        if (this.isToken("case")) {
          this.parse_caseClauses(target, caseChainLabel, stmtChainLabel);
        }
        this.generator.setLabelAddress(caseChainLabel, defaultLabel.address);
        this.generator.setLabel(stmtChainLabel);
      } else {
        this.generator.setLabel(caseChainLabel);
        this.generator.setLabel(stmtChainLabel);
      }
      if (!this.isToken("}")) {
        this.causeSyntaxError("'}' not found in switch-case statement");
      }
      this.nextToken();
    }

    parse_caseClauses(target, caseChainLabel, stmtChainLabel) {
      while (this.isToken("case")) {
        this.parse_caseClause(target, caseChainLabel, stmtChainLabel);
      }
    }

    parse_caseClause(target, caseChainLabel, stmtChainLabel) {
      if (!this.isToken("case")) {
        this.causeSyntaxError("'case' not found in case statement");
      }
      this.generator.setLabel(caseChainLabel);
      caseChainLabel.initialize();
      if (!target.isLiteral()) {
        this.generator.putDuplicate(target);
      }
      this.nextToken();
      const caseValue = new ExpressionResult();
      this.parse_expression(caseValue);
      this.generator.putExpressionResult(caseValue);
      this.generator.putBinaryOperation("CSEQ", target, caseValue);
      this.generator.putIf(ExpressionResult.createStack(), caseChainLabel);
      if (!this.isToken(":")) {
        this.causeSyntaxError("':' not found in case statement");
      }
      this.generator.setLabel(stmtChainLabel);
      stmtChainLabel.initialize();
      const afterColon = this.nextToken();
      if (this.isStatementFirst(afterColon ? afterColon.type : null)) {
        this.parse_statementList();
      }
      this.generator.putJump(stmtChainLabel);
    }

    parse_defaultClause(stmtChainLabel) {
      if (!this.isToken("default")) {
        this.causeSyntaxError("'default' not found in default statement");
      }
      if (!this.isNextToken(":")) {
        this.causeSyntaxError("':' not found in default statement");
      }
      this.generator.setLabel(stmtChainLabel);
      stmtChainLabel.initialize();
      const afterColon = this.nextToken();
      if (this.isStatementFirst(afterColon ? afterColon.type : null)) {
        this.parse_statementList();
      }
      this.generator.putJump(stmtChainLabel);
    }

    parse_yieldStatement() {
      if (!this.isToken("yield")) {
        this.causeSyntaxError("'yield' not found in yield statement");
      }
      if (!this.isNextToken(";")) {
        this.causeSyntaxError("';' not found in yield statement");
      }
      if (this.isInFunction()) {
        this.causeSyntaxError("yield statement can only be used in a coroutine");
      }
      this.generator.putSuspend();
      this.nextToken();
    }

    parse_suspendStatement() {
      if (!this.isToken("suspend")) {
        this.causeSyntaxError("'suspend' not found in suspend statement");
      }
      if (!this.isNextToken(";")) {
        this.causeSyntaxError("';' not found in suspend statement");
      }
      if (this.isInFunction()) {
        this.causeSyntaxError("suspend statement can only be used in a coroutine");
      }
      this.generator.putSuspend();
      this.nextToken();
    }

    parse_loopStatement() {
      if (!this.isToken("loop")) {
        this.causeSyntaxError("'loop' not found in loop statement");
      }
      this.nextToken();
      const bodyLabel = new Label();
      const endLabel = new Label();
      this.pushBreakLabel(endLabel);
      this.pushContinueLabel(bodyLabel);
      this.generator.setLabel(bodyLabel);
      this.parse_statement();
      this.generator.putJump(bodyLabel);
      this.generator.setLabel(endLabel);
      this.popContinueLabel();
      this.popBreakLabel();
    }

    parse_expression(er) {
      this.parse_assignmentExpression(er);
      while (this.isToken(",")) {
        this.nextToken();
        this.generator.putExpressionResult(er);
        this.generator.popAndDestroyStack();
        er.initialize();
        this.parse_assignmentExpression(er);
      }
    }

    isExpressionFirst(type) {
      return this.isUnaryExpressionFirst(type);
    }

    areBothLiteral(a, b) {
      return a.isType("literal") && b.isType("literal");
    }

    parse_assignmentExpression(er) {
      let rhs = null, obj = null, member = null;
      let op = null;
      let name = null;
      this.parse_conditionalExpression(er);
      switch (this.getToken() ? this.getToken().type : null) {
        case "=":
          this.nextToken();
          switch (er.type) {
            case "member":
              obj = er.getObjectExpression();
              member = er.getMemberExpression();
              this.generator.putExpressionResult(member);
              rhs = new ExpressionResult();
              this.parse_assignmentExpression(rhs);
              this.generator.putExpressionResult(rhs);
              this.generator.putSetMember(obj, member, rhs);
              break;
            case "variable":
              rhs = new ExpressionResult();
              this.parse_assignmentExpression(rhs);
              this.generator.putExpressionResult(rhs);
              this.generator.putSetVariable(String(er.value), rhs);
              break;
            default:
              this.causeSyntaxError("L-value must be a variable or property");
          }
          er.setTypeStack();
          break;
        case "*=":
        case "/=":
        case "%=":
        case "+=":
        case "-=":
        case "<<=":
        case ">>=":
        case ">>>=":
        case "&=":
        case "^=":
        case "|=":
          switch (this.getToken().type) {
            case "*=": op = "MUL"; break;
            case "/=": op = "DIV"; break;
            case "%=": op = "MOD"; break;
            case "+=": op = "ADD"; break;
            case "-=": op = "SUB"; break;
            case "<<=": op = "LSH"; break;
            case ">>=": op = "RSH"; break;
            case ">>>=": op = "URSH"; break;
            case "&=": op = "AND"; break;
            case "^=": op = "XOR"; break;
            case "|=": op = "OR"; break;
          }
          this.nextToken();
          switch (er.type) {
            case "member":
              obj = er.getObjectExpression();
              member = er.getMemberExpression();
              if (!member.isLiteral()) {
                this.generator.putExpressionResult(member);
                const slot = this.generator.popStack();
                this.generator.putDuplicate(member);
                this.generator.pushStack(slot);
                this.generator.putDuplicate(obj);
                this.generator.swapStack(1, 2);
              } else {
                this.generator.putDuplicate(obj);
              }
              this.generator.putGetMember(obj, member);
              er.setTypeStack();
              rhs = new ExpressionResult();
              this.parse_assignmentExpression(rhs);
              this.generator.putExpressionResult(rhs);
              this.generator.putBinaryOperation(op, er, rhs);
              this.generator.putSetMember(obj, member, er);
              break;
            case "variable":
              name = String(er.value);
              this.generator.putGetVariable(name);
              er.setTypeStack();
              rhs = new ExpressionResult();
              this.parse_assignmentExpression(rhs);
              this.generator.putExpressionResult(rhs);
              this.generator.putBinaryOperation(op, er, rhs);
              this.generator.putSetVariable(name, er);
              break;
            default:
              this.causeSyntaxError("L-value must be a variable or property");
          }
          er.setTypeStack();
          break;
      }
    }

    parse_conditionalExpression(er) {
      let thenSlot = null;
      let elseLabel = null;
      let endLabel = null;
      this.parse_logicalORExpression(er);
      if (this.isToken("?")) {
        this.generator.putExpressionResult(er);
        elseLabel = new Label();
        this.generator.putIf(er, elseLabel);
        this.nextToken();
        er.initialize();
        this.parse_assignmentExpression(er);
        if (er.isType("literal")) {
          this.generator.putLiteral(er);
        } else {
          this.generator.putExpressionResult(er);
        }
        thenSlot = this.generator.popStack();
        endLabel = new Label();
        this.generator.putJump(endLabel);
        this.generator.setLabel(elseLabel);
        if (!this.isToken(":")) {
          this.causeSyntaxError("':' not found in ?: statement");
        }
        this.nextToken();
        er.initialize();
        this.parse_assignmentExpression(er);
        if (er.isType("literal")) {
          this.generator.putLiteral(er);
        } else {
          this.generator.putExpressionResult(er);
        }
        er.setType("stack");
        this.generator.setStackPatch(thenSlot);
        this.generator.setLabel(endLabel);
      }
    }

    parse_logicalORExpression(er) {
      let slot = null;
      let falseLabel = null;
      this.parse_logicalANDExpression(er);
      while (this.isToken("||")) {
        this.nextToken();
        this.generator.putExpressionResult(er);
        this.generator.putDuplicate(er);
        slot = this.generator.popStack();
        er.setType("stack");
        falseLabel = new Label();
        this.generator.putNif(er, falseLabel);
        er.initialize();
        this.parse_logicalANDExpression(er);
        if (er.isType("literal")) {
          this.generator.putLiteral(er);
        } else {
          this.generator.putExpressionResult(er);
        }
        this.generator.setStackPatch(slot);
        er.setType("stack");
        this.generator.setLabel(falseLabel);
      }
    }

    parse_logicalANDExpression(er) {
      let slot = null;
      let falseLabel = null;
      this.parse_bitwiseORExpression(er);
      while (this.isToken("&&")) {
        this.nextToken();
        this.generator.putExpressionResult(er);
        this.generator.putDuplicate(er);
        slot = this.generator.popStack();
        er.setType("stack");
        falseLabel = new Label();
        this.generator.putIf(er, falseLabel);
        er.initialize();
        this.parse_bitwiseORExpression(er);
        if (er.isType("literal")) {
          this.generator.putLiteral(er);
        } else {
          this.generator.putExpressionResult(er);
        }
        this.generator.setStackPatch(slot);
        er.setType("stack");
        this.generator.setLabel(falseLabel);
      }
    }

    parse_bitwiseORExpression(er) {
      this.parse_bitwiseXORExpression(er);
      while (this.isToken("|")) {
        this.nextToken();
        this.generator.putExpressionResult(er);
        const rhs = new ExpressionResult();
        this.parse_bitwiseXORExpression(rhs);
        this.generator.putExpressionResult(rhs);
        if (this.areBothLiteral(er, rhs)) {
          er.setValue(er.value | rhs.value);
        } else {
          this.generator.putBinaryOperation("OR", er, rhs);
          er.setType("stack");
        }
      }
    }

    parse_bitwiseXORExpression(er) {
      this.parse_bitwiseANDExpression(er);
      while (this.isToken("^")) {
        this.nextToken();
        this.generator.putExpressionResult(er);
        const rhs = new ExpressionResult();
        this.parse_bitwiseANDExpression(rhs);
        this.generator.putExpressionResult(rhs);
        if (this.areBothLiteral(er, rhs)) {
          er.setValue(er.value ^ rhs.value);
        } else {
          this.generator.putBinaryOperation("XOR", er, rhs);
          er.setType("stack");
        }
      }
    }

    parse_bitwiseANDExpression(er) {
      this.parse_equalityExpression(er);
      while (this.isToken("&")) {
        this.nextToken();
        this.generator.putExpressionResult(er);
        const rhs = new ExpressionResult();
        this.parse_equalityExpression(rhs);
        this.generator.putExpressionResult(rhs);
        if (this.areBothLiteral(er, rhs)) {
          er.setValue(er.value & rhs.value);
        } else {
          this.generator.putBinaryOperation("AND", er, rhs);
          er.setType("stack");
        }
      }
    }

    parse_equalityExpression(er) {
      this.parse_relationalExpression(er);
      while (this.isToken("==") || this.isToken("!=") || this.isToken("===") || this.isToken("!==")) {
        const op = this.getToken().type;
        this.nextToken();
        this.generator.putExpressionResult(er);
        const rhs = new ExpressionResult();
        this.parse_relationalExpression(rhs);
        this.generator.putExpressionResult(rhs);
        if (!this.areBothLiteral(er, rhs)) {
          switch (op) {
            case "==": this.generator.putBinaryOperation("CEQ", er, rhs); break;
            case "!=": this.generator.putBinaryOperation("CNE", er, rhs); break;
            case "===": this.generator.putBinaryOperation("CSEQ", er, rhs); break;
            case "!==": this.generator.putBinaryOperation("CSNE", er, rhs); break;
          }
          er.setType("stack");
          continue;
        }
        switch (op) {
          case "==": er.setValue(er.value == rhs.value); break;
          case "!=": er.setValue(er.value != rhs.value); break;
          case "===": er.setValue(er.value === rhs.value); break;
          case "!==": er.setValue(er.value !== rhs.value); break;
        }
      }
    }

    parse_relationalExpression(er) {
      this.parse_shiftExpression(er);
      while (this.isToken("<") || this.isToken(">") || this.isToken("<=") || this.isToken(">=") || this.isToken("instanceof")) {
        const op = this.getToken().type;
        this.nextToken();
        this.generator.putExpressionResult(er);
        const rhs = new ExpressionResult();
        this.parse_shiftExpression(rhs);
        this.generator.putExpressionResult(rhs);
        if (!this.areBothLiteral(er, rhs)) {
          switch (op) {
            case "<": this.generator.putBinaryOperation("CLT", er, rhs); break;
            case ">": this.generator.putBinaryOperation("CGT", er, rhs); break;
            case "<=": this.generator.putBinaryOperation("CLE", er, rhs); break;
            case ">=": this.generator.putBinaryOperation("CGE", er, rhs); break;
            case "instanceof": this.generator.putBinaryOperation("INSOF", er, rhs); break;
          }
          er.setType("stack");
          continue;
        }
        switch (op) {
          case "<": er.setValue(er.value < rhs.value); break;
          case ">": er.setValue(er.value > rhs.value); break;
          case "<=": er.setValue(er.value <= rhs.value); break;
          case ">=": er.setValue(er.value >= rhs.value); break;
          case "instanceof": er.setValue(er.value instanceof rhs.value); break;
        }
      }
    }

    parse_shiftExpression(er) {
      this.parse_additiveExpression(er);
      while (this.isToken("<<") || this.isToken(">>") || this.isToken(">>>")) {
        const op = this.getToken().type;
        this.nextToken();
        this.generator.putExpressionResult(er);
        const rhs = new ExpressionResult();
        this.parse_additiveExpression(rhs);
        this.generator.putExpressionResult(rhs);
        if (!this.areBothLiteral(er, rhs)) {
          switch (op) {
            case "<<": this.generator.putBinaryOperation("LSH", er, rhs); break;
            case ">>": this.generator.putBinaryOperation("RSH", er, rhs); break;
            case ">>>": this.generator.putBinaryOperation("URSH", er, rhs); break;
          }
          er.setType("stack");
          continue;
        }
        switch (op) {
          case "<<": er.setValue(er.value << rhs.value); break;
          case ">>": er.setValue(er.value >> rhs.value); break;
          case ">>>": er.setValue(er.value >>> rhs.value); break;
        }
      }
    }

    parse_additiveExpression(er) {
      this.parse_multiplicativeExpression(er);
      while (this.isToken("+") || this.isToken("-")) {
        const op = this.getToken().type;
        this.nextToken();
        this.generator.putExpressionResult(er);
        const rhs = new ExpressionResult();
        this.parse_multiplicativeExpression(rhs);
        this.generator.putExpressionResult(rhs);
        if (!this.areBothLiteral(er, rhs)) {
          switch (op) {
            case "+": this.generator.putBinaryOperation("ADD", er, rhs); break;
            case "-": this.generator.putBinaryOperation("SUB", er, rhs); break;
          }
          er.setType("stack");
          continue;
        }
        switch (op) {
          case "+": er.setValue(er.value + rhs.value); break;
          case "-": er.setValue(er.value - rhs.value); break;
        }
      }
    }

    parse_multiplicativeExpression(er) {
      this.parse_unaryExpression(er);
      while (this.isToken("*") || this.isToken("/") || this.isToken("%")) {
        const op = this.getToken().type;
        this.nextToken();
        this.generator.putExpressionResult(er);
        const rhs = new ExpressionResult();
        this.parse_unaryExpression(rhs);
        this.generator.putExpressionResult(rhs);
        if (!this.areBothLiteral(er, rhs)) {
          switch (op) {
            case "*": this.generator.putBinaryOperation("MUL", er, rhs); break;
            case "/": this.generator.putBinaryOperation("DIV", er, rhs); break;
            case "%": this.generator.putBinaryOperation("MOD", er, rhs); break;
          }
          er.setType("stack");
          continue;
        }
        switch (op) {
          case "*": er.setValue(er.value * rhs.value); break;
          case "/": er.setValue(er.value / rhs.value); break;
          case "%": er.setValue(er.value % rhs.value); break;
        }
      }
    }

    parse_unaryExpression(er) {
      const t = this.getToken() ? this.getToken().type : null;
      switch (t) {
        case "delete":
          this.nextToken();
          this.parse_unaryExpression(er);
          switch (er.type) {
            case "member": {
              const obj = er.getObjectExpression();
              const member = er.getMemberExpression();
              this.generator.putExpressionResult(member);
              this.generator.putDeleteMember(obj, member);
              break;
            }
            case "variable":
              this.generator.putDelete(er);
              break;
            default:
              this.generator.putExpressionResult(er);
              this.generator.putDelete(er);
          }
          er.setTypeStack();
          break;
        case "void":
          this.nextToken();
          this.parse_unaryExpression(er);
          break;
        case "typeof":
          this.nextToken();
          this.parse_unaryExpression(er);
          this.generator.putExpressionResult(er);
          if (er.isType("literal")) {
            er.setValue(typeof er.value);
            break;
          }
          this.generator.putUnaryOperation("TYPEOF", er);
          er.setTypeStack();
          break;
        case "++":
          this.nextToken();
          this.parse_unaryExpression(er);
          this.generator.putIncrement(er);
          er.setTypeStack();
          break;
        case "--":
          this.nextToken();
          this.parse_unaryExpression(er);
          this.generator.putDecrement(er);
          er.setTypeStack();
          break;
        case "+":
          this.nextToken();
          this.parse_unaryExpression(er);
          break;
        case "-": {
          this.nextToken();
          this.parse_unaryExpression(er);
          this.generator.putExpressionResult(er);
          if (er.isType("literal")) {
            er.setValue(-er.value);
            break;
          }
          const zero = new ExpressionResult();
          zero.setTypeAndValue("literal", 0);
          this.generator.putBinaryOperation("SUB", zero, er);
          er.setType("stack");
          break;
        }
        case "~":
          this.nextToken();
          this.parse_unaryExpression(er);
          this.generator.putExpressionResult(er);
          if (er.isType("literal")) {
            er.setValue(~er.value);
            break;
          }
          this.generator.putUnaryOperation("NOT", er);
          er.setTypeStack();
          break;
        case "!":
          this.nextToken();
          this.parse_unaryExpression(er);
          this.generator.putExpressionResult(er);
          if (er.isType("literal")) {
            er.setValue(!er.value);
            break;
          }
          this.generator.putUnaryOperation("LNOT", er);
          er.setTypeStack();
          break;
        default:
          this.parse_postfixExpression(er);
      }
    }

    isUnaryExpressionFirst(type) {
      return type == "delete" || type == "void" || type == "typeof" || type == "++" || type == "--" || type == "+" || type == "-" || type == "~" || type == "!" || this.isMemberExpressionFirst(type);
    }

    parse_postfixExpression(er) {
      this.parse_leftHandSideExpression(er);
      if (this.isToken("++") || this.isToken("--")) {
        switch (this.getToken().type) {
          case "++":
            this.generator.putPostfixIncrement(er);
            break;
          case "--":
            this.generator.putPostfixDecrement(er);
            break;
        }
        er.setTypeStack();
        this.nextToken();
      }
    }

    parse_leftHandSideExpression(er) {
      this.parse_callExpression(er);
    }

    parse_callExpression(er) {
      this.parse_memberExpression(er);
      while (this.isToken("(")) {
        const argc = this.parse_arguments();
        switch (er.type) {
          case "member": {
            const obj = er.getObjectExpression();
            const member = er.getMemberExpression();
            this.generator.putExpressionResult(member);
            this.generator.putCallMember(obj, member, argc);
            break;
          }
          case "stack":
            this.generator.putCallFunctor(argc);
            break;
          default:
            this.generator.putCall(er, argc);
        }
        er.setType("stack");
      }
    }

    parse_memberExpression(er) {
      switch (this.getToken() ? this.getToken().type : null) {
        case "function":
          if (this.parseForceCoroutine == false) {
            this.parse_functionExpression(er);
            break;
          }
          this.token.type = "coroutine";
          this.parse_coroutineExpression(er);
          break;
        case "coroutine":
          this.parse_coroutineExpression(er);
          break;
        case "new": {
          this.nextToken();
          this.parse_memberExpression(er);
          this.generator.putExpressionResult(er);
          let argc = 0;
          if (this.isToken("(")) {
            argc += this.parse_arguments();
          }
          this.generator.putNew(argc);
          er.setType("stack");
          break;
        }
        default:
          this.parse_primaryExpression(er);
      }
      for (;;) {
        if (this.isToken("[")) {
          this.nextToken();
          this.generator.putExpressionResult(er);
          const index = new ExpressionResult();
          this.parse_expression(index);
          er.setTypeMember(er.clone(), index);
          if (!this.isToken("]")) {
            this.causeSyntaxError("']' not found in array access");
          }
          this.nextToken();
        } else {
          if (!this.isToken(".")) break;
          this.generator.putExpressionResult(er);
          if (!this.isNextToken("identifier")) {
            this.causeSyntaxError("'.' not found in property access");
          }
          er.setTypeMember(er.clone(), ExpressionResult.createLiteral(this.getToken().value));
          this.nextToken();
        }
      }
    }

    isMemberExpressionFirst(type) {
      return type == "new" || type == "function" || this.isPrimaryExpressionFirst(type);
    }

    parse_arguments() {
      if (!this.isToken("(")) {
        this.causeSyntaxError("'(' not found in argument list");
      }
      let count = 0;
      if (!this.isNextToken(")")) {
        count += this.parse_argumentList();
      }
      if (!this.isToken(")")) {
        this.causeSyntaxError("')' not found in argument list");
      }
      this.nextToken();
      return count;
    }

    parse_argumentList() {
      let count = 0;
      for (;;) {
        const er = new ExpressionResult();
        this.parse_assignmentExpression(er);
        this.generator.putExpressionResult(er);
        this.generator.putPush(er);
        count++;
        if (!this.isToken(",")) break;
        this.nextToken();
      }
      return count;
    }

    parse_primaryExpression(er) {
      switch (this.getToken() ? this.getToken().type : null) {
        case "this":
          this.generator.putThis();
          er.setType("stack");
          this.nextToken();
          break;
        case "identifier":
          er.setTypeAndValue("variable", this.getToken().value);
          this.nextToken();
          break;
        case "string":
        case "number":
        case "bool":
        case "null":
        case "undefined":
          er.setTypeAndValue("literal", this.getToken().value);
          this.nextToken();
          break;
        case "[": {
          const count = this.parse_arrayLiteral();
          this.generator.putArrayLiteral(count);
          er.setType("stack");
          break;
        }
        case "{": {
          const count = this.parse_objectLiteral();
          this.generator.putObjectLiteral(count);
          er.setType("stack");
          break;
        }
        case "(":
          this.nextToken();
          this.parse_expression(er);
          if (!this.isToken(")")) {
            this.causeSyntaxError("matching ')' not found in expression");
          }
          this.nextToken();
          break;
        default:
          this.causeSyntaxError("unexpected token");
      }
    }

    isPrimaryExpressionFirst(type) {
      return type == "this" || type == "identifier" || type == "string" || type == "number" || type == "bool" || type == "undefined" || type == "null" || type == "{" || type == "[" || type == "(";
    }

    parse_arrayLiteral() {
      if (!this.isToken("[")) {
        this.causeSyntaxError("'[' not found in array initializer");
      }
      let count = 0;
      if (!this.isNextToken("]")) {
        if (this.isToken(",")) {
          count += this.parse_elision();
        }
        if (!this.isToken("]")) {
          count += this.parse_elementList();
        }
        if (this.isToken(",")) {
          count += this.parse_elision();
        }
      }
      if (!this.isToken("]")) {
        this.causeSyntaxError("']' not found in array initializer");
      }
      this.nextToken();
      return count;
    }

    parse_elision() {
      if (!this.isToken(",")) {
        this.causeSyntaxError("',' not found in elision");
      }
      let count = 1;
      const undef = ExpressionResult.createLiteral(undefined);
      do {
        this.generator.putPush(undef);
        count++;
      } while (this.isNextToken(","));
      if (this.isToken("]")) {
        this.generator.putPush(undef);
        count++;
      }
      return count;
    }

    parse_elementList() {
      let count = 0;
      for (;;) {
        if (this.isToken(",")) {
          count += this.parse_elision();
        } else {
          if (this.isToken("]")) break;
          const er = new ExpressionResult();
          this.parse_assignmentExpression(er);
          this.generator.putExpressionResult(er);
          this.generator.putPush(er);
          count++;
          if (!this.isToken(",")) break;
          this.nextToken();
        }
      }
      return count;
    }

    parse_objectLiteral() {
      if (!this.isToken("{")) {
        this.causeSyntaxError("'{' not found in object initializer");
      }
      let count = 0;
      if (!this.isNextToken("}")) {
        count += this.parse_propertyNameAndValueList();
      }
      if (!this.isToken("}")) {
        this.causeSyntaxError("'}' not found in object initializer");
      }
      this.nextToken();
      return count;
    }

    parse_propertyNameAndValueList() {
      let count = 0;
      for (;;) {
        this.parse_propertyName();
        if (!this.isToken(":")) {
          this.causeSyntaxError("':' not found in object name-value initializer");
        }
        this.nextToken();
        const val = new ExpressionResult();
        this.parse_assignmentExpression(val);
        this.generator.putExpressionResult(val);
        this.generator.putPush(val);
        count++;
        if (!this.isToken(",")) break;
        this.nextToken();
      }
      return count;
    }

    parse_propertyName() {
      const t = this.getToken() ? this.getToken().type : null;
      switch (t) {
        case "identifier":
        case "string":
        case "number": {
          const er = ExpressionResult.createLiteral(this.getToken().value);
          this.generator.putPush(er);
          this.nextToken();
          break;
        }
        default:
          this.causeSyntaxError("unexpected token in property name");
      }
    }
  }
  M8.Parser = Parser;
})(typeof window !== 'undefined' ? window : globalThis);
