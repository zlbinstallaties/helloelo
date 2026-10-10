{
    "name": "DIG Planning: monteur niet beschikbaar",
    "version": "20.0.1.0.0",
    "category": "Human Resources/Planning",
    "summary": "Waarschuwt bij het inplannen van een monteur die zijn niet-beschikbaar-periode heeft doorgegeven",
    "description": """
Een monteur geeft in het monteursdashboard door wanneer hij niet beschikbaar is. Het dashboard zet daar een record in
Odoo voor (Planning, Onbeschikbaarheid van resource, naam begint met [Dashboard] Niet beschikbaar). Deze module vraagt
de planner om bevestiging als hij die monteur toch op zo'n dag inplant: "Monteur is niet beschikbaar. Toch inplannen?"
Annuleren laat alles zoals het was; Toch inplannen plant hem in.
""",
    "license": "LGPL-3",
    "depends": ["planning", "resource"],
    "data": [
        "views/dig_planning_unavailable_confirm_views.xml",
    ],
    "installable": True,
    "application": False,
}
