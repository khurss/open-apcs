#include "led_core.h"
#include "led_pins.h"
#include <math.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
static int checks, failures;
#define CHECK(expr) do { checks++; if (!(expr)) { failures++; fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #expr); } } while(0)
static apcs_led led;
static void armed(void) { CHECK(apcs_init(&led, "boot-1")); CHECK(!led.output); CHECK(apcs_probe(&led, "nonce-1", 100)); CHECK(apcs_lease(&led, "nonce-1", "boot-1", "session-1", 3100, 110)); }
int main(void) {
  armed();
  CHECK(!apcs_report_due(&led, false, 110, 119));
  CHECK(apcs_write(&led, "report-on", "boot-1", "session-1", 2000, true, 120) == NULL);
  CHECK(apcs_report_due(&led, false, 110, 120));
  CHECK(!apcs_report_due(&led, true, 120, 121));
  CHECK(!apcs_report_due(&led, true, 120, 1119));
  CHECK(apcs_report_due(&led, true, 120, 1120));
  CHECK(apcs_write(&led, "report-off", "boot-1", "session-1", 2000, false, 1121) == NULL);
  CHECK(apcs_report_due(&led, true, 1120, 1121));
  CHECK(apcs_write(&led, "report-next", "boot-1", "session-1", 3000, true, 1122) == NULL);
  apcs_tick(&led, 3100);
  CHECK(!led.output);
  CHECK(apcs_report_due(&led, true, 3090, 3100));
  for (int pin = -1; pin <= 40; pin++) {
    bool expected = pin == 5 || pin == 18 || pin == 19 || pin == 21 || pin == 22 || pin == 23 || pin == 25 || pin == 26 || pin == 27 || pin == 32 || pin == 33;
    CHECK(apcs_led_pin_allowed(pin) == expected);
  }
  CHECK(apcs_identifier("valid_ID-123")); CHECK(!apcs_identifier("")); CHECK(!apcs_identifier("slash/value")); CHECK(!apcs_identifier(NULL));
  armed(); CHECK(apcs_write(&led, "cmd-1", "boot-1", "session-1", 1100, true, 120) == NULL); CHECK(led.output);
  apcs_tick(&led, 3099); CHECK(led.output); apcs_tick(&led, 3100); CHECK(!led.output); CHECK(!led.session[0]);
  armed(); CHECK(!apcs_lease(&led, "nonce-1", "boot-1", "session-1", 4100, 120));
  CHECK(apcs_write(&led, "wrong", "old-boot", "session-1", 1100, true, 120) != NULL); CHECK(!led.output);
  CHECK(apcs_write(&led, "wrong", "boot-1", "old-session", 1100, true, 120) != NULL); CHECK(!led.output);
  CHECK(apcs_write(&led, "expired", "boot-1", "session-1", 120, true, 120) != NULL);
  CHECK(apcs_write(&led, "cmd-1", "boot-1", "session-1", 1100, true, 120) == NULL);
  CHECK(apcs_write(&led, "cmd-2", "boot-1", "session-1", 1100, false, 121) == NULL); CHECK(!led.output);
  CHECK(apcs_write(&led, "cmd-1", "boot-1", "session-1", 1100, true, 122) == NULL); CHECK(!led.output);
  CHECK(apcs_write(&led, "cmd-1", "boot-1", "session-1", 1100, false, 123) != NULL);
  CHECK(apcs_probe(&led, "nonce-2", 1000)); CHECK(apcs_lease(&led, "nonce-2", "boot-1", "session-1", 4000, 1001));
  CHECK(apcs_write(&led, "cmd-3", "boot-1", "session-1", 2000, true, 1002) == NULL);
  CHECK(apcs_probe(&led, "nonce-3", 2000)); CHECK(apcs_lease(&led, "nonce-3", "boot-1", "session-1", 5000, 2001)); CHECK(led.output);
  CHECK(apcs_probe(&led, "nonce-4", 2100)); CHECK(apcs_lease(&led, "nonce-4", "boot-1", "new-session", 5100, 2101)); CHECK(!led.output);
  armed(); CHECK(apcs_write(&led, "cmd", "boot-1", "session-1", 2000, true, 120) == NULL); apcs_disconnect(&led); CHECK(!led.output); CHECK(!led.session[0]); CHECK(apcs_write(&led, "cmd", "boot-1", "session-1", 2000, true, 121) != NULL);
  armed(); CHECK(apcs_write(&led, "cmd", "boot-1", "session-1", 2000, true, 120) == NULL); apcs_tick(&led, 119); CHECK(led.faulted); CHECK(!led.output); CHECK(!apcs_probe(&led, "next", 200));
  armed(); apcs_tick(&led, NAN); CHECK(led.faulted); CHECK(!led.output);
  armed(); CHECK(!apcs_probe(&led, "bad/value", 120)); CHECK(!apcs_lease(&led, "unmatched", "boot-1", "session-1", 3000, 120));
  armed(); CHECK(apcs_probe(&led, "late", 3101)); CHECK(apcs_lease(&led, "late", "boot-1", "session-1", 6101, 3102)); CHECK(!led.output);
  armed(); for (unsigned i = 0; i < APCS_COMMAND_CAPACITY; i++) { char id[32]; snprintf(id, sizeof(id), "command-%u", i); CHECK(apcs_write(&led, id, "boot-1", "session-1", 2000, i % 2, 120) == NULL); }
  CHECK(apcs_write(&led, "overflow", "boot-1", "session-1", 2000, true, 120) != NULL); CHECK(led.applied_count == APCS_COMMAND_CAPACITY);
  armed();
  for (unsigned i = 0; i < APCS_COMMAND_CAPACITY; i++) { char id[32]; snprintf(id, sizeof(id), "live-%u", i); CHECK(apcs_write(&led, id, "boot-1", "session-1", i == APCS_COMMAND_CAPACITY - 1 ? 2500 : 2000, true, 120) == NULL); }
  CHECK(apcs_write(&led, "overflow", "boot-1", "session-1", 2900, false, 120) != NULL); CHECK(led.output);
  apcs_tick(&led, 2000); CHECK(led.applied_count == 1); CHECK(led.output);
  CHECK(apcs_write(&led, "next", "boot-1", "session-1", 2900, false, 2001) == NULL); CHECK(!led.output);
  CHECK(apcs_write(&led, "live-127", "boot-1", "session-1", 2500, true, 2002) == NULL); CHECK(!led.output);
  CHECK(apcs_write(&led, "live-127", "boot-1", "session-1", 2500, false, 2003) != NULL);
  CHECK(apcs_write(&led, "live-127", "boot-1", "session-1", 2500, true, 2500) != NULL); CHECK(!led.output);
  armed(); bool sustained = true;
  for (unsigned i = 0; i < 3600; i++) {
    char id[32]; snprintf(id, sizeof(id), "sustained-%u", i); double now = 120 + i * 1000;
    if (!apcs_probe(&led, id, now) || !apcs_lease(&led, id, "boot-1", "session-1", now + 3000, now + 1) || apcs_write(&led, id, "boot-1", "session-1", now + 900, i % 2, now + 2) != NULL || led.output != (bool)(i % 2) || led.applied_count > 2) { sustained = false; break; }
  }
  CHECK(sustained); CHECK(led.applied_count <= 2);
  CHECK(apcs_write(&led, "sustained-0", "boot-1", "session-1", 1020, false, led.now) != NULL); CHECK(led.output);
  printf("Firmware core: %d checks, %d failures\n", checks, failures); return failures ? EXIT_FAILURE : EXIT_SUCCESS;
}
