"""
Tests of the logic of this module WITHOUT Odoo: a few small stand-ins for what Odoo gives (`odoo`, a recordset, a search).
They check what this module decides (when to ask, what to ask, what "Toch inplannen" does again); they do not replace trying it
in Odoo (see tests/test_unavailability.py and docs/planning-weigeren.md).

Run:  python3 odoo_addon/dig_planning_unavailability/stub_tests/test_guard.py
"""
import json
import os
import sys
import types
import unittest
from datetime import datetime

# ---------------------------------------------------------------- stand-ins for Odoo


def _(text, **kwargs):
    return text % kwargs if kwargs else text


class RedirectWarning(Exception):
    def __init__(self, message, action, button_text, additional_context=None):
        super().__init__(message, action, button_text, additional_context)
        self.message, self.action, self.button_text = message, action, button_text


class Base:
    """The part of models.Model the module calls through super()."""

    def create(self, vals_list):
        return self.created

    def write(self, vals):
        self.written.append(vals)
        return True


odoo = types.ModuleType("odoo")
odoo._ = _
odoo.api = types.SimpleNamespace(model_create_multi=lambda function: function)
odoo.fields = types.SimpleNamespace(
    Datetime=types.SimpleNamespace(context_timestamp=lambda record, value: value),
    Selection=lambda *a, **k: None, Text=lambda *a, **k: None, Many2many=lambda *a, **k: None,
)
odoo.models = types.SimpleNamespace(Model=Base, TransientModel=Base)
exceptions = types.ModuleType("odoo.exceptions")
exceptions.RedirectWarning = RedirectWarning
odoo.exceptions = exceptions
sys.modules.update({"odoo": odoo, "odoo.exceptions": exceptions})
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from dig_planning_unavailability.models import planning_slot as slot_module  # noqa: E402
from dig_planning_unavailability.models.planning_slot import MARKER, SKIP, PlanningSlot  # noqa: E402
from dig_planning_unavailability.wizard.unavailable_confirm import DigPlanningUnavailableConfirm  # noqa: E402


class Records(list):
    """A bare recordset: it can be joined with |, is false when empty, and knows its ids."""

    def __or__(self, other):
        return Records(list(self) + [item for item in other if item not in self])

    @property
    def ids(self):
        return [item.id for item in self]


class Resource:
    """One resource; like a one-record recordset it has `ids`."""

    def __init__(self, id, name):
        self.id, self.name, self.ids = id, name, [id]


class Leave:
    def __init__(self, resource, name, start, end):
        self.resource_id, self.name, self.date_from, self.date_to = resource, name, start, end


class LeaveModel:
    def __init__(self, leaves):
        self.leaves, self.searches = leaves, []

    def sudo(self):
        return self

    def browse(self):
        return Records()

    def search(self, domain, order=None):
        self.searches.append((domain, order))
        found = []
        for leave in self.leaves:
            if all(self._holds(leave, *condition) for condition in domain):
                found.append(leave)
        return Records(sorted(found, key=lambda item: item.date_from))

    @staticmethod
    def _holds(leave, field, operator, value):
        actual = leave.resource_id.id if field == "resource_id" else getattr(leave, field)
        if operator == "in":
            return actual in value
        if operator == "=like":
            assert value.endswith("%") and "%" not in value[:-1] and "_" not in value, "only a prefix is supported here"
            return actual.startswith(value[:-1])
        if operator == "<":
            return actual < value
        if operator == ">":
            return actual > value
        raise AssertionError(f"operator not supported by the stand-in: {operator}")


class Env:
    def __init__(self, leaves=(), su=False, context=None):
        self.su, self.context = su, context or {}
        self.leave_model = LeaveModel(list(leaves))
        self.created_with, self.written_with = [], []

    def __getitem__(self, name):
        if name == "resource.calendar.leaves":
            return self.leave_model
        if name == "planning.slot":
            return SlotModel(self)
        raise KeyError(name)


class SlotModel:
    def __init__(self, env):
        self.env = env

    def with_context(self, **context):
        self.env.created_with.append(context)
        return self

    def create(self, vals):
        self.env.created_with.append(("create", vals))
        return True


class Slot(PlanningSlot):
    """One shift, as far as the module looks at it."""

    def __init__(self, env, resources, start, end, id=7):
        self.env, self.id, self.ids = env, id, [id]
        self.resource_ids, self._fields = resources, {"resource_ids": 1, "start_datetime": 1, "end_datetime": 1}
        self.start_datetime, self.end_datetime = start, end
        self.created, self.written = self, []

    def __iter__(self):
        return iter([self])

    def ensure_one(self):
        return self

    def sudo(self):
        return self


JAN, SANNE = Resource(5, "jan hans"), Resource(6, "sanne")
OCT_26 = (datetime(2026, 10, 25, 23, 0), datetime(2026, 10, 26, 22, 59, 59))  # the dashboard's Monday in UTC
SHIFT = (datetime(2026, 10, 26, 7, 0), datetime(2026, 10, 26, 15, 0))


def slot_with(leaves, resources=(JAN,), shift=SHIFT, **env):
    return Slot(Env(leaves, **env), Records(resources), *shift)


class Guard(unittest.TestCase):
    def test_no_record_of_the_dashboard_means_no_question(self):
        slot = slot_with([])
        self.assertIs(slot.create([{"x": 1}]), slot)
        slot.write({"start_datetime": "x"})
        self.assertEqual(slot.written, [{"start_datetime": "x"}])

    def test_creating_a_shift_on_an_unavailable_day_asks_first_and_offers_the_same_create_again(self):
        slot = slot_with([Leave(JAN, MARKER + ": Vakantie", *OCT_26)])
        vals_list = [{"name": "Klus", "start_datetime": "2026-10-26 07:00:00"}]
        with self.assertRaises(RedirectWarning) as raised:
            slot.create(vals_list)
        warning = raised.exception
        self.assertEqual(warning.button_text, "Toch inplannen")
        self.assertIn("jan hans is niet beschikbaar van 25-10-2026 23:00 tot 26-10-2026 22:59", warning.message)
        self.assertIn("Wil je hem toch inplannen?", warning.message)
        context = warning.action["context"]
        self.assertEqual(warning.action["res_model"], "dig.planning.unavailable.confirm")
        self.assertEqual(warning.action["target"], "new")
        self.assertEqual((context["default_kind"], json.loads(context["default_vals"])), ("create", vals_list))
        self.assertFalse(context["default_slot_ids"])
        self.assertEqual(context["default_message"], warning.message)

    def test_moving_or_assigning_a_shift_asks_with_the_shift_and_the_change(self):
        slot = slot_with([Leave(JAN, MARKER, *OCT_26)])
        vals = {"start_datetime": "2026-10-26 08:00:00", "resource_ids": [[6, 0, [5]]]}
        with self.assertRaises(RedirectWarning) as raised:
            slot.write(vals)
        self.assertEqual(raised.exception.button_text, "Toch inplannen")
        context = raised.exception.action["context"]
        self.assertEqual((context["default_kind"], json.loads(context["default_vals"])), ("write", vals))
        self.assertEqual(context["default_slot_ids"], [(6, 0, [7])])

    def test_a_change_that_is_not_about_time_or_people_never_asks(self):
        slot = slot_with([Leave(JAN, MARKER, *OCT_26)])
        slot.write({"name": "Andere naam", "allocated_hours": 4})
        slot.write({"state": "published"})
        self.assertEqual(len(slot.written), 2)
        self.assertEqual(slot.env.leave_model.searches, [], "nothing was even looked up")

    def test_only_the_marked_records_of_the_assigned_resource_that_overlap_count(self):
        for leave in (
            Leave(SANNE, MARKER, *OCT_26),                                              # somebody else
            Leave(JAN, "Vakantie van Jan", *OCT_26),                                    # not made by the dashboard
            Leave(JAN, "Iets " + MARKER, *OCT_26),                                      # the marker is not at the start
            Leave(JAN, MARKER, datetime(2026, 10, 25, 0, 0), SHIFT[0]),                  # ends the moment the shift starts
            Leave(JAN, MARKER, SHIFT[1], datetime(2026, 10, 27, 0, 0)),                  # starts the moment the shift ends
        ):
            slot = slot_with([leave])
            self.assertIs(slot.create([{}]), slot, leave.name)

    def test_of_several_people_on_a_shift_only_the_unavailable_one_is_named(self):
        slot = slot_with([Leave(JAN, MARKER, *OCT_26)], resources=(JAN, SANNE))
        with self.assertRaises(RedirectWarning) as raised:
            slot.create([{}])
        self.assertIn("jan hans", raised.exception.message)
        self.assertNotIn("sanne", raised.exception.message)

    def test_the_system_and_a_confirmed_change_are_never_interrupted(self):
        leave = Leave(JAN, MARKER, *OCT_26)
        for env in ({"su": True}, {"context": {SKIP: True}}):
            slot = slot_with([leave], **env)
            self.assertIs(slot.create([{}]), slot)
            slot.write({"start_datetime": "x"})

    def test_a_shift_without_people_or_times_is_left_alone(self):
        leave = Leave(JAN, MARKER, *OCT_26)
        self.assertIsNotNone(slot_with([leave], resources=()).create([{}]))
        self.assertIsNotNone(slot_with([leave], shift=(None, None)).create([{}]))

    def test_the_search_asks_for_exactly_this_and_nothing_wider(self):
        slot = slot_with([])
        slot.create([{}])
        domain, order = slot.env.leave_model.searches[0]
        self.assertEqual(domain, [("resource_id", "in", [5]), ("name", "=like", MARKER + "%"), ("date_from", "<", SHIFT[1]), ("date_to", ">", SHIFT[0])])
        self.assertEqual(order, "date_from")

    def test_a_shift_with_the_old_single_resource_field_is_checked_too(self):
        slot = slot_with([Leave(JAN, MARKER, *OCT_26)])
        slot._fields = {"resource_id": 1, "start_datetime": 1, "end_datetime": 1}
        slot.resource_id = JAN
        del slot.resource_ids
        with self.assertRaises(RedirectWarning):
            slot.create([{}])

    def test_a_shift_with_no_known_resource_field_does_nothing_instead_of_failing(self):
        slot = slot_with([Leave(JAN, MARKER, *OCT_26)])
        slot._fields = {"start_datetime": 1, "end_datetime": 1}
        slot.env = EnvWithResources(slot.env)
        self.assertIs(slot.create([{}]), slot)


class EnvWithResources:
    """The same environment, that also hands out an empty set of resources."""

    def __init__(self, env):
        self.env = env
        self.su, self.context = env.su, env.context

    def __getitem__(self, name):
        return Records() if name == "resource.resource" else self.env[name]


class Wizard(DigPlanningUnavailableConfirm):
    def __init__(self, kind, vals, env, slots=None):
        self.kind, self.vals, self.env, self.slot_ids = kind, json.dumps(vals), env, slots

    def ensure_one(self):
        return self


class Confirm(unittest.TestCase):
    def test_confirming_a_create_creates_it_once_with_the_check_off(self):
        env = Env()
        result = Wizard("create", [{"name": "Klus"}], env).action_confirm()
        self.assertEqual(env.created_with, [{SKIP: True}, ("create", [{"name": "Klus"}])])
        self.assertEqual(result, {"type": "ir.actions.client", "tag": "reload"})

    def test_confirming_a_change_changes_those_shifts_with_the_check_off(self):
        env = Env()
        calls = []

        class Slots:
            def with_context(self, **context):
                calls.append(context)
                return self

            def write(self, vals):
                calls.append(vals)

        Wizard("write", {"start_datetime": "x"}, env, Slots()).action_confirm()
        self.assertEqual(calls, [{SKIP: True}, {"start_datetime": "x"}])


class Marker(unittest.TestCase):
    def test_the_marker_is_the_one_of_the_gateway(self):
        self.assertEqual(slot_module.MARKER, "[Dashboard] Niet beschikbaar")


if __name__ == "__main__":
    unittest.main()
