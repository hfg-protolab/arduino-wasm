typedef void (*Handler)(int);

void onA(int v);
Handler handlers[] = { (Handler)&onB };

int lookup(int (&arr)[3]) { return arr[0]; }

void setup() {
  handlers[0](1);
}

void loop() {}

void onB(int v) { Serial.println(v); }
