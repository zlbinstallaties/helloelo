{
    "name": "DIG Builder",
    "version": "20.0.0.1.0",
    "category": "Tools",
    "summary": "Admin-only proposal workflow for DIG extensions",
    "license": "LGPL-3",
    "depends": ["base", "planning", "sale_management"],
    "data": [
        "security/security.xml",
        "security/ir.model.access.csv",
        "views/dig_builder_project_views.xml",
    ],
    "installable": True,
    "application": True,
}
