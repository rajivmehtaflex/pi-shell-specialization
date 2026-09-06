import json
import tempfile
import unittest
from pathlib import Path

from remote.pi_env.interception import (
    AUXILIARY,
    TRAINING,
    InterceptedCall,
    InterceptionCore,
    ProxyServer,
    classify_call,
)


def chat_request(**overrides):
    request = {
        "model": "student-model",
        "messages": [
            {"role": "system", "content": "You are a shell agent."},
            {"role": "user", "content": "list the files"},
            {"role": "tool", "content": "notes.txt"},
        ],
    }
    request.update(overrides)
    return request


def fake_upstream(request):
    return {"id": "resp-1", "model": request.get("model"), "choices": [{"message": {"role": "assistant", "content": "ok"}}]}


class ClassifyCallTests(unittest.TestCase):
    def test_plain_request_is_training(self):
        self.assertEqual(classify_call(chat_request()), TRAINING)
        self.assertEqual(classify_call(chat_request(), headers={}), TRAINING)

    def test_header_marks_auxiliary_case_insensitively(self):
        for headers in (
            {"X-Pi-Call-Type": "auxiliary"},
            {"x-pi-call-type": "Auxiliary"},
            {"X-PI-CALL-TYPE": " AUXILIARY "},
        ):
            with self.subTest(headers=headers):
                self.assertEqual(classify_call(chat_request(), headers=headers), AUXILIARY)

    def test_header_other_values_stay_training(self):
        self.assertEqual(classify_call(chat_request(), headers={"X-Pi-Call-Type": "training"}), TRAINING)

    def test_body_metadata_marks_auxiliary(self):
        request = chat_request(metadata={"pi_call": "auxiliary"})
        self.assertEqual(classify_call(request), AUXILIARY)
        self.assertEqual(classify_call(request, headers={}), AUXILIARY)

    def test_body_metadata_other_values_stay_training(self):
        self.assertEqual(classify_call(chat_request(metadata={"pi_call": "training"})), TRAINING)

    def test_non_dict_metadata_is_ignored(self):
        self.assertEqual(classify_call(chat_request(metadata="auxiliary")), TRAINING)


class InterceptionCoreTests(unittest.TestCase):
    def setUp(self):
        self.seen = []
        self.core = InterceptionCore(upstream=self.record_upstream)

    def record_upstream(self, request):
        self.seen.append(request)
        return fake_upstream(request)

    def test_training_call_is_recorded_by_default(self):
        response = self.core.handle(chat_request())
        self.assertEqual(response["id"], "resp-1")
        self.assertEqual(len(self.core.training_calls()), 1)
        self.assertEqual(self.core.aux_calls(), [])
        self.assertEqual(self.core.calls[0].call_type, TRAINING)

    def test_header_marked_call_is_auxiliary(self):
        self.core.handle(chat_request(), headers={"X-Pi-Call-Type": "auxiliary"})
        self.assertEqual(len(self.core.aux_calls()), 1)
        self.assertEqual(self.core.training_calls(), [])

    def test_body_metadata_marked_call_is_auxiliary(self):
        self.core.handle(chat_request(metadata={"pi_call": "auxiliary"}))
        self.assertEqual(len(self.core.aux_calls()), 1)
        self.assertEqual(self.core.training_calls(), [])
        self.assertEqual(self.core.aux_calls()[0].request_metadata.get("aux_source"), "body-metadata")

    def test_header_marking_wins_with_aux_source_header(self):
        request = chat_request(metadata={"pi_call": "auxiliary"})
        self.core.handle(request, headers={"X-Pi-Call-Type": "auxiliary"})
        self.assertEqual(self.core.aux_calls()[0].request_metadata.get("aux_source"), "header")

    def test_response_passes_through_unchanged(self):
        expected = fake_upstream(chat_request())
        response = self.core.handle(chat_request())
        self.assertEqual(response, expected)

    def test_request_metadata_is_captured(self):
        self.core.handle(chat_request(), headers={"X-Pi-Path": "/v1/chat/completions"})
        metadata = self.core.calls[0].request_metadata
        self.assertEqual(metadata["model"], "student-model")
        self.assertEqual(metadata["path"], "/v1/chat/completions")
        self.assertEqual(metadata["message_turns"], 3)
        self.assertEqual(metadata["tool_turns"], 1)
        self.assertIsInstance(metadata["started_at"], float)

    def test_default_path_when_header_absent(self):
        self.core.handle(chat_request())
        self.assertEqual(self.core.calls[0].request_metadata["path"], "/v1/chat/completions")

    def test_response_metadata_is_captured(self):
        self.core.handle(chat_request())
        metadata = self.core.calls[0].response_metadata
        self.assertEqual(metadata["model"], "student-model")
        self.assertEqual(metadata["status"], "ok")

    def test_trace_preserves_order(self):
        self.core.handle(chat_request())
        self.core.handle(chat_request(metadata={"pi_call": "auxiliary"}))
        self.core.handle(chat_request(), headers={"X-Pi-Call-Type": "auxiliary"})
        self.core.handle(chat_request())
        trace = self.core.trace()
        self.assertEqual([entry["call_type"] for entry in trace], [TRAINING, AUXILIARY, AUXILIARY, TRAINING])
        for entry in trace:
            self.assertIn("request_metadata", entry)
            self.assertIn("response_metadata", entry)

    def test_calls_property_is_mutable_copy_safe(self):
        self.core.handle(chat_request())
        calls = self.core.calls
        self.assertEqual(len(calls), 1)

    def test_upstream_receives_request_untouched(self):
        request = chat_request()
        self.core.handle(request)
        self.assertEqual(self.seen[0], request)

    def test_append_trace_writes_jsonl_in_order(self):
        self.core.handle(chat_request())
        self.core.handle(chat_request(metadata={"pi_call": "auxiliary"}))
        with tempfile.TemporaryDirectory(prefix="pi-env-trace-") as temporary:
            path = Path(temporary) / "nested" / "trace.jsonl"
            self.core.append_trace(str(path))
            lines = [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
            self.assertEqual(len(lines), 2)
            entries = [json.loads(line) for line in lines]
            self.assertEqual([entry["call_type"] for entry in entries], [TRAINING, AUXILIARY])


class InterceptedCallTests(unittest.TestCase):
    def test_defaults_and_fields(self):
        call = InterceptedCall(
            request_metadata={"model": "m"},
            response_metadata={"status": "ok"},
            call_type=TRAINING,
        )
        self.assertEqual(call.request_metadata["model"], "m")
        self.assertEqual(call.call_type, TRAINING)


class ProxyServerSmokeTests(unittest.TestCase):
    def test_loopback_round_trip_records_training_and_aux(self):
        core = InterceptionCore(upstream=fake_upstream)
        with ProxyServer(core) as server:
            self.assertGreater(server.port, 0)
            first = server.post("/v1/chat/completions", chat_request())
            second = server.post(
                "/v1/chat/completions",
                chat_request(),
                headers={"X-Pi-Call-Type": "auxiliary"},
            )
        self.assertEqual(first["id"], "resp-1")
        self.assertEqual(second["id"], "resp-1")
        self.assertEqual(len(core.training_calls()), 1)
        self.assertEqual(len(core.aux_calls()), 1)


if __name__ == "__main__":
    unittest.main()
