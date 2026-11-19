# 1 "tmpfixture"
#include <Arduino.h>
# 1 "/work/project/src/sketch.ino"

#define LED 2
void setup();
void loop();
void blink(int n);
#line 4 "/work/project/src/sketch.ino"
void setup()
{
 pinMode(LED, OUTPUT);
  blink(3);
}

void loop() {}

void blink(int n) {
  for (int i = 0; i < n; i++) {
    digitalWrite(LED, i & 1);
  }
}