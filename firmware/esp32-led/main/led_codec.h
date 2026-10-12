#ifndef APCS_LED_CODEC_H
#define APCS_LED_CODEC_H
#include "led_core.h"
/* Receives one complete frame. False means rejected/no reply. Replies fit within 4096 bytes. */
bool apcs_frame(apcs_led *led, const char *data, size_t size, bool retained, double now, char *reply, size_t capacity);
bool apcs_telemetry(apcs_led *led, double now, char *reply, size_t capacity);
#endif
