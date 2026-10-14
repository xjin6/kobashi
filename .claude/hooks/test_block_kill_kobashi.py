import importlib.util
import json
import pathlib
import subprocess
import sys
import unittest


HOOK = pathlib.Path(__file__).with_name("block-kill-kobashi.py")
spec = importlib.util.spec_from_file_location("kobashi_hook", HOOK)
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)


class KobashiHookTests(unittest.TestCase):
    def run_hook(self, payload):
        return subprocess.run(
            [sys.executable, str(HOOK)],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            check=False,
        )

    def test_safe_commands_are_allowed(self):
        for command in (
            "git status --short",
            "git commit -m 'Update native UI'",
            "git push origin main",
            r"go run .\cmd\build -target windows",
            "go run ./cmd/build -target darwin",
        ):
            with self.subTest(command=command):
                result = self.run_hook({"tool_input": {"command": command}})
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_stop_commands_are_blocked_without_execution(self):
        for command in (
            "pkill -f kobashi",
            "pkill -f Kobashi.app",
            "pkill -f kobashi-arm64",
            "killall Kobashi",
            "pkill -f /Applications/Claude.app",
            "kill -9 123 # kobashi",
            "launchctl kickstart -k gui/501/com.xjin6.kobashi",
            "Stop-Process -Name Kobashi",
            "taskkill /IM Kobashi.exe /F",
            "Stop-Process -Name Claude",
        ):
            with self.subTest(command=command):
                result = self.run_hook({"tool_input": {"command": command}})
                self.assertEqual(result.returncode, 2)
                self.assertIn("BLOCKED:", result.stderr)

    def test_copilot_payload_formats(self):
        for arguments in ({"command": "killall Kobashi"}, '{"command":"killall Kobashi"}'):
            result = self.run_hook({"toolArgs": arguments})
            self.assertEqual(result.returncode, 2)

    def test_invalid_input_fails_closed(self):
        for payload in (None, {}, {"tool_input": {}}, {"tool_input": {"command": None}}):
            with self.subTest(payload=payload):
                self.assertEqual(self.run_hook(payload).returncode, 2)
        result = subprocess.run(
            [sys.executable, str(HOOK)], input="{", capture_output=True, text=True, check=False
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("could not read", result.stderr)


if __name__ == "__main__":
    unittest.main()
