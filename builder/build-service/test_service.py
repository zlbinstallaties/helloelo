import json
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from providers import ProviderError, test
from server import is_admin
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
            project = Store().create_project("Read-only overview", "openai", "test-model")
            serialized = json.dumps(project)
            self.assertNotIn("API_KEY", serialized)
            self.assertNotIn("secret", serialized.lower())

    @patch("providers._post", side_effect=ProviderError("provider returned HTTP 401"))
    def test_invalid_provider_authentication_is_not_silently_accepted(self, _post):
        os.environ["OPENAI_API_KEY"] = "test-key"
        os.environ["OPENAI_MODEL"] = "test-model"
        with self.assertRaises(ProviderError):
            test("openai", None, "test")


if __name__ == "__main__":
    unittest.main()
