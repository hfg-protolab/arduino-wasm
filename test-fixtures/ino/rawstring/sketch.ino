const char *page = R"html(
<!-- not a comment // -->
  <p>  "quoted"  </p>
)html";

void setup() { Serial.print(page); }
void loop() { step(); }
void step() {}
