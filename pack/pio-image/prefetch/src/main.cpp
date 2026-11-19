// Template sketch of the aihub-pio image build (prefetch/platformio.ini): compiling it once
// per board pulls the platform, toolchain and Arduino core into the image.
#include <Arduino.h>

void setup() {
    Serial.begin(9600);
}

void loop() {
    Serial.println("aihub");
    delay(1000);
}
