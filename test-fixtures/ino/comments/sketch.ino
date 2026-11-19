/* Header comment
   spanning lines */
#include <Wire.h>   // I2C
#define PIN   4   /* the pin */
#define SQ(x)   ((x) * (x))   // square
const char *url = "http://example.com/*not a comment*/";  // trailing
char quote = '"';  char apos = '\'';
long big = 1'000'000;
int   spaced    =    3   ;

void setup()   {   // brace comment
	pinMode(PIN, OUTPUT);	// tab
  /* inline */ digitalWrite(PIN, /* mid */ HIGH);
  int a = 1 /* multi
  line */ + 2;
}
/* before */ void loop() { }
int helper(int a, int b) /* c */ { return a + b; }
