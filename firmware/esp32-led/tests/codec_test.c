#include "led_codec.h"
#include "cJSON.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static int checks, failures;
#define CHECK(expr) do { checks++; if (!(expr)) { failures++; fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #expr); } } while(0)
static apcs_led led;
static char reply[4096];
static bool frame(const char *data, bool retained, double now) { return apcs_frame(&led, data, strlen(data), retained, now, reply, sizeof(reply)); }
int main(void) {
  apcs_init(&led, "codec-boot");
  const char *probe = "{\"v\":1,\"kind\":\"probe\",\"nonce\":\"nonce\"}";
  CHECK(!frame(probe, true, 100)); CHECK(frame(probe, false, 100));
  cJSON *json = cJSON_Parse(reply); CHECK(json != NULL); CHECK(cJSON_GetObjectItemCaseSensitive(json, "sequence") != NULL); cJSON_Delete(json);
  CHECK(!frame("{\"v\":1,\"kind\":\"probe\",\"nonce\":\"n\",\"extra\":true}", false, 100));
  CHECK(!frame("{\"v\":1,\"kind\":\"probe\",\"nonce\":\"n\",\"nonce\":\"n\"}", false, 100));
  CHECK(!frame("{\"v\":1,\"kind\":\"probe\",\"nonce\":\"n\\u0000suffix\"}", false, 100));
  CHECK(!frame("{\"v\":1,\"kind\":\"probe\",\"nonce\":\"n\"} garbage", false, 100));
  CHECK(!frame("{\"v\":2,\"kind\":\"probe\",\"nonce\":\"n\"}", false, 100));
  CHECK(!frame("{\"v\":1,\"kind\":\"probe\",\"nonce\":null}", false, 100));
  CHECK(frame("{\"v\":1,\"kind\":\"lease\",\"nonce\":\"nonce\",\"bootId\":\"codec-boot\",\"sessionId\":\"session\",\"expiresAtMs\":3100}", false, 110));
  CHECK(frame("{\"v\":1,\"kind\":\"write\",\"id\":\"command\",\"bootId\":\"codec-boot\",\"sessionId\":\"session\",\"expiresAtMs\":1000.5,\"value\":true}", false, 120)); CHECK(led.output);
  CHECK(!frame("{\"v\":1,\"kind\":\"write\",\"id\":\"bad\",\"bootId\":\"codec-boot\",\"sessionId\":\"session\",\"expiresAtMs\":1000,\"value\":1}", false, 120));
  CHECK(apcs_telemetry(&led, 3100, reply, sizeof(reply))); CHECK(!led.output);
  json = cJSON_Parse(reply); CHECK(cJSON_IsFalse(cJSON_GetObjectItemCaseSensitive(json, "value"))); CHECK(cJSON_IsNull(cJSON_GetObjectItemCaseSensitive(json, "sessionId"))); cJSON_Delete(json);
  char oversized[4097]; memset(oversized, ' ', sizeof(oversized)); CHECK(!apcs_frame(&led, oversized, sizeof(oversized), false, 3100, reply, sizeof(reply)));
  CHECK(!apcs_telemetry(&led, 3101, reply, 1));
  printf("Firmware codec: %d checks, %d failures\n", checks, failures); return failures ? EXIT_FAILURE : EXIT_SUCCESS;
}
