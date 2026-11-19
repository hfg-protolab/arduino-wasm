/**
 * Lazy-linking resolver (plan decision 5): which archive members would GNU ld (BFD, ELF)
 * load for this link? Pure function over a symbol index, so it runs in the browser before
 * anything but the index is downloaded.
 *
 * Mirrors bfd/elflink.c `elf_link_add_archive_symbols` and ld/ldlang.c `open_input_bfds`:
 *  - Roots first: -u/--undefined, linker-script EXTERN, the entry symbol (ENTRY or -e; ld adds
 *    it as undefined in after_parse_default). Not wrapped by --wrap.
 *  - Inputs in command-line order. An object is loaded whole. An archive is scanned over its
 *    armap (in armap order) again and again until a pass loads nothing: a member is loaded when
 *    an armap symbol is currently *strongly* undefined, or currently common and the member has
 *    a real (global, non-common) definition. Weak undefined references never load a member;
 *    a weak definition already present stops the search too.
 *  - --start-group … --end-group: rescan the group's archives while the previous pass created
 *    new undefined symbol names (ld's `undefs_tail` test).
 *  - --wrap=X: an undefined reference to X counts as __wrap_X, one to __real_X as X.
 *  - Linker-script symbol assignments are NOT definitions here: collect2 puts every -T after
 *    the inputs, so ld folds them only after all archives were scanned.
 */
import type { ObjSymbol } from "./elf.ts";

export interface MemberIndex {
    name: string;
    size: number;
    syms: ObjSymbol[];
}

export interface ArchiveIndex {
    members: MemberIndex[];
    /** armap in file order: [symbol, member index]. */
    armap: Array<[string, number]>;
}

export type ResolveInput =
    | { kind: "object"; path: string; syms: ObjSymbol[] }
    | { kind: "archive"; path: string; index: ArchiveIndex; whole?: boolean }
    | { kind: "groupStart" }
    | { kind: "groupEnd" };

export interface ResolveResult {
    /** Loaded members per archive path (member indices, ascending). */
    members: Map<string, number[]>;
    /** Load order, "path(member)". */
    order: string[];
    /** Still strongly undefined at the end (ld would report these unless the script defines them). */
    undefined: string[];
    /** Why each member was loaded: the symbol. */
    reason: Map<string, string>;
}

type State = "undef" | "undefweak" | "def" | "weakdef" | "common";

/** Deliberately wrong variants, only to measure which ld rule matters (ablation.ts). */
export interface ResolveAblation {
    weakUndefPulls?: boolean;
    noGroupRescan?: boolean;
    noWrap?: boolean;
}

export function resolve(inputs: ResolveInput[], roots: string[], wraps: Iterable<string>, ablate: ResolveAblation = {}): ResolveResult {
    const wrap = new Set(ablate.noWrap ? [] : wraps);
    const table = new Map<string, State>();
    let undefCreated = 0;
    const loaded = new Map<string, Set<number>>();
    const order: string[] = [];
    const reason = new Map<string, string>();

    const refName = (n: string) => (wrap.has(n) ? `__wrap_${n}` : n.startsWith("__real_") && wrap.has(n.slice(7)) ? n.slice(7) : n);

    function add(syms: ObjSymbol[]) {
        for (const s of syms) {
            const isRef = s.kind === "undef" || s.kind === "weakundef";
            const name = isRef ? refName(s.name) : s.name;
            const cur = table.get(name);
            switch (s.kind) {
                case "def":
                    if (cur !== "def") table.set(name, "def");
                    break;
                case "weakdef":
                    if (!cur || cur === "undef" || cur === "undefweak") table.set(name, "weakdef");
                    break;
                case "common":
                    if (!cur || cur === "undef" || cur === "undefweak" || cur === "weakdef") table.set(name, "common");
                    break;
                case "undef":
                    if (!cur) { table.set(name, "undef"); undefCreated++; }
                    else if (cur === "undefweak") table.set(name, "undef");
                    break;
                case "weakundef":
                    if (!cur) { table.set(name, "undefweak"); undefCreated++; }
                    break;
            }
        }
    }

    function scanArchive(path: string, idx: ArchiveIndex, whole: boolean) {
        let set = loaded.get(path);
        if (!set) loaded.set(path, (set = new Set()));
        const load = (m: number, why: string) => {
            set!.add(m);
            order.push(`${path}(${idx.members[m].name})`);
            reason.set(`${path}(${idx.members[m].name})`, why);
            add(idx.members[m].syms);
        };
        if (whole) {
            idx.members.forEach((_, m) => { if (!set!.has(m)) load(m, "--whole-archive"); });
            return;
        }
        let again = true;
        while (again) {
            again = false;
            for (const [sym, m] of idx.armap) {
                if (set.has(m)) continue;
                const st = table.get(sym);
                if (st === "undef" || (ablate.weakUndefPulls && st === "undefweak")) { load(m, sym); again = true; }
                else if (st === "common" && idx.members[m].syms.some((s) => s.name === sym && s.kind === "def")) { load(m, sym); again = true; }
            }
        }
    }

    for (const r of roots) add([{ name: r, kind: "undef" }]);
    // roots are not wrapped: add() wraps refs, so undo for roots
    for (const r of roots) if (wrap.has(r) && table.get(`__wrap_${r}`) === "undef") { table.delete(`__wrap_${r}`); table.set(r, "undef"); }

    let group: Array<Extract<ResolveInput, { kind: "archive" }>> | null = null;
    let groupMark = 0;
    for (const inp of inputs) {
        if (inp.kind === "object") add(inp.syms);
        else if (inp.kind === "archive") {
            scanArchive(inp.path, inp.index, !!inp.whole);
            group?.push(inp);
        } else if (inp.kind === "groupStart") { group = []; groupMark = undefCreated; }
        else if (inp.kind === "groupEnd" && group) {
            // The first pass already happened while walking the inputs; ld repeats while a
            // pass created new undefined names.
            let before = groupMark;
            while (!ablate.noGroupRescan && before !== undefCreated) {
                before = undefCreated;
                for (const g of group) scanArchive(g.path, g.index, !!g.whole);
            }
            group = null;
        }
    }

    const members = new Map<string, number[]>();
    for (const [p, s] of loaded) if (s.size) members.set(p, [...s].sort((a, b) => a - b));
    const undefined_ = [...table].filter(([, s]) => s === "undef").map(([n]) => n);
    return { members, order, undefined: undefined_, reason };
}
