#ifndef LED_BUILTIN
#define LED_BUILTIN 2
#endif
void setup() { pinMode(LED_BUILTIN, OUTPUT); Serial.begin(115200); }
void loop() { digitalWrite(LED_BUILTIN, HIGH); delay(200); Serial.println("tick"); digitalWrite(LED_BUILTIN, LOW); delay(800); }
