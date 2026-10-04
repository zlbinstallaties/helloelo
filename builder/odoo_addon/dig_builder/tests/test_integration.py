import os

from odoo.exceptions import UserError
from odoo.tests.common import TransactionCase, tagged


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

    def test_odoo_reaches_builder_and_rejects_wrong_token(self):
        if os.environ.get("DIG_BUILDER_INTEGRATION") != "1":
            self.skipTest("integration service is not configured")

        params = self.env["ir.config_parameter"].sudo()
        service_url = params.get_str("dig_builder.service_url")
        service_token = params.get_str("dig_builder.service_token")
        self.assertTrue(service_url)
        self.assertTrue(service_token)

        project = self.env["dig.builder.project"].with_user(self.builder_user).create({
            "name": "Builder service integration",
            "description": "Connectivity test only",
            "provider": "openai",
            "model": "integration-test-model",
        })
        response = project._builder_service_request("/api/providers", method="GET")
        self.assertIn("providers", response)

        params.set_str("dig_builder.service_token", "wrong-token")
        try:
            with self.assertRaises(UserError):
                project._builder_service_request("/api/providers", method="GET")
        finally:
            params.set_str("dig_builder.service_token", service_token)
