import json

from odoo.exceptions import AccessError, UserError
from odoo.tests.common import TransactionCase, tagged


@tagged("post_install", "-at_install")
class TestDigBuilderSecurity(TransactionCase):
    def setUp(self):
        super().setUp()
        self.admin_group = self.env.ref("dig_builder.group_dig_builder_admin")
        self.builder_user = self.env["res.users"].create({
            "name": "DIG Builder Test Admin",
            "login": "dig-builder-test-admin",
            "email": "dig-builder-test-admin@example.test",
            "password": "test-password",
            "group_ids": [(4, self.admin_group.id)],
        })
        self.other_user = self.env["res.users"].create({
            "name": "DIG Builder Test User",
            "login": "dig-builder-test-user",
            "email": "dig-builder-test-user@example.test",
            "password": "test-password",
        })

    def _project(self, user=None, company=None):
        return self.env["dig.builder.project"].with_user(user or self.builder_user).create({
            "name": "Security test",
            "description": "Read-only planning overview",
            "provider": "openai",
            "model": "test-model",
            "company_id": (company or self.env.company).id,
        })

    def test_non_admin_cannot_use_model_action(self):
        project = self._project()
        with self.assertRaises(AccessError):
            project.with_user(self.other_user).action_approve()

    def test_builder_admin_group_is_required(self):
        self.assertTrue(self.builder_user.has_group("dig_builder.group_dig_builder_admin"))
        self.assertFalse(self.other_user.has_group("dig_builder.group_dig_builder_admin"))

    def test_company_isolation(self):
        company = self.env["res.company"].create({"name": "DIG Builder Other Company"})
        with self.assertRaises(AccessError):
            self._project(company=company).with_user(self.builder_user).action_approve()

    def test_metadata_contract_excludes_unlisted_models_and_records(self):
        metadata = self._project().with_user(self.builder_user)._metadata_contract()
        names = {model["name"] for model in metadata["models"]}
        self.assertNotIn("res.partner", names)
        self.assertEqual(metadata["company_id"], self.env.company.id)
        self.assertNotIn("records", json.dumps(metadata))

    def test_approval_requires_a_proposed_project_and_current_inputs(self):
        project = self._project()
        with self.assertRaises(UserError):
            project.action_approve()
        project.action_refresh_metadata()
        project.write({"proposal": "Generated", "service_project_id": "service-1", "state": "proposed", "description_hash": project._current_description_hash(), "metadata_hash": project._current_metadata_hash()})
        project.write({"description": "Changed after proposal"})
        self.assertEqual(project.state, "draft")
