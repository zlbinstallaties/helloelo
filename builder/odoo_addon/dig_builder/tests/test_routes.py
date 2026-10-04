import json

from odoo.tests.common import HttpCase, tagged


@tagged("post_install", "-at_install")
class TestDigBuilderRoutes(HttpCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        group = cls.env.ref("dig_builder.group_dig_builder_admin")
        cls.admin = cls.env["res.users"].create({
            "name": "DIG Builder Route Admin",
            "login": "dig-builder-route-admin",
            "password": "route-password",
            "group_ids": [(4, group.id)],
        })
        cls.user = cls.env["res.users"].create({
            "name": "DIG Builder Route User",
            "login": "dig-builder-route-user",
            "password": "route-password",
        })

    def _metadata(self):
        return self.url_open(
            "/dig_builder/metadata",
            data=json.dumps({"jsonrpc": "2.0", "method": "call", "params": {}, "id": 1}),
            headers={"Content-Type": "application/json", "X-CSRFToken": self.csrf_token()},
            allow_redirects=False,
        )

    def test_not_logged_in_is_rejected(self):
        response = self._metadata()
        self.assertIn(response.status_code, (302, 303, 401))

    def test_logged_in_non_admin_is_rejected(self):
        self.authenticate(self.user.login, "route-password")
        response = self._metadata()
        self.assertEqual(response.status_code, 403)

    def test_builder_admin_is_allowed_without_secrets(self):
        self.authenticate(self.admin.login, "route-password")
        response = self._metadata()
        self.assertEqual(response.status_code, 200)
        body = response.text
        self.assertNotIn("BUILDER_ADMIN_TOKEN", body)
        self.assertNotIn("OPENAI_API_KEY", body)
        self.assertNotIn("ANTHROPIC_API_KEY", body)
