"""Fault-injection cleanup checks; fake Docker only, no physical devices."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("hil_fault", Path(__file__).parents[2] / "scripts/hil-fault.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class OrchestratorTest(unittest.TestCase):
    def exercise(self, *, malformed=False, pause_failure=False, worker_failure=False, pre_paused=False):
        calls = []
        with tempfile.TemporaryDirectory() as directory:
            def docker(*args, **kwargs):
                calls.append(args)
                if args[0] == "inspect":
                    return subprocess.CompletedProcess(args, 0, json.dumps([{
                        "Id": "selected-container-id",
                        "Config": {"Labels": {"com.docker.compose.project": "open-apcs-bench", "com.docker.compose.service": "physical-mqtt"}},
                        "State": {"Running": True, "Paused": pre_paused},
                    }]))
                if args[0] == "pause" and pause_failure:
                    raise subprocess.CalledProcessError(1, args)
                return subprocess.CompletedProcess(args, 0)

            class Child:
                returncode = None
                step = 0

                def __init__(self, args, **kwargs):
                    self.token = kwargs["env"]["APCS_FAULT_TOKEN"]

                def poll(self):
                    if self.returncode is not None:
                        return self.returncode
                    if self.step == 2 or (worker_failure and self.step == 1):
                        self.returncode = 1 if worker_failure else 0
                        return self.returncode
                    action = ("inject", "restore")[self.step]
                    request = Path(directory) / f"fault-{self.token}-{action}.request"
                    request.write_text(json.dumps({"mode": "unexpected" if malformed else "broker-loss", "action": action}))
                    self.step += 1
                    return None

                def wait(self, **kwargs):
                    self.returncode = 1

            environment = {"APCS_BENCH_ARTIFACTS": directory, "APCS_BENCH_BROKER": "reviewed-broker"}
            with patch.dict(runner.os.environ, environment), patch.object(runner.sys, "argv", ["hil-fault.py", "broker-loss"]), patch.object(runner, "docker", docker), patch.object(runner.subprocess, "Popen", Child), patch.object(runner.time, "sleep"), patch.object(runner.signal, "signal"):
                try:
                    runner.main()
                except (ValueError, RuntimeError, subprocess.CalledProcessError) as error:
                    return calls, error
        return calls, None

    def test_success_restores_only_the_inspected_container(self):
        calls, error = self.exercise()
        self.assertIsNone(error)
        self.assertEqual([c for c in calls if c[0] in ("pause", "unpause")], [("pause", "selected-container-id"), ("unpause", "selected-container-id")])

    def test_worker_failure_still_restores_broker(self):
        calls, error = self.exercise(worker_failure=True)
        self.assertIsInstance(error, RuntimeError)
        self.assertIn(("unpause", "selected-container-id"), calls)

    def test_pause_cli_failure_still_attempts_restore_and_stops_worker(self):
        calls, error = self.exercise(pause_failure=True)
        self.assertIsInstance(error, subprocess.CalledProcessError)
        self.assertIn(("unpause", "selected-container-id"), calls)
        self.assertTrue(any(c[0] == "stop" for c in calls))

    def test_invalid_request_never_injects(self):
        calls, error = self.exercise(malformed=True)
        self.assertIsInstance(error, ValueError)
        self.assertFalse(any(c[0] in ("pause", "unpause") for c in calls))

    def test_previously_paused_broker_is_not_claimed(self):
        calls, error = self.exercise(pre_paused=True)
        self.assertIsInstance(error, ValueError)
        self.assertEqual([c[0] for c in calls], ["inspect"])


if __name__ == "__main__":
    unittest.main()
