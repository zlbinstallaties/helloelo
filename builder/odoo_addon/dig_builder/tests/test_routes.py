import json
from unittest.mock import patch

import requests
from odoo.tests.common import HttpCase, tagged

from ..models import builder_project


@tagged("post_install", "-at_install")
class TestDigBuilderRoutes(HttpCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        builder_group = cls.env.ref("dig_builder.group_dig_builder_admin")
        planning_group = cls.env.ref("planning.group_planning_user")
        cls.admin = cls.env["res.users"].create({
            "name": "DIG Builder Route Admin",
            "login": "dig-builder-route-admin",
            "password": "route-password",
            "group_ids": [(4, builder_group.id), (4, planning_group.id)],
        })
        cls.builder_only_admin = cls.env["res.users"].create({
            "name": "DIG Builder Route Limited Admin",
            "login": "dig-builder-route-limited-admin",
            "password": "route-password",
            "group_ids": [(4, builder_group.id)],
        })
        cls.user = cls.env["res.users"].create({
            "name": "DIG Builder Route User",
            "login": "dig-builder-route-user",
            "password": "route-password",
        })

    def _metadata(self, csrf=True):
        headers = {"Content-Type": "application/json"}
        if csrf:
            headers["X-CSRFToken"] = self.csrf_token()
        return self.url_open(
            "/dig_builder/metadata",
            data=json.dumps({"jsonrpc": "2.0", "method": "call", "params": {}, "id": 1}),
            headers=headers,
            allow_redirects=False,
        )

    def _bootstrap(self):
        return self.url_open(
            "/dig_builder/app/bootstrap",
            data=json.dumps({"jsonrpc": "2.0", "method": "call", "params": {}, "id": 1}),
            headers={"Content-Type": "application/json", "X-CSRFToken": self.csrf_token()},
            allow_redirects=False,
        )

    def _create_project(self):
        return self.url_open(
            "/dig_builder/app/project/create",
            data=json.dumps({
                "jsonrpc": "2.0",
                "method": "call",
                "params": {
                    "name": "Unauthorized project",
                    "description": "Should not be created",
                    "provider": "openai",
                    "model": "test-model",
                    "client_request_id": "unauthorized-client-request",
                },
                "id": 1,
            }),
            headers={"Content-Type": "application/json", "X-CSRFToken": self.csrf_token()},
            allow_redirects=False,
        )

    def test_not_logged_in_is_rejected(self):
        response = self._metadata(csrf=False)
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertIn("error", body)
        self.assertNotIn("result", body)
        self.assertNotIn("models", body)
        self.assertNotIn("metadata", body)
        self.assertEqual(body["error"].get("code"), 100)
        self.assertIn("session", body["error"].get("message", "").lower())

    def test_logged_in_non_admin_is_rejected(self):
        self.authenticate(self.user.login, "route-password")
        response = self._metadata()
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertIn("error", body)
        self.assertNotIn("result", body)
        self.assertNotIn("readable_models", body)

    def test_direct_client_action_cannot_read_or_use_builder_data(self):
        self.authenticate(self.user.login, "route-password")
        bootstrap_body = self._bootstrap().json()
        self.assertIn("error", bootstrap_body)
        self.assertNotIn("result", bootstrap_body)
        self.assertNotIn("projects", bootstrap_body)
        self.assertNotIn("providers", bootstrap_body)

        create_body = self._create_project().json()
        self.assertIn("error", create_body)
        self.assertNotIn("result", create_body)

    def test_builder_only_admin_does_not_receive_ungranted_models(self):
        self.authenticate(self.builder_only_admin.login, "route-password")
        response = self._metadata()
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertNotIn("error", body)
        result = body["result"]
        self.assertNotIn("planning.slot", {model["name"] for model in result["models"]})

    def test_builder_admin_is_allowed_without_secrets(self):
        self.authenticate(self.admin.login, "route-password")
        response = self._metadata()
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertNotIn("error", body)
        result = body.get("result")
        self.assertIsInstance(result, dict)
        self.assertEqual(result.get("version"), "odoo20-v1")
        self.assertEqual(result.get("company_id"), self.admin.company_id.id)
        self.assertIsInstance(result.get("models"), list)
        model_names = {model["name"] for model in result["models"]}
        self.assertIn("planning.slot", model_names)
        self.assertTrue(model_names.issubset({
            "planning.slot", "svs.tech.visit", "project.task", "sale.order", "crm.lead",
        }))
        planning = next(model for model in result["models"] if model["name"] == "planning.slot")
        self.assertTrue({"name", "start_datetime", "end_datetime", "state"}.issubset(
            {field["name"] for field in planning["fields"]}
        ))
        self.assertNotIn("create_date", {field["name"] for field in planning["fields"]})
        self.assertNotIn("BUILDER_ADMIN_TOKEN", response.text)
        self.assertNotIn("OPENAI_API_KEY", response.text)
        self.assertNotIn("ANTHROPIC_API_KEY", response.text)
