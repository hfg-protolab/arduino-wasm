// Main sketch
void setup() {
  Serial.begin(9600);
}

void loop() {
  Serial.println(twice(21));
  later();
}
