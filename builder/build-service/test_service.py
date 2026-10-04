import json
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from providers import ProviderError, test
from server import is_admin, proposal_prompt, validated_metadata
from store import Store


class BuilderServiceContractTests(unittest.TestCase):
    def test_invalid_service_authentication_is_rejected(self):
        os.environ["BUILDER_ADMIN_TOKEN"] = "expected"
        self.assertFalse(is_admin(SimpleNamespace(headers={"authorization": "Bearer wrong"})))
        self.assertFalse(is_admin(SimpleNamespace(headers={})))
        self.assertTrue(is_admin(SimpleNamespace(headers={"authorization": "Bearer expected"})))

    def test_store_does_not_return_provider_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            os.environ["BUILDER_DATA_DIR"] = directory
            project = Store().create_project("Read-only overview", "openai", "test-model", {"version": "odoo20-v1", "company_id": 2, "models": []})
            serialized = json.dumps(project)
            self.assertNotIn("API_KEY", serialized)
            self.assertNotIn("secret", serialized.lower())

    def test_service_tasks_are_idempotent_by_request_id(self):
        with tempfile.TemporaryDirectory() as directory:
            os.environ["BUILDER_DATA_DIR"] = directory
            store = Store()
            payload = {"client_request_id": "request-1", "description": "Describe", "provider": "openai", "model": "test-model", "metadata": {}, "conversation": []}
            first = store.create_task(payload)
            second = store.create_task(dict(payload))
            self.assertEqual(first["id"], second["id"])

    def test_metadata_is_validated_and_reaches_the_proposal_prompt(self):
        metadata = {"version": "odoo20-v1", "company_id": 2, "models": [{"name": "planning.slot", "fields": [{"name": "name", "type": "char", "relation": None}]}]}
        project = {"description": "Show planning", "metadata": validated_metadata(metadata)}
        prompt = proposal_prompt(project)
        self.assertIn("planning.slot", prompt)
        self.assertIn('"name": "name"', prompt)
        with self.assertRaises(ValueError):
            validated_metadata({"version": "odoo20-v1", "company_id": 2, "models": [{"name": "res.partner", "fields": []}]})

    @patch("providers._post", side_effect=ProviderError("provider returned HTTP 401"))
    def test_invalid_provider_authentication_is_not_silently_accepted(self, _post):
        os.environ["OPENAI_API_KEY"] = "test-key"
        os.environ["OPENAI_MODEL"] = "test-model"
        with self.assertRaises(ProviderError):
            test("openai", None, "test")


if __name__ == "__main__":
    unittest.main()
