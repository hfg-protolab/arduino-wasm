// crlf
#define LED 2

void setup()
{
	pinMode(LED, OUTPUT);
		blink(3);
}

void loop() {}

void blink(int n) {
  for (int i = 0; i < n; i++) {	// loop
    digitalWrite(LED, i & 1);
  }
}
