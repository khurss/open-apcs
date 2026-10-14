#include "led_transport.h"
#include <assert.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <stdio.h>
#include <sys/socket.h>
#include <unistd.h>

int main(void) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  assert(fd >= 0);
  int enabled = -1; socklen_t size = sizeof(enabled);
  assert(getsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &enabled, &size) == 0 && enabled == 0);
  assert(apcs_tcp_no_delay(fd));
  assert(getsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &enabled, &size) == 0 && enabled == 1);
  assert(!apcs_tcp_no_delay(-1));
  close(fd);
  assert(!apcs_tcp_no_delay(fd));
  puts("Firmware TCP transport: 6 checks, 0 failures");
}
