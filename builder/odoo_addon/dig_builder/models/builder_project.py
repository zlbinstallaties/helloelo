import json
import hashlib
import requests

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
    company_id = fields.Many2one("res.company", required=True, default=lambda self: self.env.company)
    owner_id = fields.Many2one("res.users", required=True, default=lambda self: self.env.user)

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
        "metadata_json", "metadata_version", "description_hash", "metadata_hash",
    }
    NORMAL_INPUT_FIELDS = {"name", "description", "provider", "model"}

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
        field_model = self.env["ir.model.fields"]
        for model_name, field_names in self.METADATA_FIELDS.items():
            try:
                model = self.env[model_name]
            except KeyError:
                continue
            if model is None or not model.has_access("read"):
                continue
            fields = field_model.search([("model", "=", model_name), ("name", "in", field_names)])
            models.append({
                "name": model_name,
                "fields": [
                    {"name": field.name, "type": field.ttype, "relation": field.relation or None}
                    for field in fields.sorted("name")
                ],
            })
        return {"version": self.METADATA_VERSION, "company_id": self.env.company.id, "models": models}

    def _current_metadata_hash(self):
        return self._digest(self.metadata_json or "")

    def _current_description_hash(self):
        return self._digest(self.description or "")

    def _write_workflow(self, vals):
        """Write protected fields only from a checked workflow method."""
        self._check_builder_admin()
        if not vals or not set(vals).issubset(self.PROTECTED_FIELDS):
            raise UserError(_("Invalid internal builder workflow update."))
        for project in self:
            if project.company_id != self.env.company:
                raise AccessError(_("The project belongs to another company."))
        return super().write(vals)

    @api.model_create_multi
    def create(self, vals_list):
        self._check_builder_admin()
        for vals in vals_list:
            if (self.PROTECTED_FIELDS - {"state", "phase"}).intersection(vals):
                raise UserError(_("New builder projects must start as an unapproved description draft."))
            if vals.get("state", "draft") != "draft" or vals.get("phase", "describe") != "describe":
                raise UserError(_("New builder projects must start in draft/describe."))
            vals["state"] = "draft"
            vals["phase"] = "describe"
            if vals.get("company_id", self.env.company.id) != self.env.company.id:
                raise AccessError(_("A builder project must belong to the active company."))
            if vals.get("owner_id", self.env.user.id) != self.env.user.id:
                raise AccessError(_("A builder project must be owned by the current user."))
        return super().create(vals_list)

    def copy(self, default=None):
        self.ensure_one()
        self._check_builder_admin()
        if self.company_id != self.env.company:
            raise AccessError(_("The project belongs to another company."))
        requested = default or {}
        if self.PROTECTED_FIELDS.intersection(requested) or {"company_id", "owner_id"}.intersection(requested):
            raise UserError(_("A copied project cannot supply workflow fields."))
        return self.create({
            "name": requested.get("name", _("%s (copy)") % self.name),
            "description": requested.get("description", self.description),
            "provider": requested.get("provider", self.provider),
            "model": requested.get("model", self.model),
        })

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
        base_url = (params.get_param("dig_builder.service_url") or "").rstrip("/")
        token = params.get_param("dig_builder.service_token") or ""
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
            }
            if project.state != "draft":
                values.update({"state": "draft", "phase": "describe", "proposal": False, "service_project_id": False, "description_hash": False, "metadata_hash": False})
            project._write_workflow(values)
        return True
