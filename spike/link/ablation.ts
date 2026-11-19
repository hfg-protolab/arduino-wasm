/**
 * Which ld rules matter? Runs the resolver with one rule switched off / wrong and counts the
 * difference to ld's real choice (Map). Rules: roots from -u, ENTRY, --wrap, weak undefined
 * references do not load members, --start-group rescans.
 *
 *   node ablation.ts [<sketch>.<env> ...]
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LinkCapture } from "./capture.ts";
import { SCRATCH } from "./common.ts";
import { linkInputs } from "./inputs.ts";
import { resolve, type ResolveAblation } from "./resolve.ts";

const ids = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(join(SCRATCH, "cap")).sort();
for (const id of ids) {
    const cap: LinkCapture = JSON.parse(readFileSync(join(SCRATCH, "cap", id, "link.json"), "utf8"));
    const li = linkInputs(cap.ldArgs, cap.cwd, cap.triple);
    const ld = new Set(cap.trace);
    const cmp = (roots: string[], ab: ResolveAblation) => {
        const r = resolve(li.inputs, roots, li.plan.wraps, ab);
        const mine = new Set(r.order);
        return `-${[...ld].filter((x) => !mine.has(x)).length}/+${[...mine].filter((x) => !ld.has(x)).length}`;
    };
    const entry = li.roots[li.roots.length - 1];
    console.log(`${id}: exact ${cmp(li.roots, {})} | no -u ${cmp(li.roots.filter((r) => !li.plan.undefined.includes(r)), {})} | no ENTRY ${cmp(li.roots.slice(0, -1), {})} (${entry}) | no --wrap ${cmp(li.roots, { noWrap: true })} | weak-undef pulls ${cmp(li.roots, { weakUndefPulls: true })} | no group rescan ${cmp(li.roots, { noGroupRescan: true })}`);
}
