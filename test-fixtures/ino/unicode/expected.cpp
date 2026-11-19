# 1 "tmpfixture"
#include <Arduino.h>
# 1 "/work/project/src/sketch.ino"

const char *msg = "Größe: 5 µs – ok ✓";
             int zähler = 0;
void setup();
void loop();
void zeige(int n);
#line 5 "/work/project/src/sketch.ino"
void setup() {
  Serial.begin(115200);
  Serial.println(msg);
}

void loop() { zeige(1); }

void zeige(int n) { Serial.println(n); }