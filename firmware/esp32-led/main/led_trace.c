#include "led_trace.h"
#include <inttypes.h>
#include <stdio.h>
uint32_t apcs_trace_hash(const char *data,size_t size) {
  uint32_t hash=2166136261u;
  for(size_t i=0;i<size;i++) hash=(hash^(unsigned char)data[i])*16777619u;
  return hash;
}
bool apcs_trace_format(const apcs_trace_event *e,char *out,size_t capacity) {
  static const char *names[]={"rx","process","tx-enter","tx-exit","ack","disconnect"};
  if(!e || !out || !capacity || (unsigned)e->event>=sizeof(names)/sizeof(names[0])) return false;
  int n=snprintf(out,capacity,"APCS_TRACE {\"v\":1,\"seq\":%" PRIu32 ",\"atUs\":%" PRIu64 ",\"event\":\"%s\",\"hash\":%" PRIu32 ",\"bytes\":%" PRIu32 ",\"messageId\":%d,\"dropped\":%" PRIu32 "}",e->sequence,e->at_us,names[e->event],e->hash,e->size,e->message_id,e->dropped);
  return n>=0 && (size_t)n<capacity;
}
