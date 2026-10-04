import os
from urllib.parse import urlsplit
from unittest.mock import patch

import requests
from odoo.exceptions import UserError
from odoo.tests.common import BlockedRequest, TransactionCase, tagged

from ..models import builder_project


@tagged("post_install", "-at_install", "dig_builder_integration")
class TestDigBuilderServiceIntegration(TransactionCase):
    def setUp(self):
        super().setUp()
        group = self.env.ref("dig_builder.group_dig_builder_admin")
        self.builder_user = self.env["res.users"].create({
            "name": "DIG Builder Integration Admin",
            "login": "dig-builder-integration-admin",
            "email": "dig-builder-integration-admin@example.test",
            "password": "test-password",
            "group_ids": [(4, group.id)],
        })

    @staticmethod
    def _make_internal_request_wrapper(original_request, service_url):
        configured = urlsplit(service_url)

        def request(method, url, **kwargs):
            target = urlsplit(url)
            is_allowed = (
                method.upper() == "GET"
                and target.scheme == configured.scheme == "http"
                and target.hostname == configured.hostname
                and target.port == configured.port == 8080
                and target.path == "/api/providers"
                and not target.query
                and not target.fragment
            )
            if not is_allowed:
                return original_request(method, url, **kwargs)
            if kwargs.get("allow_redirects"):
                raise AssertionError("redirects are not allowed for the internal service test")

            session = requests.Session()
            session.trust_env = False
            prepared = session.prepare_request(requests.Request(
                method=method,
                url=url,
                headers=kwargs.get("headers"),
                data=kwargs.get("data"),
            ))
            response = session.get_adapter(url).send(
                prepared,
                stream=kwargs.get("stream", False),
                timeout=kwargs.get("timeout"),
                verify=kwargs.get("verify", True),
                cert=kwargs.get("cert"),
                proxies={},
            )
            if response.is_redirect or response.is_permanent_redirect:
                response.close()
                session.close()
                raise AssertionError("redirects are not allowed for the internal service test")
            response.content
            session.close()
            return response

        return request

    def test_odoo_reaches_builder_and_rejects_wrong_token(self):
        if os.environ.get("DIG_BUILDER_INTEGRATION") != "1":
            self.skipTest("integration service is not configured")

        params = self.env["ir.config_parameter"].sudo()
        service_url = params.get_str("dig_builder.service_url")
        service_token = params.get_str("dig_builder.service_token")
        expected_url = os.environ.get("DIG_BUILDER_SERVICE_URL")
        self.assertTrue(service_url)
        self.assertTrue(service_token)
        self.assertEqual(service_url, expected_url)
        parsed_url = urlsplit(service_url)
        self.assertEqual(parsed_url.scheme, "http")
        allowed_hosts = set(filter(None, os.environ.get("DIG_BUILDER_INTERNAL_HOSTS", "builder,builder-api").split(",")))
        self.assertIn(parsed_url.hostname, allowed_hosts)
        self.assertEqual(parsed_url.port, 8080)
        self.assertIsNone(parsed_url.username)
        self.assertIsNone(parsed_url.password)

        project = self.env["dig.builder.project"].with_user(self.builder_user).create({
            "name": "Builder service integration",
            "description": "Connectivity test only",
            "provider": "openai",
            "model": "integration-test-model",
        })
        original_request = builder_project.requests.request
        handler = self._make_internal_request_wrapper(original_request, service_url)
        with patch.object(builder_project.requests, "request", side_effect=handler):
            response = project._builder_service_request("/api/providers", method="GET")
            self.assertIn("providers", response)

            params.set_str("dig_builder.service_token", "wrong-token")
            try:
                with self.assertRaises(UserError):
                    project._builder_service_request("/api/providers", method="GET")

                params.set_str("dig_builder.service_url", "http://outside.invalid:8080")
                with self.assertRaises(UserError) as blocked:
                    project._builder_service_request("/api/providers", method="GET")
                self.assertIsInstance(blocked.exception.__cause__, BlockedRequest)
            finally:
                params.set_str("dig_builder.service_url", service_url)
                params.set_str("dig_builder.service_token", service_token)
