import json
import hashlib
import requests
from psycopg2 import IntegrityError

from odoo import _, api, fields, models
from odoo.exceptions import AccessError, UserError


class DigBuilderProject(models.Model):
    _name = "dig.builder.project"
    _description = "DIG Builder Project"
    _order = "create_date desc"

    name = fields.Char(required=True)
    description = fields.Text(required=True)
    provider = fields.Selection(
        [("openai", "OpenAI"), ("anthropic", "Anthropic")],
        required=True,
    )
    model = fields.Char(required=True)
    state = fields.Selection(
        [
            ("draft", "Draft"),
            ("proposed", "Proposal ready"),
            ("approved", "Approved"),
            ("built", "Built"),
            ("failed", "Failed"),
        ],
        default="draft",
        required=True,
        readonly=True,
    )
    phase = fields.Selection(
        [("connect", "Connect"), ("describe", "Describe"), ("build", "Build"), ("publish", "Publish")],
        default="describe",
        required=True,
        readonly=True,
    )
    proposal = fields.Text(readonly=True)
    service_project_id = fields.Char(readonly=True, copy=False)
    metadata_summary = fields.Text(readonly=True)
    metadata_json = fields.Text(readonly=True, copy=False)
    metadata_version = fields.Char(readonly=True, copy=False)
    description_hash = fields.Char(readonly=True, copy=False)
    metadata_hash = fields.Char(readonly=True, copy=False)
    revision = fields.Integer(default=0, readonly=True, copy=False)
    create_request_id = fields.Char(index=True, readonly=True, copy=False)
    company_id = fields.Many2one("res.company", required=True, default=lambda self: self.env.company)
    owner_id = fields.Many2one("res.users", required=True, default=lambda self: self.env.user)
    message_ids = fields.One2many("dig.builder.message", "project_id", readonly=True)
    task_ids = fields.One2many("dig.builder.task", "project_id", readonly=True)

    METADATA_VERSION = "odoo20-v1"
    METADATA_FIELDS = {
        "planning.slot": ["name", "start_datetime", "end_datetime", "state", "partner_id", "employee_ids", "user_ids"],
        "svs.tech.visit": ["name", "visit_date", "state", "partner_id", "technician_id", "slot_id"],
        "project.task": ["name", "stage_id", "user_ids", "project_id", "date_deadline"],
        "sale.order": ["name", "state", "partner_id", "date_order", "amount_total"],
        "crm.lead": ["name", "type", "stage_id", "user_id", "partner_id"],
    }
    PROTECTED_FIELDS = {
        "state", "phase", "proposal", "service_project_id", "metadata_summary",
        "metadata_json", "metadata_version", "description_hash", "metadata_hash", "revision",
    }
    NORMAL_INPUT_FIELDS = {"name", "description", "provider", "model"}
    SERVER_FIELDS = {"revision", "create_request_id"}

    create_request_unique = models.Constraint(
        "UNIQUE(company_id, create_request_id)",
        "Dit projectverzoek is al aangemaakt.",
    )

    def _check_builder_admin(self):
        if not self.env.user.has_group("dig_builder.group_dig_builder_admin"):
            raise AccessError(_("Only DIG Builder administrators may use this project."))
        return True

    @staticmethod
    def _digest(value):
        return hashlib.sha256(value.encode("utf-8")).hexdigest()

    def _metadata_contract(self):
        self._check_builder_admin()
        models = []
        for model_name, field_names in self.METADATA_FIELDS.items():
            try:
                model = self.env[model_name]
            except KeyError:
                continue
            if model is None or not model.has_access("read"):
                continue
            readable_fields = []
            for field_name in field_names:
                try:
                    field_info = model.fields_get(
                        [field_name], attributes=["type", "relation"]
                    ).get(field_name)
                except (AccessError, KeyError):
                    field_info = None
                if field_info:
                    readable_fields.append({
                        "name": field_name,
                        "type": field_info.get("type"),
                        "relation": field_info.get("relation") or None,
                    })
            models.append({
                "name": model_name,
                "fields": sorted(readable_fields, key=lambda field: field["name"]),
            })
        return {"version": self.METADATA_VERSION, "company_id": self.env.company.id, "models": models}

    def _current_metadata_hash(self):
        return self._digest(self.metadata_json or "")

    def _current_description_hash(self):
        return self._digest(self.description or "")

    def _conversation_payload(self):
        self.ensure_one()
        return [{"role": message.role, "content": message.body} for message in self.message_ids.sorted("create_date, id")]

    def enqueue_description(self, body, client_request_id):
        self.ensure_one()
        self._check_builder_admin()
        if self.company_id != self.env.company:
            raise AccessError(_("Het project hoort niet bij de actieve onderneming."))
        body = (body or "").strip()
        client_request_id = (client_request_id or "").strip()
        if not body or not client_request_id:
            raise UserError(_("Een bericht en uniek verzoek-id zijn verplicht."))
        existing = self.env["dig.builder.task"].search([
            ("project_id", "=", self.id),
            ("client_request_id", "=", client_request_id),
        ], limit=1)
        if existing:
            return existing
        if self.state not in {"draft", "proposed"} or self.phase != "describe":
            raise UserError(_("Dit project kan nu geen beschrijving verwerken."))
        self.write({"description": body})
        metadata = self._metadata_contract()
        self._write_workflow({
            "metadata_json": json.dumps(metadata, sort_keys=True),
            "metadata_version": metadata["version"],
            "metadata_summary": _("%s modellen beschikbaar in onderneming %s") % (len(metadata["models"]), self.env.company.display_name),
        })
        conversation = self._conversation_payload() + [{"role": "user", "content": body}]
        try:
            with self.env.cr.savepoint():
                task = self.env["dig.builder.task"]._create_queued({
                    "project_id": self.id,
                    "company_id": self.company_id.id,
                    "requested_by": self.env.user.id,
                    "client_request_id": client_request_id,
                    "provider": self.provider,
                    "model": self.model,
                    "metadata_json": json.dumps(metadata, sort_keys=True),
                    "conversation_json": json.dumps(conversation, ensure_ascii=True),
                    "description_snapshot": body,
                    "project_revision": self.revision,
                })
        except IntegrityError:
            return self.env["dig.builder.task"].search([
                ("project_id", "=", self.id),
                ("client_request_id", "=", client_request_id),
            ], limit=1)
        self.env["dig.builder.message"]._create_user_for_task(self, body, task, client_request_id)
        return task

    def _write_workflow(self, vals):
        """Write protected fields only from a checked workflow method."""
        self._check_builder_admin()
        if not vals or not set(vals).issubset(self.PROTECTED_FIELDS | {"revision"}):
            raise UserError(_("Invalid internal builder workflow update."))
        for project in self:
            if project.company_id != self.env.company:
                raise AccessError(_("The project belongs to another company."))
        return super().write(vals)

    @api.model_create_multi
    def create(self, vals_list):
        self._check_builder_admin()
        context_defaults = {
            key.removeprefix("default_")
            for key in self.env.context
            if key.startswith("default_")
        }
        if context_defaults.intersection(self.PROTECTED_FIELDS | self.SERVER_FIELDS | {"company_id", "owner_id"}):
            raise UserError(_("Builder workflow and identity defaults must not be supplied through context."))
        clean_vals_list = []
        for original_vals in vals_list:
            vals = dict(original_vals)
            if (self.PROTECTED_FIELDS - {"state", "phase"}).intersection(vals):
                raise UserError(_("New builder projects must start as an unapproved description draft."))
            if vals.get("state", "draft") != "draft" or vals.get("phase", "describe") != "describe":
                raise UserError(_("New builder projects must start in draft/describe."))
            if vals.get("company_id", self.env.company.id) != self.env.company.id:
                raise AccessError(_("A builder project must belong to the active company."))
            if vals.get("owner_id", self.env.user.id) != self.env.user.id:
                raise AccessError(_("A builder project must be owned by the current user."))
            if vals.get("create_request_id") is not None and not vals["create_request_id"].strip():
                raise UserError(_("Een projectverzoek-id mag niet leeg zijn."))
            clean_vals_list.append(vals)

        records = self.browse()
        for vals in clean_vals_list:
            request_id = vals.get("create_request_id")
            if request_id:
                existing = self.search([
                    ("company_id", "=", self.env.company.id),
                    ("create_request_id", "=", request_id),
                ], limit=1)
                if existing:
                    records |= existing
                    continue
            try:
                with self.env.cr.savepoint():
                    created = super(DigBuilderProject, self).create([vals])
            except IntegrityError:
                if not request_id:
                    raise
                created = self.search([
                    ("company_id", "=", self.env.company.id),
                    ("create_request_id", "=", request_id),
                ], limit=1)
                if not created:
                    raise
            records |= created
        # Context defaults are applied by the ORM during create. Validate the
        # stored values and clear every workflow field before returning.
        for project in records:
            if project.state != "draft" or project.phase != "describe" or project.company_id != self.env.company or project.owner_id != self.env.user:
                raise AccessError(_("The new builder project has invalid server-managed defaults."))
            project._write_workflow({
                "state": "draft",
                "phase": "describe",
                "proposal": False,
                "service_project_id": False,
                "metadata_summary": False,
                "metadata_json": False,
                "metadata_version": False,
                "description_hash": False,
                "metadata_hash": False,
                "revision": project.revision,
            })
        return records

    def copy(self, default=None):
        self.ensure_one()
        self._check_builder_admin()
        if self.company_id != self.env.company:
            raise AccessError(_("The project belongs to another company."))
        requested = dict(default or {})
        context_defaults = {key: value for key, value in self.env.context.items() if key.startswith("default_")}
        if self.PROTECTED_FIELDS.intersection(requested) or self.PROTECTED_FIELDS.intersection(key.removeprefix("default_") for key in context_defaults) or {"company_id", "owner_id", "create_request_id"}.intersection(requested) or {"company_id", "owner_id", "create_request_id"}.intersection(key.removeprefix("default_") for key in context_defaults):
            raise UserError(_("A copied project cannot supply workflow fields."))
        copied = self.create({
            "name": requested.get("name", _("%s (copy)") % self.name),
            "description": requested.get("description", self.description),
            "provider": requested.get("provider", self.provider),
            "model": requested.get("model", self.model),
            "state": "draft",
            "phase": "describe",
            "company_id": self.env.company.id,
            "owner_id": self.env.user.id,
        })
        return copied

    def write(self, vals):
        self._check_builder_admin()
        if self.PROTECTED_FIELDS.intersection(vals):
            raise UserError(_("Workflow fields may only be changed by the DIG Builder workflow."))
        if not set(vals).issubset(self.NORMAL_INPUT_FIELDS | {"company_id", "owner_id"}):
            raise UserError(_("Only builder description fields may be edited."))
        if "company_id" in vals or "owner_id" in vals:
            raise UserError(_("Company and owner cannot be changed after project creation."))
        relevant_change = {"description", "provider", "model"}.intersection(vals)
        for project in self:
            if project.company_id != self.env.company:
                raise AccessError(_("The project belongs to another company."))
        result = super().write(vals)
        if relevant_change:
            self._write_workflow({
                "state": "draft",
                "phase": "describe",
                "proposal": False,
                "service_project_id": False,
                "description_hash": False,
                "metadata_hash": False,
                "revision": project.revision + 1,
            })
        return result

    def action_approve(self):
        self._check_builder_admin()
        for project in self:
            if project.company_id != self.env.company:
                raise AccessError(_("The project belongs to another company."))
            if not project.proposal:
                raise UserError(_("A proposal is required before approval."))
            if project.state != "proposed" or not project.proposal or project.description_hash != project._current_description_hash() or project.metadata_hash != project._current_metadata_hash():
                raise UserError(_("Only a current proposal can be approved."))
            project._write_workflow({"state": "approved", "phase": "build"})
        return True

    def _builder_service_request(self, path, method="POST", payload=None):
        self.ensure_one()
        self._check_builder_admin()
        params = self.env["ir.config_parameter"].sudo()
        base_url = (params.get_str("dig_builder.service_url") or "").rstrip("/")
        token = params.get_str("dig_builder.service_token") or ""
        if not base_url or not token:
            raise UserError(_("The DIG Builder service is not configured."))
        try:
            response = requests.request(
                method,
                f"{base_url}{path}",
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                data=json.dumps(payload or {}),
                timeout=30,
            )
            response.raise_for_status()
            return response.json()
        except (requests.RequestException, ValueError) as error:
            detail = ""
            if "response" in locals():
                try:
                    detail = (response.json().get("error") or "")
                except (ValueError, AttributeError):
                    detail = ""
            if isinstance(detail, str) and detail and len(detail) <= 160:
                raise UserError(_("The DIG Builder service request failed: %s") % detail) from error
            raise UserError(_("The DIG Builder service request failed.")) from error

    def action_generate_proposal(self):
        for project in self:
            project._check_builder_admin()
            if project.company_id != self.env.company:
                raise AccessError(_("The project belongs to another company."))
            if project.state != "draft" or project.phase != "describe":
                raise UserError(_("Only an unapproved description draft can generate a proposal."))
            if not project.metadata_json or project.metadata_version != self.METADATA_VERSION:
                raise UserError(_("Refresh Odoo metadata before generating a proposal."))
            created = project._builder_service_request(
                "/api/projects",
                payload={"description": project.description, "provider": project.provider, "model": project.model, "metadata": json.loads(project.metadata_json)},
            )
            service_project = created.get("project") or {}
            service_id = service_project.get("id")
            if not service_id:
                raise UserError(_("The builder service returned no project id."))
            proposal = project._builder_service_request(f"/api/projects/{service_id}/proposal").get("project") or {}
            if proposal.get("metadata_version") != project.metadata_version:
                raise UserError(_("The proposal metadata version does not match the Odoo metadata."))
            project._write_workflow({"service_project_id": service_id, "proposal": proposal.get("proposal"), "state": "proposed", "phase": "describe", "description_hash": project._current_description_hash(), "metadata_hash": project._current_metadata_hash()})
        return True

    def action_refresh_metadata(self):
        self._check_builder_admin()
        for project in self:
            metadata = project._metadata_contract()
            values = {
                "metadata_json": json.dumps(metadata, sort_keys=True),
                "metadata_version": metadata["version"],
                "metadata_summary": _("%s models available in company %s") % (len(metadata["models"]), self.env.company.display_name),
                "revision": project.revision + 1,
            }
            if project.state != "draft":
                values.update({"state": "draft", "phase": "describe", "proposal": False, "service_project_id": False, "description_hash": False, "metadata_hash": False})
            project._write_workflow(values)
        return True
