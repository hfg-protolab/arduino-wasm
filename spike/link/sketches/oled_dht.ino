#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <DHT.h>
Adafruit_SSD1306 display(128, 64, &Wire, -1);
DHT dht(4, DHT22);
void setup() {
  Serial.begin(115200);
  dht.begin();
  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
}
void loop() {
  float t = dht.readTemperature(), h = dht.readHumidity();
  display.clearDisplay();
  display.setTextSize(2); display.setTextColor(SSD1306_WHITE); display.setCursor(0, 0);
  display.print(t); display.println(" C");
  display.print(h); display.println(" %");
  display.display();
  delay(2000);
}
