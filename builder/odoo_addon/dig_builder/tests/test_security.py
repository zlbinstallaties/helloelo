import json
from unittest.mock import patch

from odoo.exceptions import AccessError, UserError
from odoo.tests.common import TransactionCase, tagged

from ..models.builder_project import DigBuilderProject


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

    def test_create_only_allows_a_clean_draft(self):
        model = self.env["dig.builder.project"].with_user(self.builder_user)
        base = {"name": "Create test", "description": "Describe", "provider": "openai", "model": "test-model"}
        for bad in ({"state": "approved"}, {"state": "built"}, {"phase": "build"}, *(
            {field: "forged"} for field in DigBuilderProject.PROTECTED_FIELDS - {"state", "phase"}
        )):
            with self.assertRaises(UserError):
                model.create([dict(base, **bad)])
        with self.assertRaises(UserError):
            model.create([dict(base, state="approved"), dict(base, state="built")])

    def test_create_rejects_protected_and_identity_context_defaults(self):
        model = self.env["dig.builder.project"].with_user(self.builder_user)
        base = {"name": "Context test", "description": "Describe", "provider": "openai", "model": "test-model"}
        for field in DigBuilderProject.PROTECTED_FIELDS | {"company_id", "owner_id"}:
            with self.subTest(field=field), self.assertRaises(UserError):
                model.with_context(**{"default_%s" % field: "forged"}).create(base)

        other_company = self.env["res.company"].create({"name": "Context Other Company"})
        with self.assertRaises(UserError):
            model.with_context(default_company_id=other_company.id).create(base)

    def test_direct_protected_writes_and_context_flags_are_rejected(self):
        project = self._project()
        for field, value in (("state", "approved"), ("state", "built"), ("phase", "build"), ("proposal", "forged"), ("service_project_id", "forged"), ("metadata_summary", "forged"), ("metadata_json", "forged"), ("metadata_version", "forged"), ("description_hash", "forged"), ("metadata_hash", "forged")):
            with self.assertRaises(UserError):
                project.with_context(dig_builder_workflow=True).write({field: value})
        with self.assertRaises(UserError):
            project.write({"company_id": self.env.company.id})
        with self.assertRaises(UserError):
            project.write({"owner_id": self.builder_user.id})

    def _generate(self, project):
        project.action_refresh_metadata()

        def service_response(_record, path, method="POST", payload=None):
            if path == "/api/projects":
                return {"project": {"id": "service-1", "metadata_version": "odoo20-v1"}}
            return {"project": {"proposal": "Generated proposal", "metadata_version": "odoo20-v1"}}

        with patch.object(DigBuilderProject, "_builder_service_request", autospec=True, side_effect=service_response):
            project.action_generate_proposal()
        return project

    def test_admin_uses_service_workflow_then_explicit_approval(self):
        project = self._generate(self._project())
        self.assertEqual(project.state, "proposed")
        self.assertEqual(project.phase, "describe")
        project.action_approve()
        self.assertEqual(project.state, "approved")
        self.assertEqual(project.phase, "build")

    def test_relevant_input_change_invalidates_approval(self):
        project = self._generate(self._project())
        project.action_approve()
        project.write({"description": "Changed after approval"})
        self.assertEqual(project.state, "draft")
        self.assertEqual(project.phase, "describe")
        self.assertFalse(project.proposal)

    def test_copy_is_a_clean_new_draft(self):
        project = self._generate(self._project())
        project.action_approve()
        copy_project = project.copy()
        self.assertNotEqual(project.id, copy_project.id)
        self.assertEqual(copy_project.state, "draft")
        self.assertEqual(copy_project.phase, "describe")
        self.assertFalse(copy_project.proposal)
        self.assertFalse(copy_project.service_project_id)
        self.assertFalse(copy_project.description_hash)
        self.assertFalse(copy_project.metadata_hash)

    def test_copy_rejects_forged_context_defaults(self):
        project = self._project()
        for field in DigBuilderProject.PROTECTED_FIELDS | {"company_id", "owner_id"}:
            with self.subTest(field=field), self.assertRaises(UserError):
                project.with_context(**{"default_%s" % field: "forged"}).copy()

    def test_copy_preserves_only_normal_inputs(self):
        project = self._project()
        copied = project.copy({"name": "Copied name", "description": "Copied description", "provider": "anthropic", "model": "test-model-2"})
        self.assertEqual(copied.name, "Copied name")
        self.assertEqual(copied.description, "Copied description")
        self.assertEqual(copied.provider, "anthropic")
        self.assertEqual(copied.model, "test-model-2")
        self.assertEqual(copied.company_id, self.env.company)
        self.assertEqual(copied.owner_id, self.builder_user)

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

    def test_conversation_enqueue_is_idempotent_and_snapshots_metadata(self):
        project = self._project()
        first = project.enqueue_description("Plan een planningsoverzicht", "request-1")
        second = project.enqueue_description("Plan een planningsoverzicht", "request-1")
        self.assertEqual(first, second)
        self.assertEqual(project.task_ids, first)
        self.assertEqual(project.message_ids.mapped("body"), ["Plan een planningsoverzicht"])
        self.assertIn('"version": "odoo20-v1"', first.metadata_json)
        self.assertIn("Plan een planningsoverzicht", first.conversation_json)

    def test_project_creation_request_is_idempotent(self):
        model = self.env["dig.builder.project"].with_user(self.builder_user)
        values = {
            "name": "Idempotent project",
            "description": "Describe once",
            "provider": "openai",
            "model": "test-model",
            "create_request_id": "create-request-1",
        }
        first = model.create(values)
        second = model.create(values)
        self.assertEqual(first, second)

    def test_assistant_messages_cannot_be_forged_with_context(self):
        project = self._project()
        with self.assertRaises(UserError):
            self.env["dig.builder.message"].with_context(dig_builder_internal=True).create({
                "project_id": project.id,
                "role": "assistant",
                "body": "Forged response",
            })

    def test_queued_task_creates_server_assistant_message(self):
        project = self._project()
        task = project.enqueue_description("Maak een voorstel", "request-run")

        def service_response(_record, path, method="POST", payload=None):
            if path == "/api/tasks":
                return {"task": {"id": "service-run", "state": "queued"}}
            return {"task": {"id": "service-run", "state": "succeeded", "result": {"proposal": "Voorstel vanuit service"}}}

        with patch.object(DigBuilderProject, "_builder_service_request", autospec=True, side_effect=service_response):
            task._run()
            task._poll_service()

        self.assertEqual(task.state, "succeeded")
        self.assertEqual(project.proposal, "Voorstel vanuit service")
        assistant_messages = project.message_ids.filtered(lambda message: message.role == "assistant")
        self.assertEqual(len(assistant_messages), 1)
        self.assertEqual(assistant_messages.body, "Voorstel vanuit service")

    def test_result_is_stale_when_project_changes_during_task(self):
        project = self._project()
        task = project.enqueue_description("Oude beschrijving", "request-stale")

        def service_response(_record, path, method="POST", payload=None):
            if path == "/api/tasks":
                return {"task": {"id": "service-stale", "state": "queued"}}
            return {"task": {"id": "service-stale", "state": "succeeded", "result": {"proposal": "Oud voorstel"}}}

        with patch.object(DigBuilderProject, "_builder_service_request", autospec=True, side_effect=service_response):
            task._run()
            project.write({"description": "Nieuwe beschrijving"})
            task._poll_service()

        self.assertEqual(task.state, "stale")
        self.assertFalse(project.proposal)

    def test_provider_failure_is_a_visible_recoverable_task_failure(self):
        project = self._project()
        task = project.enqueue_description("Test providerfout", "request-failure")

        def failing_request(*args, **kwargs):
            raise UserError("The DIG Builder service is not configured.")

        with patch.object(DigBuilderProject, "_builder_service_request", autospec=True, side_effect=failing_request):
            task._run()

        self.assertEqual(task.state, "failed")
        self.assertIn("not configured", task.error_message)
        self.assertFalse(project.message_ids.filtered(lambda message: message.role == "assistant"))
