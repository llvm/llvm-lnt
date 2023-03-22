#include <stdlib.h>

volatile unsigned n = 0;

__attribute__((noinline))
__attribute__((section(".text.correct")))
__attribute__((aligned(0x1000)))
void correct(long count) {
  for (long i = 0; i < count; ++i) {
    n += 1;
  }
}

int main(int argc, const char *argv[]) {
  correct(atol(argv[1]));
  return 0;
}
