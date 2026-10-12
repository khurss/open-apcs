#include "led_core.h"
#include <math.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
static int checks, failures;
#define CHECK(expr) do { checks++; if (!(expr)) { failures++; fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #expr); } } while(0)
static apcs_led led;
static void armed(void) { CHECK(apcs_init(&led, "boot-1")); CHECK(!led.output); CHECK(apcs_probe(&led, "nonce-1", 100)); CHECK(apcs_lease(&led, "nonce-1", "boot-1", "session-1", 3100, 110)); }
int main(void) {
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
  printf("Firmware core: %d checks, %d failures\n", checks, failures); return failures ? EXIT_FAILURE : EXIT_SUCCESS;
}
