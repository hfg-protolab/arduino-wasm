#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
void setup() {
  Serial.begin(115200);
  WiFi.begin("ssid", "password");
  while (WiFi.status() != WL_CONNECTED) delay(500);
  WiFiClient client;
  HTTPClient http;
  http.begin(client, "http://example.com/");
  int code = http.GET();
  Serial.println(code);
  Serial.println(http.getString());
  http.end();
}
void loop() {}
