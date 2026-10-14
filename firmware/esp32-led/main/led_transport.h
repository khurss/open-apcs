#pragma once
#include <stdbool.h>

/* Configure the connected control socket before subscribing or accepting a lease. */
bool apcs_tcp_no_delay(int socket_fd);
