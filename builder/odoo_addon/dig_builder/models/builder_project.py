import json
import requests

from odoo import _, fields, models
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
    )
    phase = fields.Selection(
        [("connect", "Connect"), ("describe", "Describe"), ("build", "Build"), ("publish", "Publish")],
        default="describe",
        required=True,
    )
    proposal = fields.Text(readonly=True)
    service_project_id = fields.Char(readonly=True, copy=False)
    metadata_summary = fields.Text(readonly=True)
    company_id = fields.Many2one("res.company", required=True, default=lambda self: self.env.company)
    owner_id = fields.Many2one("res.users", required=True, default=lambda self: self.env.user)

    def _check_builder_admin(self):
        if not self.env.user.has_group("dig_builder.group_dig_builder_admin"):
            raise AccessError(_("Only DIG Builder administrators may use this project."))
        return True

    def action_approve(self):
        self._check_builder_admin()
        for project in self:
            if project.company_id != self.env.company:
                raise AccessError(_("The project belongs to another company."))
            if not project.proposal:
                raise UserError(_("A proposal is required before approval."))
            project.state = "approved"
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
            created = project._builder_service_request(
                "/api/projects",
                payload={"description": project.description, "provider": project.provider, "model": project.model},
            )
            service_project = created.get("project") or {}
            service_id = service_project.get("id")
            if not service_id:
                raise UserError(_("The builder service returned no project id."))
            proposal = project._builder_service_request(f"/api/projects/{service_id}/proposal").get("project") or {}
            project.write({"service_project_id": service_id, "proposal": proposal.get("proposal"), "state": "proposed", "phase": "build"})
        return True

    def action_refresh_metadata(self):
        self._check_builder_admin()
        models_with_access = self.env["ir.model"].search([])
        visible = []
        for model in models_with_access:
            if not model.model or not self.env[model.model].check_access_rights("read", raise_exception=False):
                continue
            visible.append(model.model)
        summary = _("Readable models in company %s:\n%s") % (self.env.company.display_name, "\n".join(sorted(visible)))
        self.write({"metadata_summary": summary})
        return True
