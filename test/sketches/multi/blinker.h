#pragma once
#include <Arduino.h>

class Blinker {
 public:
  explicit Blinker(uint8_t pin) : pin_(pin) {}
  void begin();
  void toggle();
 private:
  uint8_t pin_;
  bool on_ = false;
};

extern "C" int add3(int x);
