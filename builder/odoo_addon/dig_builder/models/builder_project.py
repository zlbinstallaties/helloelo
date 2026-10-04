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
    proposal = fields.Text(readonly=True)
    company_id = fields.Many2one("res.company", required=True, default=lambda self: self.env.company)
    owner_id = fields.Many2one("res.users", required=True, default=lambda self: self.env.user)

    def _check_builder_admin(self):
        if not self.env.user.has_group("dig_builder.group_dig_builder_admin"):
            raise AccessError(_("Only DIG Builder administrators may use this project."))
        return True

    def action_approve(self):
        self._check_builder_admin()
        for project in self:
            if not project.proposal:
                raise UserError(_("A proposal is required before approval."))
            project.state = "approved"
        return True
