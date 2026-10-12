#include "led_codec.h"
#include "cJSON.h"
#include <math.h>
#include <string.h>
#include <limits.h>
static const cJSON *item(const cJSON *root, const char *key) { return cJSON_GetObjectItemCaseSensitive(root, key); }
static const char *text(const cJSON *root, const char *key) { const cJSON *value = item(root, key); return cJSON_IsString(value) ? value->valuestring : NULL; }
static bool fields(const cJSON *root, const char *const *keys, size_t count) {
  if (!cJSON_IsObject(root) || cJSON_GetArraySize(root) != (int)count) return false;
  for (size_t i = 0; i < count; i++) if (!item(root, keys[i])) return false;
  return true;
}
static bool deadline(const cJSON *root) { const cJSON *value = item(root, "expiresAtMs"); return cJSON_IsNumber(value) && isfinite(value->valuedouble) && value->valuedouble >= 0 && value->valuedouble <= 9007199254740991.0; }
static bool emit(apcs_led *led, cJSON *root, char *reply, size_t capacity) {
  bool result = root && capacity <= INT_MAX && cJSON_PrintPreallocated(root, reply, (int)capacity, false); cJSON_Delete(root);
  if (!result) apcs_disconnect(led);
  return result;
}
static cJSON *envelope(apcs_led *led, const char *kind) {
  cJSON *root = cJSON_CreateObject(); if (!root) return NULL;
  cJSON_AddNumberToObject(root, "v", 1); cJSON_AddStringToObject(root, "kind", kind); cJSON_AddStringToObject(root, "bootId", led->boot); return root;
}
static void sample(apcs_led *led, cJSON *root, double now) {
  cJSON_AddNumberToObject(root, "deviceTimeMs", now); cJSON_AddNumberToObject(root, "sequence", (double)led->sequence++); cJSON_AddBoolToObject(root, "value", led->output);
}
bool apcs_telemetry(apcs_led *led, double now, char *reply, size_t capacity) {
  apcs_tick(led, now); if (led->faulted || !reply || capacity < 1024 || led->sequence >= 9007199254740991ULL) return false;
  cJSON *root = envelope(led, "telemetry"); if (led->session[0]) cJSON_AddStringToObject(root, "sessionId", led->session); else cJSON_AddNullToObject(root, "sessionId"); sample(led, root, now); return emit(led, root, reply, capacity);
}
bool apcs_frame(apcs_led *led, const char *data, size_t size, bool retained, double now, char *reply, size_t capacity) {
  apcs_tick(led, now);
  if (led->faulted || !data || !reply || retained || !size || size > 4096 || capacity < 1024 || memchr(data, 0, size) || led->sequence >= 9007199254740991ULL) return false;
  char payload[4097]; memcpy(payload, data, size); payload[size] = 0;
  /* cJSON exposes C strings; embedded JSON NUL cannot represent an identifier. */
  if (strstr(payload, "\\u0000")) return false;
  cJSON *root = cJSON_ParseWithLengthOpts(payload, size + 1, NULL, true); if (!root) return false;
  const cJSON *version = item(root, "v"); const char *kind = text(root, "kind"); cJSON *output = NULL;
  if (!cJSON_IsNumber(version) || version->valuedouble != 1 || !kind) goto done;
  if (!strcmp(kind, "probe")) {
    const char *keys[] = {"v", "kind", "nonce"}; const char *nonce = text(root, "nonce");
    if (!fields(root, keys, 3) || !apcs_probe(led, nonce, now)) goto done;
    output = envelope(led, "snapshot"); cJSON_AddStringToObject(output, "nonce", nonce); sample(led, output, now);
  } else if (!strcmp(kind, "lease")) {
    const char *keys[] = {"v", "kind", "nonce", "bootId", "sessionId", "expiresAtMs"};
    if (!fields(root, keys, 6) || !deadline(root) || !apcs_lease(led, text(root, "nonce"), text(root, "bootId"), text(root, "sessionId"), item(root, "expiresAtMs")->valuedouble, now)) goto done;
    output = envelope(led, "ready"); cJSON_AddStringToObject(output, "nonce", text(root, "nonce")); cJSON_AddStringToObject(output, "sessionId", led->session); cJSON_AddNumberToObject(output, "expiresAtMs", led->lease_until); sample(led, output, now);
  } else if (!strcmp(kind, "write")) {
    const char *keys[] = {"v", "kind", "id", "bootId", "sessionId", "expiresAtMs", "value"};
    if (!fields(root, keys, 7) || !deadline(root) || !apcs_identifier(text(root, "id")) || !apcs_identifier(text(root, "bootId")) || !apcs_identifier(text(root, "sessionId")) || !cJSON_IsBool(item(root, "value"))) goto done;
    bool value = cJSON_IsTrue(item(root, "value"));
    const char *error = apcs_write(led, text(root, "id"), text(root, "bootId"), text(root, "sessionId"), item(root, "expiresAtMs")->valuedouble, value, now);
    output = envelope(led, "ack"); cJSON_AddStringToObject(output, "id", text(root, "id")); cJSON_AddStringToObject(output, "sessionId", text(root, "sessionId")); cJSON_AddStringToObject(output, "status", error ? "failed" : "applied");
    if (error) cJSON_AddStringToObject(output, "reason", error); else cJSON_AddBoolToObject(output, "value", value);
  }
done:
  cJSON_Delete(root); if (!output) return false; return emit(led, output, reply, capacity);
}
