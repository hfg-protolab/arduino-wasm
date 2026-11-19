# 1 "tmpfixture"
#include <Arduino.h>
# 1 "/work/project/src/main.ino"
void setup();
void loop();
int twice(int x);
void later();
#line 2 "/work/project/src/main.ino"
void setup() {
  Serial.begin(9600);
}

void loop() {
  Serial.println(twice(21));
  later();
}
# 1 "/work/project/src/a_helpers.ino"
int twice(int x) {
  return 2 * x;
}
# 1 "/work/project/src/z_more.pde"
void later()
{
  delay(10);
}