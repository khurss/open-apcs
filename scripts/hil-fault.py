#!/usr/bin/env python3
"""Host-only Docker orchestration for the explicit GPIO18 bench, never ordinary CI.

The measurement container has no Docker socket. It can request only the chosen
fault and its restoration, using a unique handshake in the artifact directory.
"""
import json
import os
from pathlib import Path
import signal
import select
import stat
import subprocess
import sys
import time
import uuid

IDF = "espressif/idf:v5.5.1@sha256:cbc2e2ec2afee95f1cfa14acfa3bb6cc69a51816537fe0234f4429e71a881066"
RESET = """
import serial, time
print('APCS_RESET_READY', flush=True)
if input() != 'RESET':
    raise RuntimeError('Explicit reset token required')
with serial.Serial('/dev/bench-serial', 115200, timeout=0.2) as port:
    port.dtr = False
    port.rts = True
    time.sleep(0.1)
    port.reset_input_buffer()
    port.rts = False
    deadline = time.monotonic() + 12
    data = b''
    while time.monotonic() < deadline:
        data = (data + port.read(4096))[-32768:]
        if b'rst:' in data and b'LED bench endpoint started' in data:
            print('USB reset confirmed by ROM boot and application startup messages.')
            break
    else:
        raise RuntimeError('Could not confirm ESP32 ROM boot and application startup')
"""


def docker(*args, **kwargs):
    return subprocess.run(["docker", *args], check=True, timeout=30, **kwargs)


def main():
    mode = sys.argv[1] if len(sys.argv) == 2 else ""
    if mode not in ("broker-loss", "device-reset"):
        raise ValueError("Expected broker-loss or device-reset")
    root = Path(__file__).resolve().parent.parent
    artifacts = Path(os.environ["APCS_BENCH_ARTIFACTS"]).resolve(strict=True)
    token = uuid.uuid4().hex
    name = "open-apcs-hil-" + token
    broker = os.environ.get("APCS_BENCH_BROKER", "")
    serial_device = os.environ.get("APCS_SERIAL_DEVICE", "")
    if mode == "broker-loss":
        inspected = json.loads(docker("inspect", broker, capture_output=True, text=True).stdout)[0]
        labels = inspected["Config"]["Labels"]
        if (labels.get("com.docker.compose.project") != "open-apcs-bench"
                or labels.get("com.docker.compose.service") != "physical-mqtt"
                or not inspected["State"]["Running"] or inspected["State"]["Paused"]):
            raise ValueError("Select a running, unpaused dedicated open-apcs-bench physical-mqtt container")
        # Pin the inspected container, even if its name is reassigned during a run.
        broker = inspected["Id"]
    else:
        serial_device = str(Path(serial_device).resolve(strict=True))
        if not stat.S_ISCHR(os.stat(serial_device).st_mode) or not serial_device.startswith("/dev/ttyUSB"):
            raise ValueError("Select the reviewed ESP32 USB serial character device")
        docker("image", "inspect", IDF, stdout=subprocess.DEVNULL)

    environment = {**os.environ, "APCS_HIL_MODE": mode, "APCS_FAULT_TOKEN": token}
    reset_job = None
    reset_name = name + "-reset"
    if mode == "device-reset":
        reset_job = subprocess.Popen(["docker", "run", "--rm", "-i", "--name", reset_name, "--network", "none", "--device", serial_device + ":/dev/bench-serial", "--user", "1000:1000", "--group-add", str(os.stat(serial_device).st_gid), "-e", "HOME=/tmp", IDF, "python", "-u", "-c", RESET], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        ready_by, output = time.monotonic() + 30, b""
        try:
            while not output.endswith(b"APCS_RESET_READY\n"):
                if time.monotonic() > ready_by or reset_job.poll() is not None:
                    raise TimeoutError("Reset helper did not become ready")
                if select.select([reset_job.stdout], [], [], 0.2)[0]:
                    output = (output + os.read(reset_job.stdout.fileno(), 1))[-4096:]
        except BaseException:
            docker("stop", "--time", "1", reset_name, stdout=subprocess.DEVNULL)
            reset_job.wait(timeout=10)
            raise
    child = subprocess.Popen(["docker", "compose", "-f", "compose.hil.yml", "run", "--rm", "--name", name, "rigol-led"], cwd=root, env=environment)
    paused = False
    handled = set()
    files = []
    deadline = time.monotonic() + 120

    def interrupted(_signal, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    try:
        while child.poll() is None:
            if time.monotonic() > deadline:
                raise TimeoutError("Host HIL deadline exceeded")
            for action in ("inject", "restore"):
                prefix = artifacts / f"fault-{token}-{action}"
                request, ack = Path(str(prefix) + ".request"), Path(str(prefix) + ".ack")
                if action in handled or not request.exists():
                    continue
                handled.add(action)
                files.extend([request, ack])
                reply = {"ok": False}
                try:
                    if request.stat().st_size > 256 or json.loads(request.read_text()) != {"mode": mode, "action": action}:
                        raise ValueError("Invalid fault request")
                    if action == "restore" and "inject" not in handled:
                        raise ValueError("Restoration requested before injection")
                    if mode == "broker-loss":
                        if action == "inject":
                            # Cleanup is required even if Docker changes state then the CLI fails.
                            paused = True
                            docker("pause", broker, stdout=subprocess.DEVNULL)
                        else:
                            docker("unpause", broker, stdout=subprocess.DEVNULL)
                            paused = False
                    elif action == "inject":
                        output, _ = reset_job.communicate(b"RESET\n", timeout=20)
                        if reset_job.returncode:
                            raise RuntimeError("USB reset helper failed")
                        print(output.decode(), end="", flush=True)
                    reply = {"ok": True}
                except Exception:
                    reply = {"ok": False}
                    raise
                finally:
                    temporary = Path(str(ack) + ".tmp")
                    temporary.write_text(json.dumps(reply))
                    temporary.replace(ack)
            time.sleep(0.1)
        if child.returncode or handled != {"inject", "restore"}:
            raise RuntimeError("Hardware scenario did not complete successfully")
    finally:
        try:
            if paused:
                docker("unpause", broker, stdout=subprocess.DEVNULL)
        finally:
            try:
                if child.poll() is None:
                    # Stop the named container, not only the attached Compose client.
                    docker("stop", "--time", "25", name, stdout=subprocess.DEVNULL)
                    child.wait(timeout=30)
            finally:
                try:
                    if reset_job is not None and reset_job.poll() is None:
                        docker("stop", "--time", "1", reset_name, stdout=subprocess.DEVNULL)
                        reset_job.wait(timeout=10)
                finally:
                    for path in files:
                        path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
