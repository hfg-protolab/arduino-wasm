/**
 * PlatformIO's `src_filter` (platformio/fs.py `match_src_files`) over an in-memory file list:
 * every `+<pattern>` / `-<pattern>` is a Python `glob.glob(src_dir/pattern, recursive=True)`;
 * a matched directory contributes every file below it; files are kept when they end with one of
 * the extensions; the result is sorted (Python string order). glob's rules: `*`, `?` and `[…]`
 * never cross `/`, `**` (a whole segment) matches any number of directories, and a wildcard
 * segment does not match names starting with "." unless the pattern segment does.
 */

export const SRC_HEADER_EXT = ["h", "hpp"];
export const SRC_ASM_EXT = ["S", "spp", "SPP", "sx", "s", "asm", "ASM"];
export const SRC_C_EXT = ["c"];
export const SRC_CXX_EXT = ["cc", "cpp", "cxx", "c++"];
export const SRC_BUILD_EXT = [...SRC_C_EXT, ...SRC_CXX_EXT, ...SRC_ASM_EXT];
export const SRC_FILTER_DEFAULT = ["+<*>", "-<.git/>", "-<.svn/>"];

export const endsWithExt = (p: string, exts: string[]) => exts.some((e) => p.endsWith(`.${e}`));

/** fnmatch.translate for one path segment (case-sensitive, like fnmatchcase on POSIX). */
function segmentRe(pat: string): RegExp {
    let re = "";
    for (let i = 0; i < pat.length; i++) {
        const c = pat[i]!;
        if (c === "*") re += ".*";
        else if (c === "?") re += ".";
        else if (c === "[") {
            let j = i + 1;
            if (pat[j] === "!") j++;
            if (pat[j] === "]") j++;
            while (j < pat.length && pat[j] !== "]") j++;
            if (j >= pat.length) re += "\\[";
            else {
                let stuff = pat.slice(i + 1, j).replace(/\\/g, "\\\\");
                if (stuff[0] === "!") stuff = "^" + stuff.slice(1);
                else if (stuff[0] === "^") stuff = "\\" + stuff;
                re += `[${stuff}]`;
                i = j;
            }
        } else re += c.replace(/[.+^${}()|\\\]]/g, "\\$&");
    }
    return new RegExp(`^${re}$`, "s");
}

const hasMagic = (s: string) => /[*?[]/.test(s);

/**
 * @param files every file of the library, paths relative to the library root ("src/a.cpp")
 * @param srcDir the source dir relative to the library root ("" = the root)
 * @returns matching files relative to `srcDir`, sorted
 */
export function matchSrcFiles(files: string[], srcDir: string, srcFilter: string | string[] | undefined, exts?: string[]): string[] {
    const pre = srcDir ? `${srcDir.replace(/\/$/, "")}/` : "";
    const rel = files.filter((f) => f.startsWith(pre)).map((f) => f.slice(pre.length));
    // directory tree of the source dir
    const children = new Map<string, Map<string, boolean>>(); // dir → name → isDir
    const addChild = (dir: string, name: string, isDir: boolean) => {
        let m = children.get(dir);
        if (!m) children.set(dir, (m = new Map()));
        if (!m.has(name) || isDir) m.set(name, isDir);
    };
    for (const f of rel) {
        const parts = f.split("/");
        for (let i = 0; i < parts.length; i++) addChild(parts.slice(0, i).join("/"), parts[i]!, i < parts.length - 1);
    }
    const isDir = (p: string) => p === "" || children.has(p);
    const exists = (p: string) => isDir(p) || rel.includes(p);
    const join = (a: string, b: string) => (a ? `${a}/${b}` : b);
    /** glob with recursive=True: returns matched paths (files or dirs) */
    const glob = (pattern: string): string[] => {
        const segs = pattern.split("/");
        const trailingSlash = segs.length > 1 && segs[segs.length - 1] === "";
        if (trailingSlash) segs.pop();
        let cur: string[] = [""];
        for (let si = 0; si < segs.length; si++) {
            const seg = segs[si]!;
            const last = si === segs.length - 1;
            const next: string[] = [];
            for (const base of cur) {
                if (!isDir(base)) continue;
                if (seg === "**") {
                    // _glob2: the dir itself, then every dir/file below it (non-hidden)
                    const rec: string[] = [base];
                    const walk = (d: string) => {
                        for (const [name, dir] of [...(children.get(d) ?? [])].sort()) {
                            if (name.startsWith(".")) continue;
                            const p = join(d, name);
                            if (dir || last) rec.push(p);
                            if (dir) walk(p);
                        }
                    };
                    walk(base);
                    for (const p of rec) next.push(p);
                } else if (!hasMagic(seg)) {
                    const p = join(base, seg);
                    if (seg === "" ? isDir(base) : exists(p)) next.push(seg === "" ? base : p);
                } else {
                    const re = segmentRe(seg);
                    for (const [name] of children.get(base) ?? []) {
                        if (name.startsWith(".") && !seg.startsWith(".")) continue;
                        if (re.test(name)) next.push(join(base, name));
                    }
                }
            }
            cur = [...new Set(next)];
        }
        // "**" as the last segment yields the base dir too: glob drops "" (src_dir itself) only for the empty pattern
        return trailingSlash ? cur.filter(isDir) : cur.filter((p) => p !== "" || segs.join("/") === "**");
    };
    const candidates = (pattern: string): Set<string> => {
        const out = new Set<string>();
        for (const item of glob(pattern)) {
            if (!isDir(item)) {
                if (!exts || endsWithExt(item, exts)) out.add(item);
                continue;
            }
            const pre2 = item ? `${item}/` : "";
            for (const f of rel) if (f.startsWith(pre2) && (!exts || endsWithExt(f, exts))) out.add(f);
        }
        return out;
    };
    const filter = Array.isArray(srcFilter) ? srcFilter.join(" ") : (srcFilter ?? "");
    const result = new Set<string>();
    const use = filter.trim() ? filter : SRC_FILTER_DEFAULT.join(" ");
    for (const m of use.replace(/\\/g, "/").matchAll(/(\+|-)<([^>]+)>/g)) {
        const c = candidates(m[2]!);
        if (m[1] === "+") for (const x of c) result.add(x);
        else for (const x of c) result.delete(x);
    }
    return [...result].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
