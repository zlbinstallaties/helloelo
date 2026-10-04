from odoo import http
from odoo.exceptions import AccessError
from odoo.http import request


class DigBuilderController(http.Controller):
    def _admin(self):
        if not request.env.user.has_group("dig_builder.group_dig_builder_admin"):
            raise AccessError("Only DIG Builder administrators may use this route.")

    @http.route("/dig_builder/metadata", type="jsonrpc", auth="user", methods=["POST"], csrf=True)
    def metadata(self):
        self._admin()
        return request.env["dig.builder.project"]._metadata_contract()

    @http.route("/dig_builder/projects", type="jsonrpc", auth="user", methods=["POST"], csrf=True)
    def projects(self):
        self._admin()
        projects = request.env["dig.builder.project"].search([])
        return {"projects": [{"id": project.id, "name": project.name, "state": project.state, "company_id": project.company_id.id} for project in projects]}

    @http.route("/dig_builder/project/<int:project_id>/metadata", type="jsonrpc", auth="user", methods=["POST"], csrf=True)
    def project_metadata(self, project_id):
        self._admin()
        project = request.env["dig.builder.project"].browse(project_id).exists()
        if not project or project.company_id != request.env.company:
            raise AccessError("Project is outside the current company.")
        return {"company_id": request.env.company.id, "metadata": project.metadata_summary or ""}
