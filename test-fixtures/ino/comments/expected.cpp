# 1 "tmpfixture"
#include <Arduino.h>
# 1 "/work/project/src/sketch.ino"


#include <Wire.h>
#define PIN 4
#define SQ(x) ((x) * (x))
const char *url = "http://example.com/*not a comment*/";
char quote = '"'; char apos = '\'';
long big = 1'000'000;
int spaced = 3 ;
void setup();
int helper(int a, int b);
#line 11 "/work/project/src/sketch.ino"
void setup() {
 pinMode(PIN, OUTPUT);
               digitalWrite(PIN, HIGH);
  int a = 1
          + 2;
}
             void loop() { }
int helper(int a, int b) { return a + b; }