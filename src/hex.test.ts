import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ElfFile, SHF_ALLOC, SHT_NOBITS } from "./elf";
import { elfToIntelHex, sectionLma } from "./hex";
import { parseIntelHex } from "../test-fixtures/parse-intel-hex";

const FIX = join(import.meta.dir, "../test-fixtures");
const read = (p: string) => new Uint8Array(readFileSync(join(FIX, p)));

/** Reference .hex files come from `avr-objcopy -O ihex -R .eeprom` (binutils of toolchain-atmelavr 7.3). */
describe("elfToIntelHex = avr-objcopy -O ihex -R .eeprom", () => {
    for (const name of ["uno/blink/firmware", "uno/avr-eeprom/firmware", "hex/seg", "hex/ext"]) {
        test(name, () => {
            expect(elfToIntelHex(read(`${name}.elf`))).toBe(readFileSync(join(FIX, `${name}.hex`), "utf8"));
        });
    }
});

describe("parity with the uploader's HEX parser", () => {
    test("parsed image = loadable sections at their LMA, .eeprom left out", () => {
        const elf = new ElfFile(read("uno/avr-eeprom/firmware.elf"));
        const img = parseIntelHex(elfToIntelHex(elf));
        expect(img.startAddress).toBe(0);
        const loaded = elf.sections.filter((s) => s.flags & SHF_ALLOC && s.type !== SHT_NOBITS && s.size > 0 && s.name !== ".eeprom");
        expect(loaded.length).toBeGreaterThan(1);
        let end = 0;
        for (const s of loaded) {
            const lma = sectionLma(elf, s);
            expect(img.data.subarray(lma, lma + s.size)).toEqual(elf.sectionData(s));
            end = Math.max(end, lma + s.size);
        }
        expect(img.data.length).toBe(end);
        expect(elf.section(".eeprom")).toBeDefined();
    });
});
