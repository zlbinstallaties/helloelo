from odoo import _, api, fields, models
from odoo.exceptions import AccessError, UserError


class DigBuilderMessage(models.Model):
    _name = "dig.builder.message"
    _description = "DIG Builder Conversation Message"
    _order = "create_date asc, id asc"

    project_id = fields.Many2one("dig.builder.project", required=True, ondelete="cascade", index=True)
    company_id = fields.Many2one("res.company", required=True, index=True)
    author_id = fields.Many2one("res.users", required=True, default=lambda self: self.env.user)
    role = fields.Selection(
        [("user", "User"), ("assistant", "Assistant"), ("system", "System")],
        required=True,
    )
    body = fields.Text(required=True)
    client_request_id = fields.Char(index=True, copy=False)
    task_id = fields.Many2one("dig.builder.task", readonly=True, copy=False)

    @api.model_create_multi
    def create(self, vals_list):
        self._check_builder_admin()
        protected_defaults = {key.removeprefix("default_") for key in self.env.context if key.startswith("default_")}
        if protected_defaults.intersection({"company_id", "author_id", "role", "task_id"}):
            raise UserError(_("Berichtidentiteit mag niet via context worden aangeleverd."))
        for vals in vals_list:
            if vals.get("role", "user") != "user":
                raise UserError(_("Assistantberichten worden alleen server-side aangemaakt."))
            if vals.get("task_id"):
                raise UserError(_("Taakkoppelingen worden alleen door de Builder-workflow aangemaakt."))
            project = self.env["dig.builder.project"].browse(vals.get("project_id")).exists()
            if not project or project.company_id != self.env.company:
                raise AccessError(_("Het gesprek hoort niet bij de actieve onderneming."))
            if vals.get("company_id", project.company_id.id) != project.company_id.id or vals.get("author_id", self.env.user.id) != self.env.user.id:
                raise AccessError(_("De identiteit van het bericht is ongeldig."))
            vals.setdefault("company_id", self.env.company.id)
            vals.setdefault("author_id", self.env.user.id)
        return super().create(vals_list)

    def _check_builder_admin(self):
        if not self.env.user.has_group("dig_builder.group_dig_builder_admin"):
            raise AccessError(_("Alleen DIG Builder-beheerders mogen gesprekken gebruiken."))

    def write(self, vals):
        raise UserError(_("Berichten zijn onveranderlijk."))

    def copy(self, default=None):
        raise UserError(_("Berichten kunnen niet worden gekopieerd."))

    def unlink(self):
        raise UserError(_("Berichten kunnen niet worden verwijderd."))

    @api.model
    def _create_assistant(self, project, body, task):
        self._check_builder_admin()
        if not project or project.company_id != self.env.company or task.project_id != project:
            raise AccessError(_("Het assistantbericht hoort niet bij de actieve onderneming."))
        return super().create({
            "project_id": project.id,
            "company_id": project.company_id.id,
            "author_id": project.owner_id.id,
            "role": "assistant",
            "body": body,
            "task_id": task.id,
        })

    @api.model
    def _create_user_for_task(self, project, body, task, client_request_id):
        self._check_builder_admin()
        if not project or project.company_id != self.env.company or task.project_id != project or task.state != "queued" or task.client_request_id != client_request_id:
            raise AccessError(_("Het userbericht hoort niet bij de actieve onderneming."))
        return super().create({
            "project_id": project.id,
            "company_id": project.company_id.id,
            "author_id": self.env.user.id,
            "role": "user",
            "body": body,
            "client_request_id": client_request_id,
            "task_id": task.id,
        })
