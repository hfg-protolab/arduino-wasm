# 1 "tmpfixture"
#include <Arduino.h>
# 1 "/work/project/src/b.ino"
void setup();
void loop();
void first();
void second();
#line 1 "/work/project/src/b.ino"
void setup() { first(); }
# 1 "/work/project/src/a.ino"
void loop() { second(); }
void first() {}
# 1 "/work/project/src/c.ino"
void second() {}