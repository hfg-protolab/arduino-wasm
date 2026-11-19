// Grüße – „Test“ ✓
const char *msg = "Größe: 5 µs – ok ✓";
/* äöü */ int zähler = 0; // ß

void setup() {
  Serial.begin(115200);
  Serial.println(msg);
}

void loop() { zeige(1); }

void zeige(int n) { Serial.println(n); }
