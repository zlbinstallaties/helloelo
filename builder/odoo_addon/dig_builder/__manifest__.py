{
    "name": "DIG Builder",
    "version": "20.0.0.1.0",
    "category": "Tools",
    "summary": "Admin-only proposal workflow for DIG extensions",
    "license": "LGPL-3",
    "depends": ["base", "web", "planning", "sale_management"],
    "data": [
        "security/security.xml",
        "security/ir.access.csv",
        "data/ir_cron.xml",
        "views/dig_builder_project_views.xml",
    ],
    "assets": {
        "web.assets_backend": [
            "dig_builder/static/src/js/dig_builder_app.js",
            "dig_builder/static/src/xml/dig_builder_app.xml",
            "dig_builder/static/src/scss/dig_builder_app.scss",
        ],
    },
    "installable": True,
    "application": True,
}
