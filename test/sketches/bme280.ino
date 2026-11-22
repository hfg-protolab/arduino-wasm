#include <Wire.h>
#include <SPI.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>
Adafruit_BME280 bme;
void setup() { Serial.begin(9600); bme.begin(0x76); }
void loop() { Serial.println(bme.readTemperature()); delay(1000); }
