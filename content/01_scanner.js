/* M8 lexer - line-by-line port of swf_source/scripts/scripting/Scanner.as */
(function (global) {
  "use strict";
  const M8 = global.M8RE;

  class VMSyntaxError extends Error {
    constructor(msg) {
      super(msg);
      this.name = 'VMSyntaxError';
    }
  }
  M8.VMSyntaxError = VMSyntaxError;

  class Token {
    constructor(type, value) {
      this.type = type;
      this.value = value;
    }
  }
  M8.Token = Token;

  class Scanner {
    constructor(source) {
      this.source = String(source);
      this.rewind();
    }

    rewind() {
      this.index = 0;
      this.linesCount = 0;
    }

    getLineNumber() {
      return this.linesCount + 1;
    }

    getLine() {
      return this.source.split("\n")[this.linesCount];
    }

    getChar() {
      return this.source.charAt(this.index);
    }

    nextChar() {
      if (this.getChar() == "\n") {
        ++this.linesCount;
      }
      return this.source.charAt(++this.index);
    }

    isSpace(c) {
      return c == " " || c == "\t" || c == "\r" || c == "\n";
    }

    isAlphabet(c) {
      const n = c.charCodeAt(0);
      return (65 <= n && n <= 90) || (97 <= n && n <= 122);
    }

    isNumber(c) {
      const n = c.charCodeAt(0);
      return 48 <= n && n <= 57;
    }

    isAlphabetOrNumber(c) {
      const n = c.charCodeAt(0);
      return (48 <= n && n <= 57) || (65 <= n && n <= 90) || (97 <= n && n <= 122);
    }

    isHex(c) {
      const n = c.charCodeAt(0);
      return (48 <= n && n <= 57) || (65 <= n && n <= 70) || (97 <= n && n <= 102);
    }

    isIdentifier(c) {
      const n = c.charCodeAt(0);
      return n == 36 || n == 95 || (48 <= n && n <= 57) || (65 <= n && n <= 90) || (97 <= n && n <= 122);
    }

    getToken() {
      let c = this.getChar();
      while (this.isSpace(c)) {
        c = this.nextChar();
      }
      if (!c) {
        return null;
      }
      if (this.isAlphabet(c) || c == "$" || c == "_") {
        let s = c;
        for (;;) {
          c = this.nextChar();
          if (! (!!c && this.isIdentifier(c))) break;
          s += c;
        }
        const k = s.toLowerCase();
        switch (k) {
          case "break":
          case "case":
          case "continue":
          case "default":
          case "delete":
          case "do":
          case "else":
          case "for":
          case "function":
          case "if":
          case "instanceof":
          case "new":
          case "return":
          case "switch":
          case "this":
          case "typeof":
          case "var":
          case "while":
          case "with":
          case "coroutine":
          case "suspend":
          case "yield":
          case "loop":
            return new Token(k, null);
          case "null":
            return new Token("null", null);
          case "undefined":
            return new Token("undefined", undefined);
          case "true":
            return new Token("bool", true);
          case "false":
            return new Token("bool", false);
          default:
            return new Token("identifier", s);
        }
      } else {
        if (this.isNumber(c)) {
          let s = c;
          if (c == "0") {
            c = this.nextChar();
            if (!!c && (!!((c == "x") || c == "X"))) {
              s += c;
              for (;;) {
                c = this.nextChar();
                if (! (!!c && this.isHex(c))) break;
                s += c;
              }
            } else if (this.isNumber(c)) {
              s += c;
              for (;;) {
                c = this.nextChar();
                if (! (!!c && this.isNumber(c))) break;
                s += c;
              }
            }
          } else {
            for (;;) {
              c = this.nextChar();
              if (! (!!c && this.isNumber(c))) break;
              s += c;
            }
          }
          if (c == ".") {
            s += c;
            for (;;) {
              c = this.nextChar();
              if (! (!!c && this.isNumber(c))) break;
              s += c;
            }
            return new Token("number", parseFloat(s));
          }
          // AS3 parseInt("0x..") auto-detects hex; JS parseInt matches without radix
          return new Token("number", parseInt(s));
        }
        if (c == "'") {
          return this._stringToken("'");
        }
        if (c == "\"") {
          return this._stringToken("\"");
        }
        if (c == "/") {
          c = this.nextChar();
          if (c) {
            if (c == "=") {
              this.nextChar();
              return new Token("/=", null);
            }
            if (c == "/") {
              for (;;) {
                c = this.nextChar();
                if (! (!!c && c != "\n")) break;
              }
              this.nextChar();
              return this.getToken();
            }
            if (c == "*") {
              c = this.nextChar();
              while (c) {
                if (c == "*") {
                  c = this.nextChar();
                  if (!!c && c == "/") {
                    break;
                  }
                } else {
                  c = this.nextChar();
                }
              }
              this.nextChar();
              return this.getToken();
            }
          }
          return new Token("/", null);
        }
        if (c == "*" || c == "%" || c == "^") {
          const k = c;
          c = this.nextChar();
          if (!!c && c == "=") {
            this.nextChar();
            return new Token(k + "=", null);
          }
          return new Token(k, null);
        }
        if (c == "+" || c == "-" || c == "|" || c == "&") {
          const k = c;
          c = this.nextChar();
          if (c) {
            if (c == k) {
              this.nextChar();
              return new Token(k + k, null);
            }
            if (c == "=") {
              this.nextChar();
              return new Token(k + "=", null);
            }
          }
          return new Token(k, null);
        }
        if (c == "=" || c == "!") {
          const k = c;
          c = this.nextChar();
          if (!!c && c == "=") {
            c = this.nextChar();
            if (!!c && c == "=") {
              this.nextChar();
              return new Token(k + "==", null);
            }
            return new Token(k + "=", null);
          }
          return new Token(k, null);
        }
        if (c == ">" || c == "<") {
          const k = c;
          c = this.nextChar();
          if (c) {
            if (c == "=") {
              this.nextChar();
              return new Token(k + "=", null);
            }
            if (c == k) {
              c = this.nextChar();
              if (c) {
                if (k == ">" && c == ">") {
                  c = this.nextChar();
                  if (!!c && c == "=") {
                    this.nextChar();
                    return new Token(">>>=", null);
                  }
                  return new Token(">>>", null);
                }
                if (c == "=") {
                  this.nextChar();
                  return new Token(k + k + "=", null);
                }
              }
              return new Token(k + k, null);
            }
          }
          return new Token(k, null);
        }
        switch (c) {
          case "{":
          case "}":
          case "(":
          case ")":
          case "[":
          case "]":
          case ".":
          case ";":
          case ",":
          case "~":
          case "?":
          case ":":
            this.nextChar();
            return new Token(c, null);
          default:
            throw new VMSyntaxError("Unknown character : \"" + c + "\" at index " + this.index + ".");
        }
      }
    }

    // AS3 string scanners ('...' and "...") are identical; shared impl
    _stringToken(quote) {
      let s = "";
      let c;
      for (;;) {
        c = this.nextChar();
        if (! (!!c && c != quote)) break;
        if (c == "\\") {
          c = this.nextChar();
          if (c == "n") { s += "\n"; continue; }
          if (c == "t") { s += "\t"; continue; }
          if (c == "r") { s += "\r"; continue; }
          if (c == "x") {
            const c1 = this.nextChar();
            const c2 = this.nextChar();
            s += String.fromCharCode(parseInt("0x" + c1 + c2, 16));
            continue;
          }
          if (c == "0") {
            const c1 = this.nextChar();
            const c2 = this.nextChar();
            s += String.fromCharCode(parseInt(c1 + c2, 8));
            continue;
          }
          if (c == "\\") {
            s += "\\";
            continue;
          }
        }
        s += c;
      }
      if (c != quote) {
        throw new VMSyntaxError("String literal is not closed.");
      }
      this.nextChar();
      return new Token("string", s);
    }
  }
  M8.Scanner = Scanner;
})(typeof window !== 'undefined' ? window : globalThis);
