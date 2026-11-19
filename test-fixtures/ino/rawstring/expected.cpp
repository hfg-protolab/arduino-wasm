# 1 "tmpfixture"
#include <Arduino.h>
# 1 "/work/project/src/sketch.ino"
const char *page = R"html(
<!-- not a comment // -->
  <p>  "quoted"  </p>
)html";
void setup();
void loop();
void step();
#line 6 "/work/project/src/sketch.ino"
void setup() { Serial.print(page); }
void loop() { step(); }
void step() {}