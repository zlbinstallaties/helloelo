from odoo import fields, models

# The fields the dashboard fills in after a schouw. The list, the types and the choices are the same as in
# src/lib/documents/customer-facts.ts of the dashboard; a test there compares the two. Change both together.
#
# "ja" and "nee" are a selection and not a checkbox: a checkbox cannot tell "nee" from "not filled in".
# copy=False: a duplicated contact does not take the schouw of the other one along.

YES_NO = [("ja", "Ja"), ("nee", "Nee")]


class ResPartner(models.Model):
    _inherit = "res.partner"

    dig_schouw_datum = fields.Date(
        string="Datum schouw",
        copy=False,
        help="De dag van de schouw waarvan de gegevens hier voor het eerst zijn ingevuld.",
    )
    dig_schouw_gewenst_systeem = fields.Selection(
        [("hybride", "Hybride warmtepomp"), ("all-electric", "All-electric warmtepomp")],
        string="Gewenst systeem",
        copy=False,
    )
    dig_schouw_afgiftesysteem = fields.Selection(
        [
            ("vloer", "Vloerverwarming"),
            ("radiatoren", "Radiatoren"),
            ("lt_radiatoren", "Lage-temperatuurradiatoren"),
            ("mix", "Gemengd"),
        ],
        string="Afgiftesysteem",
        copy=False,
    )
    dig_schouw_isolatie = fields.Selection(
        [("goed", "Goed"), ("matig", "Matig"), ("slecht", "Slecht")],
        string="Isolatie",
        copy=False,
    )
    dig_schouw_aantal_personen = fields.Integer(string="Aantal personen", copy=False)
    dig_schouw_ruimte_installatie = fields.Selection(
        [("weinig", "Weinig"), ("voldoende", "Voldoende")],
        string="Ruimte voor de installatie",
        copy=False,
    )
    dig_schouw_boiler_opstelling = fields.Selection(
        [("horizontaal", "Horizontaal"), ("staand", "Staand")],
        string="Opstelling boiler of buffer",
        copy=False,
    )
    dig_schouw_bouwjaar = fields.Integer(string="Bouwjaar woning", copy=False)
    dig_schouw_gasverbruik = fields.Float(string="Jaarverbruik gas (m³)", copy=False)
    dig_schouw_leidingroute = fields.Text(string="Leidingroute", copy=False)
    dig_schouw_leidinglengte = fields.Float(string="Geschatte leidinglengte (m)", copy=False)
    dig_schouw_aansluiting = fields.Selection(
        [("1-fase", "Enkelfase (1-fase)"), ("3-fase", "Driefase (3-fase)")],
        string="Elektrische aansluiting",
        copy=False,
    )
    dig_schouw_ruimte_meterkast = fields.Selection(YES_NO, string="Voldoende ruimte in de meterkast", copy=False)
    dig_schouw_groep_vrij = fields.Selection(YES_NO, string="Vrije groep in de groepenkast", copy=False)
    dig_schouw_asbest_vermoed = fields.Selection(YES_NO, string="Vermoeden van asbest", copy=False)
    dig_schouw_graafwerk_door_klant = fields.Selection(YES_NO, string="Graafwerk door de klant", copy=False)
    dig_schouw_stroom_door_klant = fields.Selection(YES_NO, string="Stroomvoorziening door de klant", copy=False)
    dig_schouw_werkruimte_door_klant = fields.Selection(
        YES_NO, string="Werkruimte door de klant vrij te maken", copy=False
    )
    dig_schouw_compleet = fields.Selection(YES_NO, string="Schouw compleet voor de werkvoorbereiding", copy=False)
