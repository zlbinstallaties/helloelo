import json

from odoo import fields, models

from ..models.planning_slot import SKIP


class DigPlanningUnavailableConfirm(models.TransientModel):
    """What the planner sees after "Monteur is niet beschikbaar": the question, and the change that was asked for."""

    _name = "dig.planning.unavailable.confirm"
    _description = "Monteur is niet beschikbaar: toch inplannen?"

    kind = fields.Selection([("create", "Aanmaken"), ("write", "Wijzigen")], required=True)
    vals = fields.Text(required=True)
    slot_ids = fields.Many2many("planning.slot")
    message = fields.Text(readonly=True)

    def action_confirm(self):
        """Does the change that was asked for, once, without the check. Rights are those of the planner himself."""
        self.ensure_one()
        vals = json.loads(self.vals)
        if self.kind == "create":
            self.env["planning.slot"].with_context(**{SKIP: True}).create(vals)
        else:
            self.slot_ids.with_context(**{SKIP: True}).write(vals)
        return {"type": "ir.actions.client", "tag": "reload"}
