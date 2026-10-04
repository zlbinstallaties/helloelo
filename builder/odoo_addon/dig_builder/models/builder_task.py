import json

from odoo import _, api, fields, models
from odoo.exceptions import AccessError, UserError


class DigBuilderTask(models.Model):
    _name = "dig.builder.task"
    _description = "DIG Builder Async Task"
    _order = "create_date desc, id desc"

    _project_request_unique = models.Constraint(
        "UNIQUE(project_id, client_request_id)",
        "Dit verzoek is al aangemaakt.",
    )

    project_id = fields.Many2one("dig.builder.project", required=True, ondelete="cascade", index=True)
    company_id = fields.Many2one("res.company", required=True, index=True)
    requested_by = fields.Many2one("res.users", required=True, default=lambda self: self.env.user)
    client_request_id = fields.Char(required=True, index=True, copy=False)
    state = fields.Selection(
        [("queued", "In wachtrij"), ("running", "Bezig"), ("succeeded", "Geslaagd"), ("failed", "Mislukt"), ("stale", "Verouderd"), ("interrupted", "Onderbroken")],
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
    claimed_at = fields.Datetime(readonly=True, copy=False)
    service_task_id = fields.Char(readonly=True, copy=False)
    description_snapshot = fields.Text(required=True, copy=False, readonly=True)
    project_revision = fields.Integer(required=True, copy=False, readonly=True)

    @api.model_create_multi
    def create(self, vals_list):
        raise AccessError(_("Taken worden alleen door de Builder-workflow aangemaakt."))

    @api.model
    def _create_queued(self, vals):
        self._check_builder_admin()
        context_defaults = {key.removeprefix("default_") for key in self.env.context if key.startswith("default_")}
        protected = {"company_id", "requested_by", "state", "service_task_id", "error_message", "attempts", "started_at", "finished_at", "claimed_at"}
        if context_defaults.intersection(protected):
            raise UserError(_("Taakidentiteit en status mogen niet via context worden aangeleverd."))
        project = self.env["dig.builder.project"].browse(vals.get("project_id")).exists()
        if not project or project.company_id != self.env.company:
            raise AccessError(_("De taak hoort niet bij de actieve onderneming."))
        if vals.get("company_id", project.company_id.id) != project.company_id.id or vals.get("requested_by", self.env.user.id) != self.env.user.id:
            raise AccessError(_("De taakidentiteit is ongeldig."))
        if vals.get("state", "queued") != "queued":
            raise UserError(_("Nieuwe taken moeten in de wachtrij starten."))
        required = {"client_request_id", "provider", "model", "metadata_json", "conversation_json", "description_snapshot", "project_revision"}
        if not required.issubset(vals) or not vals["client_request_id"].strip():
            raise UserError(_("Een volledige taakopname is verplicht."))
        return super().create(dict(vals, company_id=project.company_id.id, requested_by=self.env.user.id, state="queued"))

    def write(self, vals):
        raise UserError(_("Taakgegevens worden alleen door gecontroleerde workflowmethoden gewijzigd."))

    def _write_internal(self, vals):
        self._check_builder_admin()
        allowed = {"state", "service_project_id", "service_task_id", "error_message", "attempts", "started_at", "finished_at", "claimed_at"}
        if not set(vals).issubset(allowed):
            raise UserError(_("Ongeldige interne taakmutatie."))
        for task in self:
            if task.company_id != self.env.company or task.project_id.company_id != task.company_id:
                raise AccessError(_("De taak hoort niet bij de actieve onderneming."))
        return super(DigBuilderTask, self).write(vals)

    def copy(self, default=None):
        raise UserError(_("Taken kunnen niet worden gekopieerd."))

    def unlink(self):
        raise UserError(_("Taken kunnen niet worden verwijderd."))

    def _check_builder_admin(self):
        if not self.env.user.has_group("dig_builder.group_dig_builder_admin"):
            raise AccessError(_("Alleen DIG Builder-beheerders mogen taken gebruiken."))

    def _run(self):
        self.ensure_one()
        if self.state != "queued":
            return
        now = fields.Datetime.now()
        self.env.cr.execute(
            "UPDATE dig_builder_task SET state = %s, started_at = %s, claimed_at = %s, attempts = attempts + 1 WHERE id = %s AND state = %s RETURNING id",
            ("running", now, now, self.id, "queued"),
        )
        if not self.env.cr.fetchone():
            return
        task = self.with_company(self.company_id).with_user(self.requested_by)
        task.invalidate_recordset()
        try:
            project = task.project_id.with_company(task.company_id).with_user(task.requested_by)
            started = project._builder_service_request(
                "/api/tasks",
                payload={
                    "description": task.description_snapshot,
                    "client_request_id": task.client_request_id,
                    "company_id": task.company_id.id,
                    "project_id": task.project_id.id,
                    "provider": task.provider,
                    "model": task.model,
                    "metadata": json.loads(task.metadata_json),
                    "conversation": json.loads(task.conversation_json),
                },
            )
            service_task_id = (started.get("task") or {}).get("id")
            if not service_task_id:
                raise UserError(_("De builder-service gaf geen taak-id terug."))
            task._write_internal({
                "service_task_id": service_task_id,
            })
        except Exception as error:
            task._write_internal({
                "state": "failed",
                "finished_at": fields.Datetime.now(),
                "error_message": str(error)[:2000],
            })

    def _poll_service(self):
        self.ensure_one()
        if self.state != "running" or not self.service_task_id:
            return
        task = self.with_company(self.company_id).with_user(self.requested_by)
        project = task.project_id.with_company(task.company_id).with_user(task.requested_by)
        try:
            response = project._builder_service_request(f"/api/tasks/{task.service_task_id}", method="GET")
            service_task = response.get("task") or {}
            state = service_task.get("state")
            if state in {"queued", "running"}:
                return
            if state == "failed":
                task._write_internal({"state": "failed", "finished_at": fields.Datetime.now(), "error_message": service_task.get("error") or "Providerfout."})
                return
            if state != "succeeded" or not (service_task.get("result") or {}).get("proposal"):
                task._write_internal({"state": "failed", "finished_at": fields.Datetime.now(), "error_message": "De builder-service gaf geen geldig voorstel terug."})
                return
            self.env.cr.execute("SELECT revision FROM dig_builder_project WHERE id = %s FOR UPDATE", (project.id,))
            project.invalidate_recordset(["revision", "description", "metadata_json", "state", "proposal"])
            if project.revision != task.project_revision:
                task._write_internal({"state": "stale", "finished_at": fields.Datetime.now(), "error_message": "Het voorstel is verouderd omdat het project ondertussen is gewijzigd."})
                return
            proposal = service_task["result"]["proposal"]
            project._write_workflow({
                "service_project_id": task.service_task_id,
                "proposal": proposal,
                "state": "proposed",
                "phase": "describe",
                "description_hash": project._digest(task.description_snapshot),
                "metadata_hash": project._digest(task.metadata_json),
            })
            project.env["dig.builder.message"]._create_assistant(project, proposal, task)
            task._write_internal({"state": "succeeded", "finished_at": fields.Datetime.now(), "error_message": False})
        except Exception as error:
            task._write_internal({"state": "failed", "finished_at": fields.Datetime.now(), "error_message": str(error)[:2000]})

    @api.model
    def _process_pending_tasks(self):
        cutoff = fields.Datetime.subtract(fields.Datetime.now(), minutes=5)
        interrupted = self.search([("state", "=", "running"), ("claimed_at", "<", cutoff)], limit=5)
        for task in interrupted:
            task._write_internal({"state": "interrupted", "finished_at": fields.Datetime.now(), "error_message": "De taak is onderbroken; probeer de beschrijving opnieuw."})
        tasks = self.search([("state", "=", "queued")], order="create_date asc, id asc", limit=5)
        for task in tasks:
            task._run()
        running = self.search([("state", "=", "running")], order="claimed_at asc, id asc", limit=5)
        for task in running:
            task._poll_service()
        return True
