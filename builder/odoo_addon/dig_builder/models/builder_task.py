import json

from odoo import _, api, fields, models
from odoo.exceptions import AccessError, UserError


class DigBuilderTask(models.Model):
    _name = "dig.builder.task"
    _description = "DIG Builder Async Task"
    _order = "create_date desc, id desc"

    _sql_constraints = [
        ("project_request_unique", "unique(project_id, client_request_id)", "Dit verzoek is al aangemaakt."),
    ]

    project_id = fields.Many2one("dig.builder.project", required=True, ondelete="cascade", index=True)
    company_id = fields.Many2one("res.company", required=True, index=True)
    requested_by = fields.Many2one("res.users", required=True, default=lambda self: self.env.user)
    client_request_id = fields.Char(required=True, index=True, copy=False)
    state = fields.Selection(
        [("queued", "In wachtrij"), ("running", "Bezig"), ("succeeded", "Geslaagd"), ("failed", "Mislukt")],
        required=True,
        default="queued",
    )
    provider = fields.Selection([("openai", "OpenAI"), ("anthropic", "Anthropic")], required=True)
    model = fields.Char(required=True)
    metadata_json = fields.Text(required=True, copy=False)
    conversation_json = fields.Text(required=True, copy=False)
    service_project_id = fields.Char(readonly=True, copy=False)
    error_message = fields.Text(readonly=True, copy=False)
    attempts = fields.Integer(default=0, readonly=True, copy=False)
    started_at = fields.Datetime(readonly=True, copy=False)
    finished_at = fields.Datetime(readonly=True, copy=False)

    @api.model_create_multi
    def create(self, vals_list):
        self._check_builder_admin()
        for vals in vals_list:
            if vals.get("state", "queued") != "queued":
                raise UserError(_("Nieuwe taken moeten in de wachtrij starten."))
            project = self.env["dig.builder.project"].browse(vals.get("project_id")).exists()
            if not project or project.company_id != self.env.company:
                raise AccessError(_("De taak hoort niet bij de actieve onderneming."))
            vals.setdefault("company_id", self.env.company.id)
            vals.setdefault("requested_by", self.env.user.id)
        return super().create(vals_list)

    def write(self, vals):
        if set(vals) & {"state", "metadata_json", "conversation_json", "service_project_id", "error_message", "attempts", "started_at", "finished_at"}:
            raise UserError(_("Taakstatussen worden alleen door de achtergrondworker gewijzigd."))
        return super().write(vals)

    def _write_internal(self, vals):
        return super(DigBuilderTask, self).write(vals)

    def _check_builder_admin(self):
        if not self.env.user.has_group("dig_builder.group_dig_builder_admin"):
            raise AccessError(_("Alleen DIG Builder-beheerders mogen taken gebruiken."))

    def _run(self):
        self.ensure_one()
        if self.state != "queued":
            return
        task = self.with_user(self.requested_by)
        task._write_internal({"state": "running", "started_at": fields.Datetime.now(), "attempts": task.attempts + 1})
        try:
            project = task.project_id.with_user(task.requested_by)
            created = project._builder_service_request(
                "/api/projects",
                payload={
                    "description": project.description,
                    "provider": task.provider,
                    "model": task.model,
                    "metadata": json.loads(task.metadata_json),
                    "conversation": json.loads(task.conversation_json),
                },
            )
            service_project = created.get("project") or {}
            service_id = service_project.get("id")
            if not service_id:
                raise UserError(_("De builder-service gaf geen project-id terug."))
            result = project._builder_service_request(f"/api/projects/{service_id}/proposal").get("project") or {}
            proposal = result.get("proposal")
            if not proposal:
                raise UserError(_("De builder-service gaf geen voorstel terug."))
            project._write_workflow({
                "service_project_id": service_id,
                "proposal": proposal,
                "state": "proposed",
                "phase": "describe",
                "description_hash": project._current_description_hash(),
                "metadata_hash": project._current_metadata_hash(),
            })
            self.env["dig.builder.message"]._create_assistant(project, proposal, task)
            task._write_internal({
                "state": "succeeded",
                "service_project_id": service_id,
                "finished_at": fields.Datetime.now(),
                "error_message": False,
            })
        except Exception as error:
            task._write_internal({
                "state": "failed",
                "finished_at": fields.Datetime.now(),
                "error_message": str(error)[:2000],
            })

    @api.model
    def _process_pending_tasks(self):
        tasks = self.search([("state", "=", "queued")], order="create_date asc, id asc", limit=5)
        for task in tasks:
            task._run()
        return True
