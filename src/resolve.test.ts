import { describe, expect, test } from "bun:test";
import { resolve, type ArchiveIndex, type ResolveInput } from "./resolve";
import type { ObjSymbol } from "./symbols";

const S = (spec: string): ObjSymbol[] =>
    spec
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => {
            const [kind, name] = t.split(":") as [string, string];
            return { name, kind: ({ D: "def", W: "weakdef", C: "common", U: "undef", w: "weakundef" } as const)[kind as "D"] };
        });

/** Archive from "member=symbols" pairs; armap = the member's defs and commons. */
function ar(members: Record<string, string>): ArchiveIndex {
    const ms = Object.entries(members).map(([name, spec]) => ({ name, size: 1, syms: S(spec) }));
    const armap: Array<[string, number]> = [];
    ms.forEach((m, i) => m.syms.filter((s) => s.kind === "def" || s.kind === "weakdef" || s.kind === "common").forEach((s) => armap.push([s.name, i])));
    return { members: ms, armap };
}
const obj = (spec: string): ResolveInput => ({ kind: "object", path: "main.o", syms: S(spec) });
const arc = (path: string, idx: ArchiveIndex): ResolveInput => ({ kind: "archive", path, index: idx });

describe("resolve (GNU ld archive semantics)", () => {
    test("loads members for strong undefined symbols, transitively, in armap order", () => {
        const r = resolve([obj("D:main U:a"), arc("lib.a", ar({ "a.o": "D:a U:b", "b.o": "D:b", "c.o": "D:c" }))], [], []);
        expect(r.members.get("lib.a")).toEqual([0, 1]);
        expect(r.order).toEqual(["lib.a(a.o)", "lib.a(b.o)"]);
        expect(r.undefined).toEqual([]);
    });
    test("a weak undefined reference never loads a member", () => {
        const r = resolve([obj("w:a"), arc("lib.a", ar({ "a.o": "D:a" }))], [], []);
        expect(r.members.size).toBe(0);
    });
    test("a common symbol loads only a member with a real definition", () => {
        const r = resolve([obj("C:x"), arc("lib.a", ar({ "c.o": "C:x", "d.o": "D:x" }))], [], []);
        expect(r.members.get("lib.a")).toEqual([1]);
    });
    test("archive order matters without a group; a group is rescanned while new undefined names appear", () => {
        const a1 = ar({ "a.o": "D:a U:b" });
        const a2 = ar({ "b.o": "D:b U:c" });
        const a3 = ar({ "c.o": "D:c" });
        const plain = resolve([obj("U:c U:a"), arc("3.a", a3), arc("1.a", a1), arc("2.a", a2)], [], []);
        expect(plain.undefined).toEqual(["c"].filter(() => false)); // c is resolved before b needs it
        const missing = resolve([obj("U:a"), arc("3.a", a3), arc("1.a", a1), arc("2.a", a2)], [], []);
        expect(missing.undefined).toEqual(["c"]);
        const grouped = resolve([obj("U:a"), { kind: "groupStart" }, arc("3.a", a3), arc("1.a", a1), arc("2.a", a2), { kind: "groupEnd" }], [], []);
        expect(grouped.undefined).toEqual([]);
        expect(grouped.members.get("3.a")).toEqual([0]);
    });
    test("roots (-u, ENTRY) pull members and are not wrapped; --wrap redirects references", () => {
        const lib = ar({ "f.o": "D:f", "wf.o": "D:__wrap_f U:__real_f", "e.o": "D:entry" });
        const r = resolve([obj("U:f"), arc("lib.a", lib)], ["entry"], ["f"]);
        // main's f → __wrap_f (wf.o), whose __real_f → f (f.o); root "entry" → e.o
        expect(r.members.get("lib.a")).toEqual([0, 1, 2]);
    });
    test("the same archive path shares its loaded-member set", () => {
        const lib = ar({ "a.o": "D:a", "b.o": "D:b" });
        const r = resolve([obj("U:a"), arc("lib.a", lib), obj("U:a U:b"), arc("lib.a", lib)], [], []);
        expect(r.members.get("lib.a")).toEqual([0, 1]);
        expect(r.order).toEqual(["lib.a(a.o)", "lib.a(b.o)"]);
    });
});
