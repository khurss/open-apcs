#include "led_codec.h"
#include "cJSON.h"
#include <stdio.h>
#include <string.h>
static apcs_led led;
int main(void) {
  apcs_init(&led, "native-boot"); char line[16384], reply[4096];
  while (fgets(line, sizeof(line), stdin)) {
    cJSON *input = cJSON_Parse(line); const cJSON *now = cJSON_GetObjectItemCaseSensitive(input, "now"); const cJSON *frame = cJSON_GetObjectItemCaseSensitive(input, "frame");
    if (!cJSON_IsNumber(now) || !cJSON_IsString(frame)) { cJSON_Delete(input); return 2; }
    bool emitted = apcs_frame(&led, frame->valuestring, strlen(frame->valuestring), cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(input, "retained")), now->valuedouble, reply, sizeof(reply));
    cJSON *output = cJSON_CreateObject(); cJSON_AddItemToObject(output, "reply", emitted ? cJSON_Parse(reply) : cJSON_CreateNull()); cJSON_AddBoolToObject(output, "output", led.output);
    char *serialized = cJSON_PrintUnformatted(output); if (!serialized) return 3; puts(serialized); fflush(stdout); cJSON_free(serialized); cJSON_Delete(output); cJSON_Delete(input);
  }
  return 0;
}
