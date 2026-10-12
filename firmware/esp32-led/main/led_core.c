#include "led_core.h"
#include <math.h>
#include <string.h>
static bool timestamp(double value) { return isfinite(value) && value >= 0 && value <= 9007199254740991.0; }
bool apcs_identifier(const char *value) {
  if (!value || !value[0]) return false;
  for (size_t i = 0; i < APCS_ID_SIZE; i++) {
    unsigned char c = (unsigned char)value[i]; if (!c) return true;
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-')) return false;
  }
  return false;
}
void apcs_disconnect(apcs_led *led) { led->output = false; led->session[0] = 0; led->pending = false; led->nonce[0] = 0; led->lease_until = 0; }
bool apcs_init(apcs_led *led, const char *boot) {
  memset(led, 0, sizeof(*led)); led->last_lease = -1;
  if (!apcs_identifier(boot)) { led->faulted = true; return false; }
  strcpy(led->boot, boot); return true;
}
void apcs_tick(apcs_led *led, double now) {
  if (!timestamp(now) || now < led->now) { led->faulted = true; apcs_disconnect(led); return; }
  led->now = now;
  if (led->session[0] && now >= led->lease_until) { led->output = false; led->session[0] = 0; led->lease_until = 0; }
}
bool apcs_probe(apcs_led *led, const char *nonce, double now) {
  apcs_tick(led, now);
  if (led->faulted || !apcs_identifier(nonce) || (led->pending && strcmp(nonce, led->nonce) == 0)) return false;
  strcpy(led->nonce, nonce); led->probe_at = now; led->pending = true; return true;
}
bool apcs_lease(apcs_led *led, const char *nonce, const char *boot, const char *session, double expires, double now) {
  apcs_tick(led, now);
  if (led->faulted || !apcs_identifier(nonce) || !apcs_identifier(boot) || !apcs_identifier(session) || !timestamp(expires) || !led->pending || strcmp(nonce, led->nonce) || strcmp(boot, led->boot) || expires <= now || expires > led->probe_at + 3000 || expires <= led->last_lease) return false;
  if (strcmp(led->session, session)) led->output = false;
  strcpy(led->session, session); led->pending = false; led->lease_until = expires; led->last_lease = expires; return true;
}
const char *apcs_write(apcs_led *led, const char *id, const char *boot, const char *session, double expires, bool value, double now) {
  apcs_tick(led, now);
  if (led->faulted) return "Device clock fault; reboot required";
  if (!apcs_identifier(id) || !apcs_identifier(boot) || !apcs_identifier(session) || !timestamp(expires)) return "Invalid write";
  if (strcmp(boot, led->boot)) return "Boot session changed";
  if (!led->session[0] || strcmp(session, led->session)) return "No active control lease";
  if (expires <= now) return "Command expired";
  if (expires > led->lease_until) return "Command exceeds control lease";
  for (unsigned i = 0; i < led->applied_count; i++) {
    const apcs_applied *prior = &led->applied[i];
    if (!strcmp(prior->id, id)) return strcmp(prior->session, session) || prior->expires != expires || prior->value != value ? "Command ID conflict" : NULL;
  }
  if (led->applied_count >= APCS_COMMAND_CAPACITY) return "Command cache full; reboot required";
  apcs_applied *saved = &led->applied[led->applied_count++]; strcpy(saved->id, id); strcpy(saved->session, session); saved->expires = expires; saved->value = value;
  led->output = value; return NULL;
}
