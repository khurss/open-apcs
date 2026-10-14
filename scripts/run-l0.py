#!/usr/bin/env python3
"""Record host/Docker resources while the supervised Docker L0 workload runs."""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import uuid


def read(*args):
    return subprocess.check_output(args, text=True, timeout=15).strip()


def main():
    root = Path(__file__).resolve().parent.parent
    os.chdir(root)
    profile = os.environ.get("APCS_L0_PROFILE", "led-16")
    if profile not in ("led-16", "mixed-200"):
        raise ValueError("Unknown L0 profile")
    seconds = int(os.environ.get("APCS_L0_SECONDS", "3600"))
    if not 60 <= seconds <= 3600:
        raise ValueError("L0 duration must be 60–3600 seconds")
    artifacts = Path(os.environ["APCS_BENCH_ARTIFACTS"]).resolve(strict=True)
    run_id = uuid.uuid4().hex
    directory = artifacts / ("l0-host-" + run_id)
    directory.mkdir()
    name = "open-apcs-l0-" + run_id
    source = hashlib.sha256()
    for filename in sorted(read("git", "ls-files", "-co", "--exclude-standard").splitlines()):
        path = Path(filename)
        if path.is_file() and path.suffix != ".md":
            source.update(filename.encode() + b"\0" + path.read_bytes() + b"\0")
    ids = []
    for project in ("open-apcs-dev", "open-apcs-bench"):
        ids.extend(read("docker", "ps", "-q", "--filter", "label=com.docker.compose.project=" + project).splitlines())
    inspected = json.loads(read("docker", "inspect", *ids))
    placement = [{"name": c["Name"], "image": c["Image"], "memoryLimit": c["HostConfig"]["Memory"], "nanoCpus": c["HostConfig"]["NanoCpus"], "pidsLimit": c["HostConfig"].get("PidsLimit")} for c in inspected]
    disk = os.statvfs(root)
    metadata = {"runId": run_id, "profile": profile, "requestedSeconds": seconds, "revision": read("git", "rev-parse", "HEAD"), "dirty": bool(read("git", "status", "--porcelain")), "sourceSha256": source.hexdigest(), "cpu": json.loads(read("lscpu", "--json")), "kernel": read("uname", "-r"), "docker": json.loads(read("docker", "version", "--format", "{{json .Server}}")), "placement": placement, "freeBytesBefore": disk.f_bavail * disk.f_frsize}
    if metadata["freeBytesBefore"] < 2 * 1024 ** 3:
        raise RuntimeError("At least 2 GiB of free space is required for this bounded workload")
    (directory / "metadata.json").write_text(json.dumps(metadata, indent=2))
    child = subprocess.Popen(["docker", "compose", "-f", "compose.load.yml", "run", "--rm", "--name", name, "l0"], env={**os.environ, "APCS_L0_RUN_ID": run_id})
    deadline = time.monotonic() + seconds + 660
    next_sample = time.monotonic() + 10

    def interrupted(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    try:
        while child.poll() is None:
            if time.monotonic() >= deadline:
                raise TimeoutError("L0 host deadline exceeded")
            if time.monotonic() >= next_sample:
                next_sample = time.monotonic() + 30
                try:
                    stats = [json.loads(line) for line in read("docker", "stats", "--no-stream", "--format", "{{json .}}", *ids, name).splitlines()]
                except subprocess.CalledProcessError:
                    if child.poll() is not None:
                        break
                    raise
                with (directory / "resources.jsonl").open("a") as stream:
                    stream.write(json.dumps({"at": time.time(), "loadAverage": os.getloadavg(), "containers": stats}) + "\n")
            time.sleep(1)
        if child.returncode:
            raise RuntimeError("L0 workload failed; inspect its preserved result")
    finally:
        try:
            if child.poll() is None:
                subprocess.run(["docker", "stop", "--time", "40", name], check=True, timeout=50)
                child.wait(timeout=15)
        finally:
            disk = os.statvfs(root)
            (directory / "host-result.json").write_text(json.dumps({"at": time.time(), "exitCode": child.returncode, "freeBytesAfter": disk.f_bavail * disk.f_frsize}, indent=2))
            print("L0 host evidence: " + str(directory), flush=True)

    if seconds == 3600:
        subprocess.run(["docker", "compose", "-f", "compose.load.yml", "run", "--rm", "--no-deps", "l0", "node", "--import", "/workspace/apps/api/node_modules/tsx/dist/loader.mjs", "tests/load/report-resources.ts", "/artifacts/l0-host-" + run_id], check=True, timeout=60)


if __name__ == "__main__":
    main()
