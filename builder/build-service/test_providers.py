import os
import unittest
from unittest.mock import patch

from providers import ProviderError, extract_anthropic_response, extract_openai_response, proposal_output_tokens, test


class ProviderExtractionTests(unittest.TestCase):
    def test_openai_extracts_nested_output_text_exactly(self):
        text, complete = extract_openai_response({"id": "mock-id", "output": [{"type": "message", "content": [{"type": "output_text", "text": "Testvoorstel"}]}]})
        self.assertEqual(text, "Testvoorstel")
        self.assertTrue(complete)

    def test_openai_joins_multiple_text_blocks(self):
        text, complete = extract_openai_response({"id": "mock-id", "output": [{"content": [{"type": "output_text", "text": "Eerste"}, {"type": "output_text", "text": "Tweede"}]}]})
        self.assertEqual(text, "Eerste\nTweede")
        self.assertTrue(complete)

    def test_empty_and_incomplete_openai_answers_are_not_complete(self):
        text, complete = extract_openai_response({"id": "mock-id", "status": "incomplete", "output": []})
        self.assertEqual(text, "")
        self.assertFalse(complete)

    def test_anthropic_extraction_remains_separate(self):
        text, complete = extract_anthropic_response({"id": "mock-id", "stop_reason": "end_turn", "content": [{"type": "text", "text": "Claudevoorstel"}]})
        self.assertEqual(text, "Claudevoorstel")
        self.assertTrue(complete)
        _, complete = extract_anthropic_response({"id": "mock-id", "stop_reason": "max_tokens", "content": [{"type": "text", "text": "Afgebroken"}]})
        self.assertFalse(complete)

    def test_provider_error_is_preserved(self):
        with patch("providers._post", side_effect=ProviderError("provider returned HTTP 401")):
            os.environ["OPENAI_API_KEY"] = "test-key"
            os.environ["OPENAI_MODEL"] = "test-model"
            with self.assertRaises(ProviderError):
                test("openai", None, "test")

    def test_proposal_token_limit_is_bounded(self):
        os.environ["PROPOSAL_MAX_OUTPUT_TOKENS"] = "999999"
        self.assertEqual(proposal_output_tokens(), 8192)
        os.environ["PROPOSAL_MAX_OUTPUT_TOKENS"] = "1"
        self.assertEqual(proposal_output_tokens(), 256)


if __name__ == "__main__":
    unittest.main()
