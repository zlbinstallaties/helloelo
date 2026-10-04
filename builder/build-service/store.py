import json
import hashlib
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

    @staticmethod
    def _task_key(payload: dict) -> str:
        environment = os.environ.get("BUILDER_ENVIRONMENT", "default")
        return ":".join([
            environment,
            str(payload.get("company_id", "")),
            str(payload.get("project_id", "")),
            str(payload.get("client_request_id", "")),
        ])

    @staticmethod
    def _input_digest(payload: dict) -> str:
        encoded = json.dumps(payload, sort_keys=True, ensure_ascii=True, separators=(",", ":"))
        return hashlib.sha256(encoded.encode("utf-8")).hexdigest()

    def create_task(self, payload: dict) -> tuple[dict, bool]:
        with self._lock:
            data = self._read()
            task_key = self._task_key(payload)
            input_digest = self._input_digest(payload)
            existing = next((item for item in data.get("tasks", []) if item.get("task_key") == task_key), None)
            if existing is not None:
                if existing.get("input_digest") != input_digest:
                    raise ValueError("idempotency_key_reused_with_different_input")
                return existing, False
            task = {
                "id": secrets.token_urlsafe(12),
                "state": "queued",
                "payload": payload,
                "task_key": task_key,
                "input_digest": input_digest,
                "result": None,
                "error": None,
            }
            data.setdefault("tasks", []).append(task)
            self._write(data)
        return task, True

    def claim_task(self, task_id: str) -> dict | None:
        with self._lock:
            data = self._read()
            task = next((item for item in data.get("tasks", []) if item["id"] == task_id), None)
            if task is None or task.get("state") != "queued":
                return None
            task["state"] = "running"
            self._write(data)
            return task

    def interrupt_tasks(self, task_ids: list[str]) -> None:
        with self._lock:
            data = self._read()
            changed = False
            for task in data.get("tasks", []):
                if task["id"] in task_ids and task.get("state") == "running":
                    task["state"] = "interrupted"
                    task["error"] = "builder_service_restarted_request_status_unknown"
                    changed = True
            if changed:
                self._write(data)

    def get_task(self, task_id: str) -> dict | None:
        with self._lock:
            return next((task for task in self._read().get("tasks", []) if task["id"] == task_id), None)

    def task_ids_in_states(self, states: set[str]) -> list[str]:
        with self._lock:
            return [task["id"] for task in self._read().get("tasks", []) if task.get("state") in states]

    def update_task(self, task_id: str, **changes: object) -> dict | None:
        with self._lock:
            data = self._read()
            task = next((item for item in data.get("tasks", []) if item["id"] == task_id), None)
            if task is None:
                return None
            task.update(changes)
            self._write(data)
            return task
