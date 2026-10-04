import json
import os
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from providers import ProviderError, test
import server
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
            first, first_created = store.create_task(payload)
            second, second_created = store.create_task(dict(payload))
            self.assertEqual(first["id"], second["id"])
            self.assertTrue(first_created)
            self.assertFalse(second_created)

    def test_same_scope_key_with_different_input_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            os.environ["BUILDER_DATA_DIR"] = directory
            store = Store()
            base = {"client_request_id": "request-1", "company_id": 2, "project_id": 8, "description": "Describe", "provider": "openai", "model": "test-model", "metadata": {}, "conversation": []}
            store.create_task(base)
            with self.assertRaisesRegex(ValueError, "different_input"):
                store.create_task(dict(base, description="Different"))

    def test_scope_separates_projects_and_companies(self):
        with tempfile.TemporaryDirectory() as directory:
            os.environ["BUILDER_DATA_DIR"] = directory
            store = Store()
            base = {"client_request_id": "request-1", "company_id": 2, "project_id": 8, "description": "Describe", "provider": "openai", "model": "test-model", "metadata": {}, "conversation": []}
            first, _ = store.create_task(base)
            project_task, _ = store.create_task(dict(base, project_id=9))
            company_task, _ = store.create_task(dict(base, company_id=3))
            self.assertNotEqual(first["id"], project_task["id"])
            self.assertNotEqual(first["id"], company_task["id"])

    def test_concurrent_claim_executes_provider_once(self):
        with tempfile.TemporaryDirectory() as directory:
            os.environ["BUILDER_DATA_DIR"] = directory
            original_store = server.store
            server.store = Store()
            try:
                payload = {"client_request_id": "request-1", "company_id": 2, "project_id": 8, "description": "Describe", "provider": "openai", "model": "test-model", "metadata": {}, "conversation": []}
                task, _ = server.store.create_task(payload)
                calls = []

                def provider(*args):
                    calls.append(True)
                    time.sleep(0.03)
                    return {"ok": True, "complete": True, "text": "proposal"}

                with patch.object(server, "test", side_effect=provider):
                    threads = [threading.Thread(target=server.run_task, args=(task["id"],)) for _ in range(2)]
                    for thread in threads:
                        thread.start()
                    for thread in threads:
                        thread.join()
                self.assertEqual(len(calls), 1)
                self.assertEqual(server.store.get_task(task["id"])["state"], "succeeded")
            finally:
                server.store = original_store

    def test_service_restart_marks_running_task_unknown_instead_of_retrying(self):
        with tempfile.TemporaryDirectory() as directory:
            os.environ["BUILDER_DATA_DIR"] = directory
            store = Store()
            task, _ = store.create_task({"client_request_id": "request-1", "company_id": 2, "project_id": 8, "description": "Describe", "provider": "openai", "model": "test-model", "metadata": {}, "conversation": []})
            claimed = store.claim_task(task["id"])
            self.assertEqual(claimed["state"], "running")
            store.interrupt_tasks([task["id"]])
            self.assertEqual(store.get_task(task["id"])["state"], "interrupted")

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
