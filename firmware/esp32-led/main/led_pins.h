#ifndef APCS_LED_PINS_H
#define APCS_LED_PINS_H
#include <stdbool.h>
/* GPIO5 is an explicit onboard-LED bench exception, not a general actuator pin.
 * It is a strapping pin: reset/boot states are outside application control. */
static inline bool apcs_led_pin_allowed(int pin) {
  return pin == 5 || pin == 18 || pin == 19 || pin == 21 || pin == 22 || pin == 23 || pin == 25 || pin == 26 || pin == 27 || pin == 32 || pin == 33;
}
#endif
