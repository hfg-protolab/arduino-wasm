# 1 "tmpfixture"
#include <Arduino.h>
# 1 "/work/project/src/sketch.ino"
#include <Arduino.h>

void declared(int x);
int *makePtr(int &ref);
unsigned long ticks(void);

template <typename T> T maxOf(T a, T b) { return a > b ? a : b; }
void setup();
void loop();
Point origin();
#line 9 "/work/project/src/sketch.ino"
void setup() {
  declared(maxOf(1, 2));
}

void loop() {
  int v = 0;
  makePtr(v);
  if (ticks()) { }
  while (false) { }
  withDefault();
}

void declared(int x) { (void)x; }

int *makePtr(int &ref) {
  return &ref;
}

unsigned long ticks(void) { return millis(); }

static inline uint8_t readReg(uint8_t reg, uint8_t buf[4]) { return reg + buf[0]; }

void withDefault(int x = 5) { (void)x; }

const char *name(char *buf, size_t n)
{
  return buf;
}

struct Point { int x, y; };
Point origin() { return {0, 0}; }