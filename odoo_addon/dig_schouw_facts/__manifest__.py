{
    "name": "DIG Schouwgegevens op de klant",
    "version": "20.0.1.0.0",
    "category": "Sales",
    "summary": "Zet de gegevens van een schouw bij de klant, voor de offerte-assistent",
    "description": """
Een monteur vult een schouwdocument in het monteursdashboard in. Het dashboard zet het getekende PDF bij de klant en vult
daarnaast een aantal gegevens van de schouw in op de klant (installatietype, afgiftesysteem, isolatie, aantal personen,
ruimte, leidingroute en lengte, elektrische aansluiting, werk voor de klant, enzovoort), zodat de offerte-assistent en de
mensen die offertes maken ze later kunnen gebruiken.

Deze module maakt die velden aan op het contact (res.partner) en toont ze op het tabblad "Schouwgegevens".
Het dashboard vult alleen velden die nog leeg zijn; wat iemand zelf invult of wat een eerdere schouw er zette, wordt nooit
overschreven. De namen, typen en keuzes staan ook in src/lib/documents/customer-facts.ts van het dashboard; een test
controleert dat ze overeenkomen.

De module heeft geen eigen tabellen en geen eigen toegangsregels: wie een contact mag wijzigen, mag deze velden wijzigen.
De Odoo-gebruiker achter de API-sleutel van de gateway moet contacten mogen schrijven.
""",
    "license": "LGPL-3",
    "depends": ["base"],
    "data": [
        "views/res_partner_views.xml",
    ],
    "installable": True,
    "application": False,
}
