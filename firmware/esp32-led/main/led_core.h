#ifndef APCS_LED_CORE_H
#define APCS_LED_CORE_H
#include <stdbool.h>
#include <stddef.h>
#define APCS_ID_SIZE 129
#define APCS_COMMAND_CAPACITY 128
/* Portable state machine. The caller supplies monotonic milliseconds and applies output after every operation. */
typedef struct { char id[APCS_ID_SIZE]; char session[APCS_ID_SIZE]; double expires; bool value; } apcs_applied;
typedef struct {
  char boot[APCS_ID_SIZE], session[APCS_ID_SIZE], nonce[APCS_ID_SIZE];
  double now, probe_at, lease_until, last_lease;
  bool output, faulted, pending;
  unsigned applied_count;
  unsigned long long sequence;
  apcs_applied applied[APCS_COMMAND_CAPACITY];
} apcs_led;
bool apcs_identifier(const char *value);
bool apcs_init(apcs_led *led, const char *boot);
void apcs_tick(apcs_led *led, double now);
void apcs_disconnect(apcs_led *led);
/* Report output changes promptly and retain an unchanged-state heartbeat. */
bool apcs_report_due(const apcs_led *led, bool reported_output, double last_report, double now);
bool apcs_probe(apcs_led *led, const char *nonce, double now);
bool apcs_lease(apcs_led *led, const char *nonce, const char *boot, const char *session, double expires, double now);
/* NULL means applied (including an identical retry); otherwise returns a static diagnostic. */
const char *apcs_write(apcs_led *led, const char *id, const char *boot, const char *session, double expires, bool value, double now);
#endif
