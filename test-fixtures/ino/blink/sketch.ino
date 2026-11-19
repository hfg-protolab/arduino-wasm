// Blink with a helper defined after use
#define LED 13  /* builtin */

int counter = 0;

void setup() {
  pinMode(LED, OUTPUT);
  Serial.begin(115200);
}

void loop() {
  toggle(500);
  counter++;
  Serial.println(counter);
}

void toggle(int ms) {
  digitalWrite(LED, HIGH);
  delay(ms);
  digitalWrite(LED, LOW);
  delay(ms);
}
