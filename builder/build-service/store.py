import json
import os
import secrets
import tempfile
import threading
from pathlib import Path


class Store:
    """Small JSON store for phase 2; replace with a transactional database later."""

    def __init__(self) -> None:
        self.root = Path(os.environ.get("BUILDER_DATA_DIR", "/data"))
        self.path = self.root / "builder.json"
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()

    def _read(self) -> dict:
        if not self.path.exists():
            return {"projects": []}
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError("builder store is unreadable") from error

    def _write(self, value: dict) -> None:
        fd, name = tempfile.mkstemp(prefix="builder-", suffix=".json", dir=self.root)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(value, handle, ensure_ascii=True, indent=2)
                handle.write("\n")
            os.replace(name, self.path)
        finally:
            if os.path.exists(name):
                os.unlink(name)

    def list_projects(self) -> list[dict]:
        with self._lock:
            return self._read()["projects"]

    def get_project(self, project_id: str) -> dict | None:
        with self._lock:
            return next((project for project in self._read()["projects"] if project["id"] == project_id), None)

    def create_project(
        self,
        description: str,
        provider: str,
        model: str,
        metadata: dict | None = None,
        conversation: list[dict] | None = None,
    ) -> dict:
        metadata = metadata or {"version": "odoo20-v1", "company_id": None, "models": []}
        project = {
            "id": secrets.token_urlsafe(12),
            "description": description,
            "provider": provider,
            "model": model,
            "metadata": metadata,
            "metadata_version": metadata["version"],
            "conversation": conversation or [],
            "state": "draft",
            "proposal": None,
            "created_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        }
        with self._lock:
            data = self._read()
            data["projects"].append(project)
            self._write(data)
        return project

    def set_proposal(self, project_id: str, proposal: str) -> dict | None:
        with self._lock:
            data = self._read()
            project = next((item for item in data["projects"] if item["id"] == project_id), None)
            if project is None:
                return None
            project["proposal"] = proposal
            project["state"] = "proposed"
            self._write(data)
            return project
