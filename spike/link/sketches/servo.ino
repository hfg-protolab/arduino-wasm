#include <ESP32Servo.h>
Servo s;
void setup() { s.attach(13); }
void loop() { for (int a = 0; a <= 180; a += 5) { s.write(a); delay(20); } for (int a = 180; a >= 0; a -= 5) { s.write(a); delay(20); } }
