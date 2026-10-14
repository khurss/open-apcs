#include "led_transport.h"
#ifdef ESP_PLATFORM
#include "lwip/sockets.h"
#include "lwip/tcp.h"
#else
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#endif

bool apcs_tcp_no_delay(int socket_fd) {
  int enabled = 1;
  return socket_fd >= 0 && setsockopt(socket_fd, IPPROTO_TCP, TCP_NODELAY, &enabled, sizeof(enabled)) == 0;
}
