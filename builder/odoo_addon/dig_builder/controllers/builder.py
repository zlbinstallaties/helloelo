from odoo import http
from odoo.exceptions import AccessError
from odoo.http import request


class DigBuilderController(http.Controller):
    def _admin(self):
        if not request.env.user.has_group("dig_builder.group_dig_builder_admin"):
            return request.make_json_response({"error": "builder_admin_required"}, status=403)
        return None

    @http.route("/dig_builder/metadata", type="json", auth="user", methods=["POST"], csrf=True)
    def metadata(self):
        denied = self._admin()
        if denied:
            return denied
        readable = []
        for model in request.env["ir.model"].search([]):
            if model.model and request.env[model.model].check_access_rights("read", raise_exception=False):
                readable.append(model.model)
        return {"company_id": request.env.company.id, "company_name": request.env.company.display_name, "readable_models": sorted(readable)}

    @http.route("/dig_builder/projects", type="json", auth="user", methods=["POST"], csrf=True)
    def projects(self):
        denied = self._admin()
        if denied:
            return denied
        projects = request.env["dig.builder.project"].search([])
        return {"projects": [{"id": project.id, "name": project.name, "state": project.state, "company_id": project.company_id.id} for project in projects]}

    @http.route("/dig_builder/project/<int:project_id>/metadata", type="json", auth="user", methods=["POST"], csrf=True)
    def project_metadata(self, project_id):
        denied = self._admin()
        if denied:
            return denied
        project = request.env["dig.builder.project"].browse(project_id).exists()
        if not project or project.company_id != request.env.company:
            raise AccessError("Project is outside the current company.")
        return {"company_id": request.env.company.id, "metadata": project.metadata_summary or ""}
