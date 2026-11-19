const char *html = "<html>\
<body>\
</body>\
</html>";
const char *two[] = {"a\
b", "c"};

void setup() {
  Serial.print(html);
}

void loop() {
  tick();
}

void tick() {}
