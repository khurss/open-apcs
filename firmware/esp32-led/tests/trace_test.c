#include "led_trace.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
int main(void) {
  assert(apcs_trace_hash("hello",5)==1335831723u);
  assert(apcs_trace_hash("",0)==2166136261u);
  char out[256]; apcs_trace_event e={.sequence=4,.at_us=12000,.event=APCS_TRACE_RX,.hash=1335831723,.size=5,.message_id=17,.dropped=2};
  assert(apcs_trace_format(&e,out,sizeof(out)));
  assert(strstr(out,"\"event\":\"rx\"") && strstr(out,"\"atUs\":12000") && strstr(out,"\"dropped\":2"));
  assert(!strstr(out,"hello"));
  assert(!apcs_trace_format(&e,out,5));
  e.event=99; assert(!apcs_trace_format(&e,out,sizeof(out)));
  puts("Firmware trace: 7 checks, 0 failures");
}
