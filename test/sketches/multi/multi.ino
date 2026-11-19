#include "blinker.h"
#include <EEPROM.h>

Blinker led(LED_BUILTIN);

void setup() {
  led.begin();
  Serial.begin(9600);
}

void loop() {
  led.toggle();
  Serial.println(add3(EEPROM.read(0)));
  delay(250);
}
