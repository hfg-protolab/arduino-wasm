/**
 * Copy of the Intel HEX parser of the web uploader that flashes this package's HEX output
 * (HEX → one contiguous image, gaps 0xFF). Kept here so the parity test runs standalone.
 */

export interface HexImage {
    /** Lowest address with data. */
    startAddress: number;
    /** Bytes from `startAddress` up to the highest address with data. */
    data: Uint8Array;
    /** Entry point from record 03/05, if present. */
    entry?: number;
}

export class HexParseError extends Error {
    constructor(
        message: string,
        readonly line: number,
    ) {
        super(`line ${line}: ${message}`);
        this.name = "HexParseError";
    }
}

export function parseIntelHex(text: string): HexImage {
    const lines = text.split(/\r?\n/);
    const segments: { addr: number; bytes: Uint8Array }[] = [];
    let base = 0;
    let entry: number | undefined;
    let sawEof = false;

    for (let i = 0; i < lines.length; i++) {
        const lineNo = i + 1;
        const raw = lines[i]!.trim();
        if (raw === "") continue;
        if (sawEof) throw new HexParseError("data after the EOF record", lineNo);
        if (raw[0] !== ":") throw new HexParseError("record does not start with ':'", lineNo);
        const hex = raw.slice(1);
        if (hex.length < 10 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) throw new HexParseError("invalid hex characters or length", lineNo);
        const bytes = new Uint8Array(hex.length / 2);
        for (let j = 0; j < bytes.length; j++) bytes[j] = parseInt(hex.substr(j * 2, 2), 16);
        const len = bytes[0]!;
        if (bytes.length !== len + 5) throw new HexParseError(`length ${len} does not match the record`, lineNo);
        let sum = 0;
        for (const b of bytes) sum = (sum + b) & 0xff;
        if (sum !== 0) throw new HexParseError("bad checksum", lineNo);
        const offset = (bytes[1]! << 8) | bytes[2]!;
        const type = bytes[3]!;
        const payload = bytes.subarray(4, 4 + len);
        switch (type) {
            case 0x00:
                segments.push({ addr: base + offset, bytes: payload });
                break;
            case 0x01:
                sawEof = true;
                break;
            case 0x02:
                if (len !== 2) throw new HexParseError("record 02 needs 2 bytes", lineNo);
                base = ((payload[0]! << 8) | payload[1]!) * 16;
                break;
            case 0x04:
                if (len !== 2) throw new HexParseError("record 04 needs 2 bytes", lineNo);
                base = ((payload[0]! << 8) | payload[1]!) * 0x10000;
                break;
            case 0x03:
            case 0x05:
                if (len !== 4) throw new HexParseError(`record 0${type} needs 4 bytes`, lineNo);
                entry = type === 0x05 ? ((payload[0]! << 24) | (payload[1]! << 16) | (payload[2]! << 8) | payload[3]!) >>> 0 : ((payload[0]! << 8) | payload[1]!) * 16 + ((payload[2]! << 8) | payload[3]!);
                break;
            default:
                throw new HexParseError(`unknown record type ${type}`, lineNo);
        }
    }
    if (!sawEof) throw new HexParseError("EOF record missing", lines.length);
    if (segments.length === 0) return { startAddress: 0, data: new Uint8Array(0), entry };

    let lo = Infinity;
    let hi = 0;
    for (const s of segments) {
        lo = Math.min(lo, s.addr);
        hi = Math.max(hi, s.addr + s.bytes.length);
    }
    if (hi - lo > 16 * 1024 * 1024) throw new HexParseError("address range larger than 16 MB", 0);
    const data = new Uint8Array(hi - lo).fill(0xff);
    for (const s of segments) data.set(s.bytes, s.addr - lo);
    return { startAddress: lo, data, entry };
}
