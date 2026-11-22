import { describe, expect, test } from "bun:test";
import { isCompatible, itemsInList, LIBRARY_MANIFEST_NAMES, type LibManifest, ManifestParseError, parseManifest, parseManifestBytes } from "./manifest";

const FIELDS = ["name", "version", "description", "frameworks", "platforms", "headers", "keywords", "dependencies", "build"] as const;
const pick = (m: LibManifest): Record<string, unknown> => Object.fromEntries(FIELDS.filter((k) => m[k] !== undefined).map((k) => [k, m[k]]));

/** [type, text, normalised fields (null = ManifestParserError)] as produced by PlatformIO 6.2's parsers. */
const CASES: Array<[LibManifest["type"], string, Record<string, unknown> | null]> = [
    ["library.json", "{\"name\": \"Foo\", \"version\": \"1.2.3\", \"keywords\": \"Sensor, sensor ,I2C\", \"platforms\": [\"Espressif\", \"espressif\", \"atmelavr\"], \"frameworks\": \"Arduino,arduino\", \"headers\": \"Foo.h, Foo.h, Bar.h\", \"dependencies\": {\"adafruit/Adafruit GFX Library\": \"^1.10.0\", \"SPI\": \"*\"}, \"build\": {\"flags\": [\"-DFOO\"], \"libArchive\": false}}", {"name": "Foo", "version": "1.2.3", "frameworks": ["arduino"], "platforms": ["espressif8266", "atmelavr"], "headers": ["Foo.h", "Bar.h"], "keywords": ["sensor", "i2c"], "dependencies": [{"owner": "adafruit", "name": "Adafruit GFX Library", "version": "^1.10.0"}, {"name": "SPI", "version": "*"}], "build": {"flags": ["-DFOO"], "libArchive": false}}],
    ["library.json", "{\"name\": \"Foo\", \"dependencies\": {\"name\": \"Bar\", \"version\": \"1.0\", \"platforms\": \"a, b\"}}", {"name": "Foo", "dependencies": [{"name": "Bar", "version": "1.0", "platforms": ["a", "b"]}]}],
    ["library.json", "{\"name\": \"Foo\", \"dependencies\": [{\"name\": \"owner/Bar\", \"version\": \"~1.0\", \"frameworks\": \"arduino, espidf\", \"authors\": \"A\"}, {\"owner\": \"o\", \"name\": \"x/y\"}, \"Plain\"]}", {"name": "Foo", "dependencies": [{"name": "Bar", "version": "~1.0", "frameworks": ["arduino", "espidf"], "authors": ["A"], "owner": "owner"}, {"owner": "o", "name": "x/y"}, {"name": "Plain"}]}],
    ["library.json", "{\"name\": \"Foo\", \"platforms\": \"espressif\"}", {"name": "Foo", "platforms": ["espressif8266"]}],
    ["library.json", "{\"name\": \"Foo\", \"platforms\": []}", {"name": "Foo"}],
    ["library.json", "{not json", null],
    ["library.json", "{\"name\": \"Foo\", \"dependencies\": \"Bar\"}", null],
    ["library.json", "{\"name\": \"Foo\", \"keywords\": 5}", null],
    ["library.json", "{\"name\": \"Foo\", \"repository\": \"https://x\"}", null],
    ["library.properties", "name=Adafruit BME280 Library\nversion=2.3.0\nauthor=Adafruit\nsentence=Arduino library for BME280 sensors\nparagraph=Arduino library for BME280 humidity and pressure sensors\ncategory=Sensors/Device Control\nurl=https://github.com/adafruit/Adafruit_BME280_Library\narchitectures=*\ndepends=Adafruit Unified Sensor, Adafruit BusIO (>=1.0.0)\n# comment=x\nincludes=Adafruit_BME280.h, Adafruit_Sensor.h\nempty=\nprecompiled=true\nldflags=-lfoo=bar\n", {"name": "Adafruit BME280 Library", "version": "2.3.0", "description": "Arduino library for BME280 sensors. Arduino library for BME280 humidity and pressure sensors", "frameworks": ["arduino"], "platforms": ["*"], "headers": ["Adafruit_BME280.h", "Adafruit_Sensor.h"], "keywords": ["sensors", "device", "control"], "dependencies": [{"name": "Adafruit Unified Sensor", "frameworks": ["arduino"]}, {"name": "Adafruit BusIO", "version": ">=1.0.0", "frameworks": ["arduino"]}]}],
    ["library.properties", "name=X\r\narchitectures=avr, samd ,esp32,unknownarch,sam\r\ncategory=Other\r\nsentence=Same.\r\nparagraph=Same.\r\n", {"name": "X", "description": "Same.", "frameworks": ["arduino"], "platforms": ["atmelavr", "atmelsam", "espressif32"], "keywords": ["other"]}],
    ["library.properties", "name=X\narchitectures=particle-photon\n", null],
    ["library.properties", "name=X\ndepends=A (1) (2)\n", null],
    ["module.json", "{\"name\": \"m\", \"version\": \"1.0.0\", \"keywords\": [\"A\", \"a\"], \"dependencies\": {\"x\": \"1.0\"}}", {"name": "m", "version": "1.0.0", "frameworks": ["mbed"], "platforms": ["*"], "keywords": ["a"], "dependencies": [{"name": "x", "version": "1.0", "frameworks": ["mbed"]}]}],
];

describe("parseManifest", () => {
    CASES.forEach(([type, text, expected], i) => {
        test(`${type} #${i}`, () => {
            if (expected === null) {
                expect(() => parseManifest(type, text)).toThrow(ManifestParseError);
                return;
            }
            const m = parseManifest(type, text);
            expect(m.type).toBe(type);
            expect(pick(m)).toEqual(expected);
        });
    });

    test("library.properties keeps the raw properties", () => {
        const m = parseManifest("library.properties", CASES[9]![1]);
        expect(m.properties).toMatchObject({ precompiled: "true", ldflags: "-lfoo=bar", architectures: "*", includes: "Adafruit_BME280.h, Adafruit_Sensor.h" });
        expect(m.properties!.empty).toBeUndefined();
        expect(m.properties!["# comment"]).toBeUndefined();
    });

    test("bytes: UTF-8, else latin-1", () => {
        const utf8 = new TextEncoder().encode("name=Grüße\n");
        expect(parseManifestBytes("library.properties", utf8).name).toBe("Grüße");
        const latin1 = new Uint8Array([...new TextEncoder().encode("name=Gr"), 0xfc, 0x0a]);
        expect(parseManifestBytes("library.properties", latin1).name).toBe("Grü");
    });

    test("manifest order", () => {
        expect(LIBRARY_MANIFEST_NAMES).toEqual(["library.json", "library.properties", "module.json"]);
    });
});

describe("itemsInList / isCompatible", () => {
    test("itemsInList", () => {
        expect(itemsInList("*", ["a"])).toBe(true);
        expect(itemsInList(["a"], "*")).toBe(true);
        expect(itemsInList("a, b", ["b"])).toBe(true);
        expect(itemsInList("a", "b")).toBe(false);
        expect(itemsInList(undefined, "b")).toBe(false);
    });

    /** [a, b, PackageCompatibility(**a).is_compatible(PackageCompatibility(**b))] from PlatformIO 6.2. */
    const COMPAT: Array<[Record<string, unknown>, Record<string, unknown>, boolean]> = [
        [{"name": "Foo", "platforms": ["atmelavr"]}, {"name": "Foo", "platforms": "atmelavr, espressif32"}, true],
        [{"platforms": ["atmelavr"]}, {"platforms": ["*"]}, true],
        [{"platforms": ["ststm32"]}, {"platforms": ["atmelavr"]}, false],
        [{"version": "^1.2.0"}, {"version": "1.5.0"}, true],
        [{"version": "^1.2.0"}, {"version": "2.0.0"}, false],
        [{"version": "1.2"}, {"version": "1.2"}, true],
        [{"version": "not a spec"}, {"version": "1.0.0"}, false],
        [{"owner": "a"}, {"owner": "b"}, false],
        [{"owner": "a"}, {"owner": ""}, true],
        [{"frameworks": "arduino"}, {"frameworks": ["arduino", "espidf"]}, true],
        [{"frameworks": "arduino"}, {"frameworks": "espidf"}, false],
        [{"authors": []}, {"authors": ["x"]}, true],
        [{"version": ">=1.0.0"}, {"version": "abc123"}, false],
    ];
    for (const [a, b, expected] of COMPAT) {
        test(`${JSON.stringify(a)} vs ${JSON.stringify(b)}`, () => expect(isCompatible(a, b)).toBe(expected));
    }
});
