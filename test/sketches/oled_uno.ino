#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
Adafruit_SSD1306 display(128, 64, &Wire, -1);
void setup() { pinMode(LED_BUILTIN, OUTPUT); display.begin(SSD1306_SWITCHCAPVCC, 0x3C); }
void loop() {
  digitalWrite(LED_BUILTIN, HIGH); display.clearDisplay(); display.setTextSize(2);
  display.setTextColor(SSD1306_WHITE); display.setCursor(0,0); display.println("Hallo"); display.display();
  delay(500); digitalWrite(LED_BUILTIN, LOW); delay(500);
}
