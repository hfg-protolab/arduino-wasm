# Phase 0 – Lazy-Linking, Header-Bundle, konstante Teile (native Messung)

Stand 18.11.2026, gemessen auf macOS:
- PlatformIO 6.2.0
- `atmelavr@5.3.0` mit avr-gcc 7.3.0
- `espressif32@7.1.3` mit Arduino-ESP32 2.0.17 / IDF 4.4 und GCC 8.4.0 2021r2 (xtensa-esp32, xtensa-esp32s3, riscv32-esp)

Boards, Bibliotheken, Toolchains und Sketches sind Eingaben aus `config.json`.

## Ergebnis
Der TS-Resolver trifft die Auswahl von GNU ld **exakt**, in Menge und Reihenfolge, in allen 19 Links ohne LTO. Wenn nur die aufgelösten Member in kleine `.a` neu gepackt werden, ist die Firmware **byte-gleich**. Ohne Debug-Info liegen die Downloads weit unter den Zielen: ESP32 ≈ 4 MB plus Compiler, AVR < 0,5 MB plus Compiler.

## 1. Link-Eingaben
| Board | ld-Argumente | Member geladen (Blink) | alle Link-Archive roh | ohne Debug-Info |
|---|---|---|---|---|
| uno / nano / nano-old (ohne LTO) | 34 | 6 | 6,4 MB | 1,5 MB |
| esp32dev | 526 (114 verschiedene `-l`) | 672 | 190 MB | 43,9 MB |
| esp32-s3 | 584 | 691 | 189 MB | 43,7 MB |
| esp32-c3 | 569 (111 verschiedene `-l`) | 685 | 225 MB | 66,1 MB |

- **Reihenfolge der Xtensa-Link-Eingaben:**
  - `crt0`, `crti`, `crtbegin`
  - 20–21 × `-u` und 3–4 × `--wrap`
  - die Objekte
  - eine `--start-group` mit allen IDF-`-l`
  - `crtend`, `crtn`
  - die `-T`-Skripte **am Ende** (collect2 schiebt sie hinter die Eingaben)
- **AVR:** `-plugin` (LTO), `-mavr5 -Tdata 0x800100` und das eingebaute Linkerskript.
- **ld direkt aufrufen:** Mit dem collect2-argv entsteht bei allen 24 Links dieselbe ELF wie pios `firmware.elf`. Der gcc-Treiber wird also nicht gebraucht (Entscheidung 2).
- **Achtung beim argv:** `gcc -v` druckt das collect2-argv **ungequotet**, dadurch zerfällt z. B. `libAdafruit BusIO.a`. Für das Manifest das argv deshalb über `-###` oder aus der SCons-Umgebung von pio holen.

## 2. Resolver gegen ld
Referenz ist die Map-Datei des nativen Links („Archive member included…“), verglichen werden Menge **und** Reihenfolge.

| Link | Member (ld) | Resolver | Re-Link aus Mini-Archiven |
|---|---|---|---|
| 5 Sketches × esp32dev / s3 / c3 (15 Links): Blink, Blink2, WiFi+HTTP, SSD1306+DHT, ESP32Servo | 672–776 | exakt | ELF und `.bin` **byte-gleich** |
| AVR ohne LTO (4 Links): Blink × 3 Boards, SSD1306 × uno | 6 / 57 | exakt | ELF und `.hex` **byte-gleich** |
| AVR **mit LTO**, heutige Prod-Konfiguration (6 Links) | 6–21 | es fehlen 1–9 | – |

- **Laufzeit:** Der Resolver braucht 30–200 ms pro ESP32-Link (Node, Index im Speicher).
- **Mini-Archive:**
  - Die Armap ist die Original-Armap, gefiltert.
  - Die Member bleiben in der Originalreihenfolge.
  - Der Dateiname bleibt **gleich**, weil `sections.ld` Code per `*libfoo.a:` platziert.
  - Archive ohne aufgelöste Member fallen weg.

**Welche ld-Regel wie viel ausmacht** (`ablation.ts`, Werte als fehlend / zu viel):

| Weggelassene Regel | ESP32 | AVR |
|---|---|---|
| `-u`-Wurzeln | −7…−10 / +1…+2 | 0 |
| `ENTRY` als Wurzel | c3 −6, esp32/s3 0 | – |
| `--wrap` | −4…−5 | – |
| „schwach undefiniert lädt nicht“ | +1…+23 | +2…+28 |
| Gruppen-Rescan | −1…−20 (WiFi −20) | −1 |

## 3. Download
Die Archive sind mit `objcopy --strip-debug` behandelt, Brotli q11. Jede Zelle zeigt: Member · roh / Brotli je Datei / Brotli als ein Blob.

| Sketch | esp32dev | esp32-s3 | esp32-c3 |
|---|---|---|---|
| Blink | 677 · 9,6 / 2,62 / 2,02 MB | 696 · 9,6 / 2,58 / 1,96 | 685 · 13,8 / 2,92 / 2,35 |
| WiFi+HTTP | 754 · 11,5 / 3,02 / 2,32 | 776 · 11,5 / 2,98 / 2,27 | 763 · 16,4 / 3,41 / 2,76 |
| SSD1306+DHT | 724 · 10,2 / 2,78 / 2,13 | 749 · 10,3 / 2,75 / 2,08 | 740 · 15,0 / 3,15 / 2,54 |
| Vereinigung der 5 Sketches | 803 · 12,1 / 3,19 | 835 · 12,3 / 3,19 | 818 · 17,7 / 3,67 |
| alle Archive des Links | 43,9 / **10,7** | 43,7 / **10,6** | 66,1 / **13,0** |
| Symbol-Index (JSON) | 3,13 / **0,37** | 3,12 / 0,37 | 3,01 / 0,35 |
| Linkerskripte | 0,18 / 0,02 | 0,14 / 0,03 | 0,13 / 0,02 |

- **Basis + Delta:**
  - Alle 5 Sketches brauchen 661 / 676 / 669 Member gemeinsam. Diese Basis kostet **1,99 / 1,91 / 2,28 MB Brotli**.
  - Pro Sketch kommen nur 7–91 Member dazu (Brotli): Blink +0,01 MB, Servo +0,05, SSD1306+DHT +0,13…0,24, WiFi +0,34…0,47.
  - **Grund:**
    - `esp32-hal-misc.c` wird für `delay` gelinkt und referenziert `esp_bt_controller_mem_release`. Darüber kommen bt → phy → wifi → net80211 → mesh in den Link.
    - `startup.c` zieht über `g_startup_fn` zusätzlich lwIP.
  - Die Granularität „Member“ kann das nicht abschneiden, erst `--gc-sections` entfernt es.
- **Dedupe über die Chips** bringt fast nichts: 42,2 → 40,2 MB roh.
- **AVR ohne LTO:** Alle Archive zusammen sind 0,12–0,16 MB Brotli, der Index 0,03 MB. Lazy-Linking lohnt auf AVR nicht, dort einfach alles laden.
- **Ohne Strip:** Blink auf esp32dev kostet 32,8 MB roh / 7,6 MB Brotli (q9) statt 2,0 MB.

**Gegen die Ziele des Plans** (erster Download; der Compiler mit ~10 MB kommt jeweils dazu):

| Board | Lazy: Basis + Header + Index + Skripte + Bins | ohne Lazy (alle Archive) | gesamt inkl. Compiler | Ziel |
|---|---|---|---|---|
| AVR | – | ≈ 0,5 MB | ≈ 10,5 MB ✔ | 10–15 MB |
| esp32dev | ≈ 3,9 MB (WiFi 4,2) | ≈ 12,5 MB | ≈ 14 MB ✔, ohne Lazy ≈ 22 MB | 20–30 MB |
| esp32-c3 | ≈ 4,1 MB (WiFi 4,6) | ≈ 14,7 MB | ≈ 14 MB ✔, ohne Lazy ≈ 25 MB | 20–30 MB |

Auch ohne Lazy-Linking hält ESP32 das Ziel, wenn die Archive gestrippt sind.

## 4. Header-Bundle
Der Abschluss entsteht per `-M`. Jeder Kandidat wird einzeln hinter `#include <Arduino.h>` vorverarbeitet. Kandidaten:
- `Arduino.h`
- alle Header der Framework-Bibliotheken (Wire, SPI, WiFi, HTTPClient, BLE, …)
- alle Header der freigegebenen Bibliotheken, inklusive GFX-`Fonts/`
- die C/C++-Standard-Header

| Board | Kandidaten ok | Dateien | roh | Brotli | Obergrenze (alle Header in allen `-I`) |
|---|---|---|---|---|---|
| uno / nano / nano-old | 105 / 109 | 124–125 | 2,13 MB (davon 1,40 MB GFX-Fonts) | **0,29 MB** | 470 Dateien, 28,9 MB |
| esp32dev | 263 / 273 | 738 | 11,2 MB | **1,36 MB** | 3 234 Dateien, 29,9 MB |
| esp32-s3 | 263 / 273 | 754 | 11,6 MB | 1,39 MB | 3 316 Dateien, 33,3 MB |
| esp32-c3 | 263 / 273 | 719 | 10,8 MB | 1,31 MB | 3 259 Dateien, 29,3 MB |

- **ESP32-Familie:** Die drei Bundles sind in Summe 33,6 MB, inhaltlich vereinigt 13,5 MB. **73 %** davon stecken in allen drei, allein libstdc++ sind 4,4 MB pro Chip. Ein Familien-Bundle plus Chip-Delta lohnt sich.
- **AVR:** Die drei Bundles sind nicht ganz gleich, nur `pins_arduino.h` der Variante unterscheidet sich (`standard` vs. `eightanaloginputs`).
- **Lücke:** Der Abschluss enthält nur IDF-Header, die über Arduino.h oder die Bibliotheken erreichbar sind.
  - Sketche, die `esp_wifi.h` oder `driver/*.h` direkt einbinden, fallen heraus.
  - Lösung wäre die Obergrenze (30 MB roh, Brotli nicht gemessen) oder eine kuratierte Liste.
  - Das sollte vor Phase 1 entschieden werden.

## 5. Konstante Teile
bootloader.bin und partitions.bin sind über alle 5 Sketches je Board byte-gleich (sha256 verglichen). boot_app0.bin ist eine Datei aus dem Framework.

| Board | bootloader | partitions | boot_app0 | App |
|---|---|---|---|---|
| esp32dev | 17 536 B @0x1000 | 3 072 B @0x8000 (default.csv) | 8 192 B @0xe000 | @0x10000 |
| esp32-s3 | 15 104 B @0x0 | 3 072 B @0x8000 (default_8MB.csv) | 8 192 B @0xe000 | @0x10000 |
| esp32-c3 | 13 248 B @0x0 | 3 072 B @0x8000 (default.csv) | 8 192 B @0xe000 | @0x10000 |

Den Bootloader erzeugt `esptool elf2image` aus einem fertigen `bootloader_*.elf` mit den Flash-Parametern des Boards (S3: `dio 80m 8MB`). Das passiert also einmal pro Board in CI.

## Überraschungen und Fallstricke
1. **Debug-Info gegen Byte-Gleichheit.** Ohne Strip ist der Download 3–4× größer. Mit Strip ist das Image funktional gleich, aber nicht byte-gleich:
   - `--elf-sha256-offset 0xb0` schreibt den SHA-256 der **ELF-Datei inklusive DWARF** ins Image. Dadurch weichen 32 B bei 0xb0 und die Prüfsumme samt angehängtem Image-Hash (33 B) ab.
   - Auf Xtensa ändern sich zusätzlich 6–24 B in `.eh_frame`. FDEs verworfener COMDAT-Duplikate (z. B. `std::_Function_base::~_Function_base` aus `FunctionalInterrupt.cpp.o`) zeigen ohne Debug-Sektionen auf 0 statt auf die behaltene Kopie. Die Einträge sind tot, die Bytes ändern sich trotzdem.
   - Das gilt für `--strip-debug` und `-R .debug_*` gleichermaßen. Auf C3 (RISC-V) gibt es keine `.eh_frame`-Abweichung.
   - **Vorschlag:** Der Korpus in Phase 4 vergleicht den WASM-Link byte-genau mit einem **nativen Link über dieselben gestrippten Pack-Dateien**. Einmalig wird zusätzlich der gestrippte Build gegen pio verglichen, mit einer Maske auf genau diese Felder.
2. **AVR mit LTO bricht das Lazy-Linking.**
   - Nach der LTO-Codegenerierung zieht ld über `-pass-through=-lgcc/-lm/-lc` weitere Member nach, z. B. `__udivmodsi4`, `_clear_bss` oder `malloc`. Die stehen im IR-Symboltab nicht.
   - Ohne LTO (Entscheidung 9) ist alles exakt.
   - Flash-Mehrbedarf ohne LTO: Blink 924 → 1 058 B (+134), SSD1306 13 200 → 13 810 B (+610, +4,6 %).
3. **Linkerskripte ziehen nur über `ENTRY`.**
   - Die IDF-Skripte enthalten kein `EXTERN` und kein `INPUT`.
   - ROM-Zuweisungen wie `ets_printf = 0x…` verhindern keine Archiv-Member, weil die `-T`-Skripte hinter den Eingaben stehen.
   - `KEEP` wirkt nur auf `--gc-sections`, nicht auf die Auswahl der Member.
4. **Gruppen-Rescan:** ld wiederholt den Durchlauf, solange er *neue undefinierte Namen* erzeugt (`undefs_tail`). Es reicht nicht, dass neue Member dazukommen.
5. **Schwache und gemeinsame Symbole:**
   - Ein schwach undefiniertes Symbol lädt nie einen Member.
   - Ein COMMON-Symbol lädt nur einen Member mit echter globaler Definition.
   - `-u`-Wurzeln werden nicht ge-`--wrap`t.
6. **Blink zieht schon ~95 % von WiFi.** Das spricht für ein gecachtes Basis-Blob pro Board plus kleine Delta-Abrufe statt hunderter Einzel-Requests. Jede Datei einzeln komprimiert kostet ~30 % mehr als ein Blob.

## Dateien und Ausführung
Alle Dateien liegen in `spike/link/`. Sie brauchen nur `node:*` und laufen mit `node x.ts` (Node ≥ 23) oder `npx tsx`.

| Datei | Zweck |
|---|---|
| `config.json` | Eingaben: Boards, Bibliotheken, Toolchains, Sketches |
| `sketches/*.ino` | Test-Sketches |
| `projects.ts` | Bibliotheken installieren, pio-Projekte schreiben, `pio run -v` |
| `capture.ts` | collect2-argv und Map holen, Gegenprobe ld direkt == pio |
| `ar.ts`, `elf.ts` | ar lesen und schreiben samt Armap, ELF-Symbole |
| `ldargs.ts` | ld-argv in geordnete Eingaben zerlegen |
| `resolve.ts` | der Resolver, rein und browser-tauglich |
| `inputs.ts` | Dateien in Resolver-Eingaben umwandeln, `STRIP=strip\|rm` |
| `validate.ts` | Resolver gegen Map, Mini-Archive, Re-Link, Vergleich |
| `ablation.ts` | welche ld-Regel wie viel ausmacht |
| `sizes.ts` | Download-Größen und Symbol-Index |
| `headers.ts` | Header-Bundle |

**Reihenfolge:** `projects.ts` → `capture.ts <sketch> <board>` je Build → `validate.ts` (zusätzlich `STRIP=strip`) → `ablation.ts` → `sizes.ts` → `headers.ts`.

**Umgebung:** `LINK_SCRATCH`, `PIO`, `PLATFORMIO_PACKAGES_DIR`, `LINK_CONFIG`.
