# 1 "tmpfixture"
#include <Arduino.h>
# 1 "/work/project/src/sketch.ino"

#define LED 13

int counter = 0;
void setup();
void loop();
void toggle(int ms);
#line 6 "/work/project/src/sketch.ino"
void setup() {
  pinMode(LED, OUTPUT);
  Serial.begin(115200);
}

void loop() {
  toggle(500);
  counter++;
  Serial.println(counter);
}

void toggle(int ms) {
  digitalWrite(LED, HIGH);
  delay(ms);
  digitalWrite(LED, LOW);
  delay(ms);
}