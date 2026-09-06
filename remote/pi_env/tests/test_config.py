import os
import unittest
from unittest import mock

from remote.pi_env.config import DEFAULT_TIMEOUT_SECONDS, PiConfig


def make_config() -> PiConfig:
    return PiConfig(
        pi_command="pi --mode run",
        model="student-model",
        extension_path="/opt/pi-shell-specialization",
        endpoint_url="http://127.0.0.1:8000/v1",
        sandbox_root="/tmp/pi-rollouts",
        timeout_seconds=900,
    )


class ConfigTests(unittest.TestCase):
    def test_valid_config_has_no_problems(self):
        config = make_config()
        self.assertEqual(config.validate(), [])
        config.require_valid()

    def test_every_blank_string_field_is_flagged(self):
        for field in ("pi_command", "model", "extension_path", "endpoint_url", "sandbox_root"):
            with self.subTest(field=field):
                config = make_config()
                setattr(config, field, "   ")
                problems = config.validate()
                self.assertTrue(any(field in problem for problem in problems), problems)

    def test_empty_string_field_is_flagged(self):
        config = make_config()
        config.model = ""
        self.assertTrue(any("model" in problem for problem in config.validate()))

    def test_timeout_below_one_is_flagged(self):
        for timeout in (0, -5):
            with self.subTest(timeout=timeout):
                config = make_config()
                config.timeout_seconds = timeout
                self.assertTrue(any("timeout_seconds" in problem for problem in config.validate()))

    def test_non_integer_timeout_is_flagged(self):
        config = make_config()
        config.timeout_seconds = "900"  # type: ignore[assignment]
        self.assertTrue(any("timeout_seconds" in problem for problem in config.validate()))

    def test_require_valid_lists_every_problem(self):
        config = make_config()
        config.model = ""
        config.sandbox_root = " "
        config.timeout_seconds = 0
        with self.assertRaises(ValueError) as ctx:
            config.require_valid()
        message = str(ctx.exception)
        self.assertIn("model", message)
        self.assertIn("sandbox_root", message)
        self.assertIn("timeout_seconds", message)

    def test_require_valid_accepts_valid_config(self):
        make_config().require_valid()


class FromEnvTests(unittest.TestCase):
    def test_from_env_reads_every_variable(self):
        env = {
            "PI_COMMAND": "pi",
            "PI_MODEL": "m",
            "PI_EXTENSION_PATH": "/ext",
            "PI_ENDPOINT_URL": "http://ep",
            "PI_SANDBOX_ROOT": "/sb",
            "PI_TIMEOUT_SECONDS": "60",
        }
        config = PiConfig.from_env(env)
        self.assertEqual(config.pi_command, "pi")
        self.assertEqual(config.model, "m")
        self.assertEqual(config.extension_path, "/ext")
        self.assertEqual(config.endpoint_url, "http://ep")
        self.assertEqual(config.sandbox_root, "/sb")
        self.assertEqual(config.timeout_seconds, 60)
        self.assertEqual(config.validate(), [])

    def test_from_env_defaults_when_variables_absent(self):
        config = PiConfig.from_env({})
        self.assertEqual(config.timeout_seconds, DEFAULT_TIMEOUT_SECONDS)
        self.assertEqual(DEFAULT_TIMEOUT_SECONDS, 900)
        problems = config.validate()
        self.assertTrue(any("pi_command" in problem for problem in problems))
        self.assertTrue(any("model" in problem for problem in problems))
        self.assertTrue(any("extension_path" in problem for problem in problems))
        self.assertTrue(any("endpoint_url" in problem for problem in problems))
        self.assertTrue(any("sandbox_root" in problem for problem in problems))

    def test_from_env_blank_timeout_falls_back_to_default(self):
        config = PiConfig.from_env({"PI_TIMEOUT_SECONDS": "   "})
        self.assertEqual(config.timeout_seconds, DEFAULT_TIMEOUT_SECONDS)

    def test_from_env_unparsable_timeout_is_detectable_via_validate(self):
        config = PiConfig.from_env({"PI_TIMEOUT_SECONDS": "soon"})
        self.assertTrue(any("timeout_seconds" in problem for problem in config.validate()))

    def test_from_env_defaults_to_process_environ(self):
        with mock.patch.dict(os.environ, {"PI_COMMAND": "env-pi", "PI_TIMEOUT_SECONDS": "45"}):
            config = PiConfig.from_env()
        self.assertEqual(config.pi_command, "env-pi")
        self.assertEqual(config.timeout_seconds, 45)


if __name__ == "__main__":
    unittest.main()
