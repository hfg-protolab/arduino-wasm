# 1 "tmpfixture"
#include <Arduino.h>
# 1 "/work/project/src/sketch.ino"
const char *html = "<html>\
<body>\
</body>\
</html>";
const char *two[] = {"a\
b", "c"};
void setup();
void loop();
void tick();
#line 8 "/work/project/src/sketch.ino"
void setup() {
  Serial.print(html);
}

void loop() {
  tick();
}

void tick() {}