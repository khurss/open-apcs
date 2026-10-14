#ifndef APCS_LED_TRACE_H
#define APCS_LED_TRACE_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
typedef enum { APCS_TRACE_RX, APCS_TRACE_PROCESS, APCS_TRACE_TX_ENTER, APCS_TRACE_TX_EXIT, APCS_TRACE_ACK, APCS_TRACE_DISCONNECT } apcs_trace_kind;
typedef struct { uint32_t sequence,hash,size,dropped; uint64_t at_us; int message_id; apcs_trace_kind event; } apcs_trace_event;
uint32_t apcs_trace_hash(const char *data,size_t size);
bool apcs_trace_format(const apcs_trace_event *event,char *out,size_t capacity);
#endif
