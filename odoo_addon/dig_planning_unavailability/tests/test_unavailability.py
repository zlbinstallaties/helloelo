from datetime import datetime

from odoo.exceptions import RedirectWarning
from odoo.tests.common import TransactionCase, tagged

from ..models.planning_slot import MARKER

# NOT run in the repo (there is no Odoo there): run it on a TEST database with
#   python -m odoo -c odoo.conf -d <a test database> -i dig_planning_unavailability --test-tags /dig_planning_unavailability --stop-after-init
# The logic itself is also tested without Odoo in stub_tests/test_guard.py.


@tagged("post_install", "-at_install")
class TestPlanningUnavailability(TransactionCase):
    def setUp(self):
        super().setUp()
        self.planner = self.env["res.users"].create({
            "name": "DIG Planner Test",
            "login": "dig-planner-test",
            "email": "dig-planner-test@example.test",
            "password": "test-password",
            "group_ids": [(6, 0, [self.env.ref("planning.group_planning_manager").id, self.env.ref("base.group_user").id])],
        })
        self.jan = self.env["hr.employee"].create({"name": "Jan Test"})
        self.sanne = self.env["hr.employee"].create({"name": "Sanne Test"})
        # What the dashboard makes for Monday 26 October 2026 (whole day, in UTC for the Netherlands in summer time).
        self.env["resource.calendar.leaves"].create({
            "name": MARKER + ": test",
            "resource_id": self.jan.resource_id.id,
            "date_from": datetime(2026, 10, 25, 23, 0, 0),
            "date_to": datetime(2026, 10, 26, 22, 59, 59),
        })

    def _vals(self, employee, start, end):
        fields = self.env["planning.slot"]._fields
        vals = {"start_datetime": start, "end_datetime": end}
        if "resource_ids" in fields:
            vals["resource_ids"] = [(6, 0, [employee.resource_id.id])]
        else:
            vals["resource_id"] = employee.resource_id.id
        return vals

    def _slots(self):
        return self.env["planning.slot"].with_user(self.planner)

    def test_planning_an_unavailable_technician_asks_first(self):
        with self.assertRaises(RedirectWarning) as raised:
            self._slots().create(self._vals(self.jan, datetime(2026, 10, 26, 7, 0), datetime(2026, 10, 26, 15, 0)))
        self.assertIn("Jan Test is niet beschikbaar", raised.exception.args[0])
        self.assertEqual(raised.exception.args[2], "Toch inplannen")

    def test_another_day_and_another_technician_are_not_asked(self):
        self._slots().create(self._vals(self.jan, datetime(2026, 10, 27, 7, 0), datetime(2026, 10, 27, 15, 0)))
        self._slots().create(self._vals(self.sanne, datetime(2026, 10, 26, 7, 0), datetime(2026, 10, 26, 15, 0)))

    def test_toch_inplannen_creates_the_shift(self):
        vals = self._vals(self.jan, datetime(2026, 10, 26, 7, 0), datetime(2026, 10, 26, 15, 0))
        with self.assertRaises(RedirectWarning) as raised:
            self._slots().create(vals)
        context = raised.exception.args[1]["context"]
        wizard = self.env["dig.planning.unavailable.confirm"].with_user(self.planner).with_context(**context).create({
            "kind": context["default_kind"], "vals": context["default_vals"], "message": context["default_message"],
        })
        wizard.action_confirm()
        self.assertTrue(self.env["planning.slot"].search([("start_datetime", "=", datetime(2026, 10, 26, 7, 0))]))

    def test_the_system_is_not_interrupted(self):
        # self.env is the superuser: cron jobs (for instance a recurring shift) are never stopped by the question.
        self.env["planning.slot"].create(self._vals(self.jan, datetime(2026, 10, 26, 7, 0), datetime(2026, 10, 26, 15, 0)))
