# 1 "tmpfixture"
#include <Arduino.h>
# 1 "/work/project/src/sketch.ino"
#ifndef LED
#define LED 13
#endif
#if defined(ARDUINO_ARCH_AVR) && LED > 2
  #define FAST 1
#else
#define FAST 0
#endif
#undef FAST
#pragma GCC optimize ("Os")
#warning "careful"
#define F2(a,b,...) do { f(a, b, ## __VA_ARGS__); } while (0)
#define EMPTY 
#define STR(x) #x
#define CAT(a,b) a ## b
# 26 "/work/project/src/sketch.ino"
int farAway = 1;
void setup();
void loop();
#line 28 "/work/project/src/sketch.ino"
void setup() { pinMode(LED, OUTPUT); }



void loop() {
  digitalWrite(LED, HIGH);
}