import json
import logging

from odoo import _, api, fields, models
from odoo.exceptions import RedirectWarning

_logger = logging.getLogger(__name__)

# The name every record of the monteursdashboard starts with. It must be the same as UNAVAILABILITY_MARKER in
# gateway/src/actions.ts (a test in the repo checks that): only those records make Planning ask for a confirmation.
MARKER = "[Dashboard] Niet beschikbaar"

# What can put somebody on a shift or move a shift: only a change of these is checked.
GUARDED = {"start_datetime", "end_datetime", "resource_id", "resource_ids"}

SKIP = "dig_skip_unavailability_check"


class PlanningSlot(models.Model):
    _inherit = "planning.slot"

    def _dig_assigned_resources(self):
        """The resources a shift is assigned to (Odoo 20 can have more than one)."""
        self.ensure_one()
        if "resource_ids" in self._fields:
            return self.resource_ids
        if "resource_id" in self._fields:
            return self.resource_id
        _logger.warning("planning.slot has neither resource_ids nor resource_id: nothing can be checked")
        return self.env["resource.resource"]

    def _dig_guard_active(self):
        # Cron jobs and other system work (superuser) and an explicit confirmation are never interrupted.
        return not self.env.su and not self.env.context.get(SKIP)

    def _dig_unavailable_leaves(self):
        """The records of the dashboard that overlap a shift of these records, for the resources assigned to them."""
        leaves = self.env["resource.calendar.leaves"].browse()
        Leave = self.env["resource.calendar.leaves"].sudo()
        for slot in self:
            if not slot.start_datetime or not slot.end_datetime:
                continue
            resources = slot._dig_assigned_resources()
            if not resources:
                continue
            leaves |= Leave.search(
                [
                    ("resource_id", "in", resources.ids),
                    ("name", "=like", MARKER + "%"),
                    ("date_from", "<", slot.end_datetime),
                    ("date_to", ">", slot.start_datetime),
                ],
                order="date_from",
            )
        return leaves

    def _dig_unavailable_message(self):
        """The question for the planner, or an empty text when nobody is unavailable."""
        leaves = self._dig_unavailable_leaves()
        if not leaves:
            return ""
        lines = []
        for leave in leaves:
            start = fields.Datetime.context_timestamp(self, leave.date_from)
            end = fields.Datetime.context_timestamp(self, leave.date_to)
            lines.append(
                _(
                    "%(naam)s is niet beschikbaar van %(van)s tot %(tot)s.",
                    naam=leave.resource_id.name,
                    van=start.strftime("%d-%m-%Y %H:%M"),
                    tot=end.strftime("%d-%m-%Y %H:%M"),
                )
            )
        lines.append(_("De monteur heeft dit zelf doorgegeven in het monteursdashboard. Wil je hem toch inplannen?"))
        return "\n".join(lines)

    def _dig_confirm_action(self, kind, vals, message):
        """The window the planner sees after the warning: the same change is done again, with the check off."""
        return {
            "type": "ir.actions.act_window",
            "name": _("Monteur is niet beschikbaar"),
            "res_model": "dig.planning.unavailable.confirm",
            "view_mode": "form",
            "target": "new",
            "context": {
                "default_kind": kind,
                "default_vals": json.dumps(vals, default=str),
                "default_message": message,
                "default_slot_ids": [(6, 0, self.ids)] if kind == "write" else False,
            },
        }

    @api.model_create_multi
    def create(self, vals_list):
        slots = super().create(vals_list)
        if slots._dig_guard_active():
            message = slots._dig_unavailable_message()
            if message:
                # The exception undoes the create; the planner is asked, and "Toch inplannen" creates it again.
                raise RedirectWarning(message, slots._dig_confirm_action("create", vals_list, message), _("Toch inplannen"))
        return slots

    def write(self, vals):
        result = super().write(vals)
        if GUARDED & set(vals) and self._dig_guard_active():
            message = self._dig_unavailable_message()
            if message:
                raise RedirectWarning(message, self._dig_confirm_action("write", vals, message), _("Toch inplannen"))
        return result
