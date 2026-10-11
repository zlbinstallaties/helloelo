from odoo.tests.common import TransactionCase


class TestSchouwFacts(TransactionCase):
    """Run with Odoo's own test runner after installing the module (see docs/formulieren-schouw-oplevering.md)."""

    def test_fields_start_empty_and_can_be_written(self):
        partner = self.env["res.partner"].create({"name": "Familie Proef"})
        for name, field in self.env["res.partner"]._fields.items():
            if name.startswith("dig_schouw_"):
                self.assertFalse(partner[name], name)
        partner.write({"dig_schouw_isolatie": "matig", "dig_schouw_aantal_personen": 3, "dig_schouw_asbest_vermoed": "nee"})
        self.assertEqual(partner.dig_schouw_isolatie, "matig")
        self.assertEqual(partner.dig_schouw_aantal_personen, 3)
        self.assertEqual(partner.dig_schouw_asbest_vermoed, "nee", "'nee' is a value, not 'not filled in'")

    def test_a_duplicate_does_not_take_the_schouw_along(self):
        partner = self.env["res.partner"].create({"name": "Familie Proef", "dig_schouw_isolatie": "goed"})
        copy = partner.copy()
        self.assertFalse(copy.dig_schouw_isolatie)
