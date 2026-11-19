/**
 * `.ino` → `.cpp`, byte-identical to PlatformIO's `InoToCPPConverter`
 * (platformio/builder/tools/pioino.py, PlatformIO Core 6.x):
 *
 * 1. merge: `#include <Arduino.h>`, then every `.ino`/`.pde` of `src/` (sorted by name, `.ino`
 *    before `.pde`) behind a `# 1 "<path>"` linemarker; the file that defines `setup`/`loop`
 *    goes first.
 * 2. `$CXX -o <out> -x c++ -fpreprocessed -dD -E <tmpfile>` — comments out, `#define`s kept.
 *    `preprocessFpreprocessed` below emulates this gcc pass (identical for avr-gcc 7.3 and
 *    the Espressif gcc 8.4 toolchains); a caller with a real cc1plus can pass `preprocess`.
 * 3. join multi-line strings, then insert the prototypes + a `#line` directive.
 *
 * Diagnostics land in the `.ino` files through the linemarkers/`#line` directives, so gcc's
 * messages name `<srcDir>/<sketch>.ino:<line>:<col>` with the sketch's own line numbers, exactly
 * as in a native PlatformIO build of a project at `<srcDir>/..`.
 */
import type { SourceFile } from "./types";


export interface InoToCppOptions {
    /** Absolute directory the sketch paths are written under (default `/project/src`); PlatformIO uses `<project>/src`. */
    srcDir?: string;
    /**
     * Name of the temporary file gcc preprocesses; it appears in line 1 of the output
     * (PlatformIO: a random `mkstemp()` path). Default `/tmp/tmpino`.
     */
    tmpPath?: string;
    /**
     * Replaces the built-in emulation of `gcc -x c++ -fpreprocessed -dD -E` (e.g. with
     * cc1plus.wasm). Gets the merged text and the temp-file name gcc would see.
     */
    preprocess?: (contents: string, tmpPath: string) => string;
}

export interface InoToCppResult {
    /** The generated C++ source. */
    cpp: string;
    /** Where PlatformIO writes it: `<main ino path without ";'\"">.cpp`, e.g. `/project/src/sketch.ino.cpp`. */
    path: string;
    /** Absolute path of the main `.ino` (the one with setup/loop, else the first). */
    mainIno: string;
    /** The `.ino`/`.pde` files that went in, in merge order (absolute paths). */
    inputs: string[];
}

/** gcc would reject the input, or it uses a construct the emulation does not cover. */
export class PreprocessUnsupportedError extends Error {
    constructor(
        message: string,
        readonly line?: number,
    ) {
        super(message);
        this.name = "PreprocessUnsupportedError";
    }
}

// ---------------------------------------------------------------------------
// Python semantics helpers
// ---------------------------------------------------------------------------

/** Characters for which Python's `str.isspace()` is true (= `\s` in a `re` str pattern). */
const PY_WS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_WS_RE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "gu");

/** Python's `str.strip()`. */
export function pyStrip(s: string): string {
    return s.replace(PY_WS_RE, "");
}

/** Python's `io.open(..., "r")` universal newlines. */
function universalNewlines(s: string): string {
    return s.replace(/\r\n?/g, "\n");
}

/** Code point order (Python's `sorted` on str). */
function cmpCodePoints(a: string, b: string): number {
    const ia = a[Symbol.iterator]();
    const ib = b[Symbol.iterator]();
    for (;;) {
        const x = ia.next();
        const y = ib.next();
        if (x.done) return y.done ? 0 : -1;
        if (y.done) return 1;
        const d = x.value.codePointAt(0)! - y.value.codePointAt(0)!;
        if (d !== 0) return d;
    }
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// The converter
// ---------------------------------------------------------------------------

const D = "\\p{Nd}";
const WS = `[${PY_WS}]`;
/** PROTOTYPE_RE (re.X | re.M | re.I); `^` with re.M = after "\n" only; `.` = anything but "\n". */
const PROTOTYPE_RE = new RegExp(
    `(?<![^\\n])(` +
        `(?:template<[^\\n]*>${WS}*)?` + // template
        `([a-z_${D}&]+\\*?${WS}+){1,2}` + // return type
        `([a-z_${D}]+${WS}*)` + // name of prototype
        `\\([a-z_,.*&\\[\\]${PY_WS}${D}]*\\)` + // arguments
        `)${WS}*(\\{|;)`,
    "giu",
);
const DETECTMAIN_RE = new RegExp(`void${WS}+(setup|loop)${WS}*\\(`, "iu");
const RESERVED = new Set(["if", "else", "while"]);

/** `_parse_preproc_line_num`: the number of a `# N ...`/`#line N ...` line. */
function parsePreprocLineNum(line: string): number | null {
    if (!line.startsWith("#")) return null;
    // Python: line.split(" ", 3)
    const tokens = line.split(" ");
    if (tokens.length > 2 && /^[0-9]+$/.test(tokens[1]!)) return parseInt(tokens[1]!, 10);
    return null;
}

function joinMultilineStrings(contents: string, mainIno: string): string {
    if (!contents.includes("\\\n")) return contents;
    const newlines: string[] = [];
    let linenum = 0;
    let stropen = false;
    for (const line of contents.split("\n")) {
        const n = parsePreprocLineNum(line);
        if (n !== null) linenum = n;
        else linenum += 1;

        if (line.endsWith("\\")) {
            if (line.startsWith('"')) {
                stropen = true;
                newlines.push(line.slice(0, -1));
                continue;
            }
            if (stropen) {
                newlines[newlines.length - 1] += line.slice(0, -1);
                continue;
            }
        } else if (stropen && (line.endsWith('",') || line.endsWith('";'))) {
            newlines[newlines.length - 1] += line;
            stropen = false;
            newlines.push(`#line ${linenum} "${mainIno.replace(/\\/g, "/")}"`);
            continue;
        }
        newlines.push(line);
    }
    return newlines.join("\n");
}

function getTotalLines(contents: string): number {
    let total = 0;
    if (contents.endsWith("\n")) contents = contents.slice(0, -1);
    const lines = contents.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
        const n = parsePreprocLineNum(lines[i]!);
        if (n !== null) return total + n;
        total += 1;
    }
    return total;
}

function appendPrototypes(contents: string, mainIno: string): string {
    let prototypes: RegExpExecArray[] = [];
    PROTOTYPE_RE.lastIndex = 0;
    for (const m of contents.matchAll(PROTOTYPE_RE)) {
        if (RESERVED.has(pyStrip(m[2]!)) || RESERVED.has(pyStrip(m[3]!))) continue;
        prototypes.push(m as RegExpExecArray);
    }
    // skip already declared prototypes
    const declared = new Set(prototypes.filter((m) => m[4] === ";").map((m) => pyStrip(m[1]!)));
    prototypes = prototypes.filter((m) => !declared.has(pyStrip(m[1]!)));
    if (prototypes.length === 0) return contents;

    const names = [...new Set(prototypes.map((m) => pyStrip(m[3]!)))];
    let splitPos = prototypes[0]!.index;
    const ptrs = new RegExp(`\\([^&(]*&(${names.map(escapeRegExp).join("|")})[^)]*\\)`, "u").exec(contents.slice(0, splitPos));
    if (ptrs) splitPos = contents.lastIndexOf("\n", ptrs.index - 1) + 1;

    return [
        pyStrip(contents.slice(0, splitPos)),
        `${prototypes.map((m) => m[1]!).join(";\n")};`,
        `#line ${getTotalLines(contents.slice(0, splitPos))} "${mainIno.replace(/\\/g, "/")}"`,
        pyStrip(contents.slice(splitPos)),
    ].join("\n");
}

/**
 * The converter. `files` may hold the whole project (`.cpp`/`.h` are ignored); only `.ino`/`.pde`
 * directly in `src/` take part, as PlatformIO's `FindInoNodes` globs `$PROJECT_SRC_DIR/*.ino`.
 * Returns null when there is no `.ino`/`.pde`.
 */
export function inoToCpp(files: SourceFile[], opts: InoToCppOptions = {}): InoToCppResult | null {
    const srcDir = (opts.srcDir ?? "/project/src").replace(/\/+$/, "");
    const tmpPath = opts.tmpPath ?? "/tmp/tmpino";
    const top = files
        .map((f) => ({ name: f.path.replace(/^\.\//, "").replace(/^src\//, ""), content: f.content }))
        .filter((f) => !f.name.includes("/"));
    const pick = (ext: string) => top.filter((f) => f.name.endsWith(ext)).sort((a, b) => cmpCodePoints(a.name, b.name));
    const nodes = [...pick(".ino"), ...pick(".pde")];
    if (nodes.length === 0) return null;

    // merge()
    let lines: string[] = [];
    let mainIno: string | null = null;
    for (const node of nodes) {
        const path = `${srcDir}/${node.name}`;
        const contents = universalNewlines(node.content);
        const own = [`# 1 "${path.replace(/\\/g, "/")}"`, contents];
        if (DETECTMAIN_RE.test(contents)) {
            lines = [...own, ...lines];
            mainIno = path;
        } else lines.push(...own);
    }
    mainIno ??= `${srcDir}/${nodes[0]!.name}`;
    const merged = ["#include <Arduino.h>", ...lines].join("\n");

    // process()
    const out = mainIno.replace(/["';]+/g, "") + ".cpp";
    let contents = (opts.preprocess ?? preprocessFpreprocessed)(merged, tmpPath);
    contents = universalNewlines(contents);
    contents = joinMultilineStrings(contents, mainIno);
    return {
        cpp: appendPrototypes(contents, mainIno),
        path: out,
        mainIno,
        inputs: nodes.map((n) => `${srcDir}/${n.name}`),
    };
}

// ---------------------------------------------------------------------------
// gcc -x c++ -fpreprocessed -dD -E
// ---------------------------------------------------------------------------

interface Tok {
    text: string;
    /** Logical line (after linemarkers). */
    line: number;
    file: string;
    /** 1-based byte column (libcpp counts bytes; a tab is one column). */
    col: number;
    prevWhite: boolean;
    bol: boolean;
    kind: "ident" | "number" | "string" | "punct" | "other";
}

const DIRECTIVES = new Set([
    "define",
    "include",
    "endif",
    "ifdef",
    "if",
    "else",
    "ifndef",
    "undef",
    "line",
    "elif",
    "error",
    "pragma",
    "warning",
    "include_next",
    "ident",
    "import",
    "assert",
    "unassert",
    "sccs",
]);
/** Directives libcpp still runs with -fpreprocessed (flag IN_I), when the `#` is in column 1. */
const IN_I = new Set(["define", "undef", "pragma", "ident", "sccs"]);
/** Pragmas libcpp/the C++ front end handle themselves even with -E: their output is not a plain echo. */
const SPECIAL_PRAGMAS = new Set(["once", "push_macro", "pop_macro", "message", "redefine_extname", "GCC poison", "GCC system_header", "GCC dependency", "GCC warning", "GCC error", "GCC pch_preprocess"]);
const STRING_PREFIXES = new Set(["L", "u", "U", "u8"]);
const RAW_PREFIXES = new Set(["R", "LR", "uR", "UR", "u8R"]);

const isIdStart = (c: string) => /[A-Za-z_$]/.test(c);
const isIdChar = (c: string) => /[A-Za-z0-9_$]/.test(c);
const isIdNum = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_]/.test(c);
const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const HSPACE = new Set([" ", "\t", "\f", "\v", "\0"]);

function utf8Length(s: string): number {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x80) n += 1;
        else if (c < 0x800) n += 2;
        else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
            n += 4;
            i++;
        } else n += 3;
    }
    return n;
}

/** cpp_quote_string */
function quote(s: string): string {
    return s.replace(/[\\"]/g, "\\$&").replace(/\n/g, "\\n");
}

/** The file name in a linemarker (cpp_interpret_string_notranslate, enough for paths). */
function unquote(lit: string): string {
    const body = lit.slice(1, -1);
    return body.replace(/\\([0-7]{1,3}|x[0-9a-fA-F]+|.)/g, (_, e: string) => {
        if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
        if (e[0] === "x") return String.fromCharCode(parseInt(e.slice(1), 16));
        const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v", e: "\x1b" };
        return map[e] ?? e;
    });
}

/**
 * Emulates `gcc -x c++ -fpreprocessed -dD -E <tmpPath>` (libcpp + c-ppoutput.c of gcc 7/8):
 * no macro expansion, no includes; comments become whitespace, whitespace runs between tokens
 * become one space, the first token of a line keeps its column (in spaces), blank lines are
 * kept up to 7 in a row (more become a `# N "file"` linemarker), `#define`/`#undef` are echoed
 * normalized, other directives pass through as tokens. Throws `PreprocessUnsupportedError` for
 * input gcc rejects or that it treats specially (some pragmas, linemarker flags).
 */
export function preprocessFpreprocessed(input: string, tmpPath = "/tmp/tmpino"): string {
    const text = input.replace(/\r\n?/g, "\n");
    const n = text.length;
    let pos = 0;
    let physLine = 1;
    let lineStart = 0;
    let file = tmpPath;
    let delta = 0;

    // c-ppoutput.c `print` state
    const out: string[] = [];
    let printed = false;
    let srcLine = 1;
    let srcFile = "";

    const printLine = (line: number, f: string, flags = "") => {
        if (printed) out.push("\n");
        printed = false;
        srcLine = line;
        srcFile = f;
        out.push(`# ${line === 0 ? 1 : line} "${quote(f)}"${flags}\n`);
    };
    const maybePrintLine = (line: number, f: string) => {
        if (printed) {
            out.push("\n");
            srcLine++;
            printed = false;
        }
        if (line >= srcLine && line < srcLine + 8 && f === srcFile) {
            while (line > srcLine) {
                out.push("\n");
                srcLine++;
            }
        } else printLine(line, f);
    };

    // ---- lexer
    let bol = true;
    let prevWhite = false;

    const newline = () => {
        pos++;
        physLine++;
        lineStart = pos;
    };
    /** Skips horizontal whitespace and comments; stops at "\n" or a token. Returns whether any was skipped. */
    const skipWhite = (): boolean => {
        let skipped = false;
        while (pos < n) {
            const c = text[pos]!;
            if (HSPACE.has(c)) {
                pos++;
                skipped = true;
            } else if (c === "/" && text[pos + 1] === "*") {
                pos += 2;
                for (;;) {
                    if (pos >= n) throw new PreprocessUnsupportedError("unterminated comment", physLine + delta);
                    if (text[pos] === "*" && text[pos + 1] === "/") {
                        pos += 2;
                        break;
                    }
                    if (text[pos] === "\n") newline();
                    else pos++;
                }
                skipped = true;
            } else if (c === "/" && text[pos + 1] === "/") {
                while (pos < n && text[pos] !== "\n") pos++;
                skipped = true;
            } else break;
        }
        return skipped;
    };

    /** Lexes one token at `pos` (not whitespace, not "\n"). */
    const lexToken = (): Tok => {
        const start = pos;
        const line = physLine + delta;
        const col = utf8Length(text.slice(lineStart, start)) + 1;
        const tokFile = file;
        const c = text[pos]!;
        let kind: Tok["kind"] = "punct";

        const lexQuoted = (q: string) => {
            pos++;
            for (;;) {
                const ch = text[pos];
                if (ch === undefined || ch === "\n") break; // unterminated: CPP_OTHER up to the end of the line
                pos++;
                if (ch === "\\" && text[pos] !== "\n" && pos < n) pos++;
                else if (ch === q) break;
            }
        };
        const lexRaw = () => {
            // at the opening quote
            pos++;
            const open = text.indexOf("(", pos);
            const delim = open < 0 ? "" : text.slice(pos, open);
            if (open < 0 || delim.length > 16 || /[\s()\\]/.test(delim)) throw new PreprocessUnsupportedError("invalid raw string delimiter", line);
            pos = open + 1;
            const close = `)${delim}"`;
            for (;;) {
                if (pos >= n) throw new PreprocessUnsupportedError("unterminated raw string", line);
                if (text.startsWith(close, pos)) {
                    pos += close.length;
                    break;
                }
                if (text[pos] === "\n") newline();
                else pos++;
            }
        };

        if (isIdStart(c)) {
            kind = "ident";
            while (pos < n && isIdChar(text[pos]!)) pos++;
            const word = text.slice(start, pos);
            if (text[pos] === '"' && RAW_PREFIXES.has(word)) {
                lexRaw();
                kind = "string";
            } else if ((text[pos] === '"' || text[pos] === "'") && STRING_PREFIXES.has(word)) {
                lexQuoted(text[pos]!);
                kind = "string";
            }
        } else if (isDigit(c) || (c === "." && isDigit(text[pos + 1]))) {
            kind = "number";
            pos++;
            while (pos < n) {
                const ch = text[pos]!;
                const prev = text[pos - 1]!;
                if (isIdNum(ch) || ch === "." || ch === "'" || ((ch === "+" || ch === "-") && /[eEpP]/.test(prev))) pos++;
                else break;
            }
            while (pos > start + 1 && text[pos - 1] === "'") pos--; // a number can't end with a digit separator
        } else if (c === '"' || c === "'") {
            kind = "string";
            lexQuoted(c);
        } else {
            kind = c.charCodeAt(0) >= 0x80 ? "other" : "punct";
            pos += c.length;
            if (c === "%" && text[pos] === ":") pos++; // digraph for '#'
            else if (c === "#" && text[pos] === "#") pos++;
            else if (c === "." && text[pos] === "." && text[pos + 1] === ".") pos += 2;
        }
        return { text: text.slice(start, pos), line, file: tokFile, col, prevWhite, bol, kind };
    };

    /** Tokens up to the end of the directive line (comments may span lines). */
    const restOfLine = (): Tok[] => {
        const toks: Tok[] = [];
        for (;;) {
            prevWhite = skipWhite();
            if (pos >= n || text[pos] === "\n") break;
            bol = false;
            toks.push(lexToken());
        }
        return toks;
    };

    const emitToken = (t: Tok) => {
        if (t.bol || (t.prevWhite && t.line !== srcLine)) {
            // cb_line_change / do_line_change
            maybePrintLine(t.line, t.file);
            printed = true;
            out.push(" ".repeat(Math.max(0, t.col - 2)));
            if (t.prevWhite) out.push(" ");
        } else if (t.prevWhite) out.push(" ");
        out.push(t.text);
        printed = true;
        // A raw string can span lines; gcc counts them (print.src_line), so no blank lines follow.
        if (t.kind === "string") for (const ch of t.text) if (ch === "\n") srcLine++;
    };

    const handleDefine = (hash: Tok, toks: Tok[]) => {
        const name = toks[0];
        if (!name || name.kind !== "ident" || name.text === "defined") throw new PreprocessUnsupportedError("invalid macro name", hash.line);
        let i = 1;
        let def = name.text;
        const params: string[] = [];
        let funLike = false;
        if (toks[1] && toks[1].text === "(" && !toks[1].prevWhite) {
            funLike = true;
            i = 2;
            const parts: string[] = [];
            for (;;) {
                const t = toks[i++];
                if (!t) throw new PreprocessUnsupportedError("missing ')' in macro parameter list", hash.line);
                if (t.text === ")" && parts.length === 0 && params.length === 0) break;
                if (t.text === "...") {
                    parts.push("...");
                    params.push("__VA_ARGS__");
                    if (toks[i++]?.text !== ")") throw new PreprocessUnsupportedError("missing ')' in macro parameter list", hash.line);
                    break;
                }
                if (t.kind !== "ident") throw new PreprocessUnsupportedError("expected parameter name", hash.line);
                params.push(t.text);
                const next = toks[i++];
                if (next?.text === "...") {
                    parts.push(t.text + "...");
                    if (toks[i++]?.text !== ")") throw new PreprocessUnsupportedError("missing ')' in macro parameter list", hash.line);
                    break;
                }
                parts.push(t.text);
                if (next?.text === ")") break;
                if (next?.text !== ",") throw new PreprocessUnsupportedError("expected comma in macro parameter list", hash.line);
            }
            def += `(${parts.join(",")})`;
        }
        def += " ";
        const body = toks.slice(i);
        let first = true;
        for (let k = 0; k < body.length; k++) {
            const t = body[k]!;
            if (t.text === "%:" || t.text === "%:%:") throw new PreprocessUnsupportedError("digraph in #define", hash.line);
            if (t.text === "##") {
                if (first || k === body.length - 1) throw new PreprocessUnsupportedError("'##' cannot appear at either end of a macro expansion", hash.line);
                def += " ##";
                continue;
            }
            if (funLike && t.text === "#") {
                const p = body[k + 1];
                if (!p || !params.includes(p.text)) throw new PreprocessUnsupportedError("'#' is not followed by a macro parameter", hash.line);
                if (!first && t.prevWhite) def += " ";
                def += "#" + p.text;
                k++;
                first = false;
                continue;
            }
            if (!first && t.prevWhite) def += " ";
            def += t.text;
            first = false;
        }
        maybePrintLine(hash.line, hash.file);
        out.push(`#define ${def}\n`);
        printed = false;
        srcLine++;
    };

    const handleDirective = (hash: Tok): boolean => {
        const save = { pos, physLine, lineStart };
        const toks = restOfLine();
        const dname = toks[0];
        if (!dname) return true; // null directive: consumed
        const indented = hash.prevWhite;
        const backup = () => {
            pos = save.pos;
            physLine = save.physLine;
            lineStart = save.lineStart;
            bol = false;
            prevWhite = false;
            return false;
        };
        if (dname.kind === "number") {
            if (indented) return backup();
            // linemarker: # N ["file" [flags]]
            if (!/^[0-9]+$/.test(dname.text)) throw new PreprocessUnsupportedError(`"${dname.text}" after # is not a positive integer`, hash.line);
            const newLine = parseInt(dname.text, 10);
            let newFile = file;
            const f = toks[1];
            if (f) {
                if (f.kind !== "string" || !f.text.startsWith('"')) throw new PreprocessUnsupportedError("invalid filename in linemarker", hash.line);
                newFile = unquote(f.text);
                if (toks.length > 2) throw new PreprocessUnsupportedError("linemarker flags are not supported", hash.line);
            }
            file = newFile;
            delta = newLine - (physLine + 1);
            printLine(newLine, newFile); // pp_file_change, LC_RENAME
            return true;
        }
        if (dname.kind !== "ident" || !DIRECTIVES.has(dname.text)) throw new PreprocessUnsupportedError(`invalid preprocessing directive #${dname.text}`, hash.line);
        if (indented || !IN_I.has(dname.text)) return backup();
        const args = toks.slice(1);
        switch (dname.text) {
            case "define":
                handleDefine(hash, args);
                return true;
            case "undef": {
                const name = args[0];
                if (!name || name.kind !== "ident") throw new PreprocessUnsupportedError("no macro name given in #undef directive", hash.line);
                maybePrintLine(hash.line, hash.file);
                out.push(`#undef ${name.text}\n`);
                printed = false;
                srcLine++;
                return true;
            }
            case "ident":
            case "sccs": {
                const s = args[0];
                if (!s || s.kind !== "string" || !s.text.startsWith('"')) throw new PreprocessUnsupportedError(`invalid #${dname.text} directive`, hash.line);
                maybePrintLine(hash.line, hash.file);
                out.push(`#ident ${s.text}\n`);
                srcLine++;
                return true;
            }
            case "pragma": {
                const space = args[0]?.kind === "ident" ? args[0].text : "";
                const key = space === "GCC" && args[1] ? `GCC ${args[1].text}` : space;
                if (SPECIAL_PRAGMAS.has(key)) throw new PreprocessUnsupportedError(`#pragma ${key} is not emulated`, hash.line);
                maybePrintLine(hash.line, hash.file);
                out.push("#pragma " + args.map((t, k) => (k > 0 && t.prevWhite ? " " : "") + t.text).join("") + "\n");
                printed = false;
                srcLine++;
                return true;
            }
        }
        return backup();
    };

    while (pos < n) {
        if (skipWhite()) prevWhite = true;
        if (pos >= n) break;
        if (text[pos] === "\n") {
            newline();
            bol = true;
            prevWhite = false;
            continue;
        }
        const tok = lexToken();
        const wasBol = bol;
        bol = false;
        prevWhite = false;
        if (wasBol && (tok.text === "#" || tok.text === "%:") && handleDirective(tok)) continue;
        emitToken(tok);
    }
    if (printed) out.push("\n");
    return out.join("");
}
