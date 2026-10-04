from odoo import fields, http
from odoo.exceptions import AccessError, UserError
from odoo.http import request


class DigBuilderController(http.Controller):
    def _admin(self):
        if not request.env.user.has_group("dig_builder.group_dig_builder_admin"):
            raise AccessError("Only DIG Builder administrators may use this route.")

    def _project(self, project_id):
        self._admin()
        project = request.env["dig.builder.project"].browse(project_id).exists()
        if not project or project.company_id != request.env.company:
            raise AccessError("Project is outside the current company.")
        return project

    @staticmethod
    def _task_data(task):
        if not task:
            return None
        return {
            "id": task.id,
            "state": task.state,
            "error": task.error_message or None,
            "attempts": task.attempts,
        }

    @staticmethod
    def _project_data(project):
        task = project.task_ids.sorted("create_date, id")[-1:] or request.env["dig.builder.task"]
        return {
            "id": project.id,
            "name": project.name,
            "description": project.description,
            "provider": project.provider,
            "model": project.model,
            "state": project.state,
            "phase": project.phase,
            "proposal": project.proposal or None,
            "metadata_version": project.metadata_version or None,
            "messages": [{
                "id": message.id,
                "role": message.role,
                "body": message.body,
                "created_at": fields.Datetime.to_string(message.create_date),
            } for message in project.message_ids.sorted("create_date, id")],
            "task": DigBuilderController._task_data(task),
            "preview": {
                "available": False,
                "message": "Nog geen preview beschikbaar.",
                "files": [],
                "changes": [],
                "tests": [],
            },
        }

    @http.route("/dig_builder/app/bootstrap", type="jsonrpc", auth="user", methods=["POST"], csrf=True)
    def app_bootstrap(self):
        self._admin()
        projects = request.env["dig.builder.project"].search(
            [("company_id", "=", request.env.company.id)], order="write_date desc, id desc"
        )
        return {
            "user": {"id": request.env.user.id, "name": request.env.user.name},
            "providers": [
                {"value": "openai", "label": "OpenAI"},
                {"value": "anthropic", "label": "Anthropic"},
            ],
            "projects": [{"id": project.id, "name": project.name, "state": project.state, "phase": project.phase} for project in projects],
        }

    @http.route("/dig_builder/app/project/create", type="jsonrpc", auth="user", methods=["POST"], csrf=True)
    def app_project_create(self, name, description, provider, model, client_request_id):
        self._admin()
        project = request.env["dig.builder.project"].create({
            "name": (name or "Nieuw DIG Builder-project").strip(),
            "description": (description or "").strip(),
            "provider": provider,
            "model": (model or "").strip(),
        })
        task = project.enqueue_description(description, client_request_id)
        return {"project": self._project_data(project), "task": self._task_data(task)}

    @http.route("/dig_builder/app/project/<int:project_id>", type="jsonrpc", auth="user", methods=["POST"], csrf=True)
    def app_project(self, project_id):
        return self._project_data(self._project(project_id))

    @http.route("/dig_builder/app/project/<int:project_id>/message", type="jsonrpc", auth="user", methods=["POST"], csrf=True)
    def app_message(self, project_id, body, client_request_id):
        project = self._project(project_id)
        task = project.enqueue_description(body, client_request_id)
        return {"project": self._project_data(project), "task": self._task_data(task)}

    @http.route("/dig_builder/app/project/<int:project_id>/settings", type="jsonrpc", auth="user", methods=["POST"], csrf=True)
    def app_project_settings(self, project_id, provider, model):
        project = self._project(project_id)
        if provider not in {"openai", "anthropic"} or not (model or "").strip():
            raise UserError("Een geldige provider en model zijn verplicht.")
        project.write({"provider": provider, "model": model.strip()})
        return self._project_data(project)

    @http.route("/dig_builder/app/project/<int:project_id>/approve", type="jsonrpc", auth="user", methods=["POST"], csrf=True)
    def app_approve(self, project_id):
        project = self._project(project_id)
        project.action_approve()
        return self._project_data(project)

    @http.route("/dig_builder/metadata", type="jsonrpc", auth="user", methods=["POST"], csrf=True)
    def metadata(self):
        self._admin()
        return request.env["dig.builder.project"]._metadata_contract()

    @http.route("/dig_builder/projects", type="jsonrpc", auth="user", methods=["POST"], csrf=True)
    def projects(self):
        self._admin()
        projects = request.env["dig.builder.project"].search([
            ("company_id", "=", request.env.company.id),
        ])
        return {"projects": [{"id": project.id, "name": project.name, "state": project.state, "company_id": project.company_id.id} for project in projects]}

    @http.route("/dig_builder/project/<int:project_id>/metadata", type="jsonrpc", auth="user", methods=["POST"], csrf=True)
    def project_metadata(self, project_id):
        self._admin()
        project = request.env["dig.builder.project"].browse(project_id).exists()
        if not project or project.company_id != request.env.company:
            raise AccessError("Project is outside the current company.")
        return {"company_id": request.env.company.id, "metadata": project.metadata_summary or ""}
