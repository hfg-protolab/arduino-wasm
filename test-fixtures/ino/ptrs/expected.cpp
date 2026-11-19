# 1 "tmpfixture"
#include <Arduino.h>
# 1 "/work/project/src/sketch.ino"
typedef void (*Handler)(int);

void onA(int v);
void setup();
void loop();
void onB(int v);
#line 4 "/work/project/src/sketch.ino"
Handler handlers[] = { (Handler)&onB };

int lookup(int (&arr)[3]) { return arr[0]; }

void setup() {
  handlers[0](1);
}

void loop() {}

void onB(int v) { Serial.println(v); }