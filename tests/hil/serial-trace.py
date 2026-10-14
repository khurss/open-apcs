"""Opt-in USB trace collector. No reset request, output command or raw boot-log persistence."""
import json
import os
import signal
import time
import serial

seconds = int(os.environ.get("APCS_TRACE_SECONDS", "660"))
if not 10 <= seconds <= 3900:
    raise ValueError("Trace duration must be 10–3900 seconds")
path = os.environ["APCS_TRACE_OUTPUT"]
port = serial.Serial(port=None, baudrate=115200, timeout=0.2)
port.dtr = False
port.rts = False
port.port = "/dev/bench-serial"
running = True

def stop(_signal, _frame):
    global running
    running = False

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as output, port:
    print("APCS_TRACE_READER_READY", flush=True)
    deadline = time.monotonic() + seconds
    buffer = b""
    ready = False
    while running and time.monotonic() < deadline:
        buffer += port.read(4096)
        while b"\n" in buffer:
            line, buffer = buffer.split(b"\n", 1)
            if not line.startswith(b"APCS_TRACE ") or len(line) > 1024:
                continue
            try:
                value = json.loads(line[len(b"APCS_TRACE "):])
            except (ValueError, UnicodeDecodeError):
                continue
            output.write(json.dumps({"hostAt": time.time(), "hostMonotonic": time.monotonic(), "device": value}) + "\n")
            output.flush()
            if not ready:
                print("APCS_TRACE_DATA_READY", flush=True)
                ready = True
        if len(buffer) > 4096:
            buffer = b""
print("USB trace collector stopped.", flush=True)
