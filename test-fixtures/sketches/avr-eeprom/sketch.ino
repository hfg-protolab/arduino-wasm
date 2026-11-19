#include <avr/eeprom.h>
#include <avr/pgmspace.h>

uint8_t EEMEM bootCount = 7;
uint16_t EEMEM table[4] = {1, 2, 3, 4};
const char greeting[] PROGMEM = "Hallo aus dem Flash";
volatile uint32_t ticks;
char buffer[64];

void setup() {
  Serial.begin(9600);
  uint8_t n = eeprom_read_byte(&bootCount);
  eeprom_write_byte(&bootCount, n + 1);
  strcpy_P(buffer, greeting);
  Serial.println(buffer);
  Serial.println(eeprom_read_word(&table[2]));
}

void loop() {
  ticks++;
  if (ticks % 100000 == 0) report(ticks);
}

void report(uint32_t t) {
  String s = String("t=") + t;
  Serial.println(s);
}
