import hmac
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from providers import ProviderError, statuses, test
from store import Store


store = Store()


def json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict) -> None:
    body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
    handler.send_response(status)
    handler.send_header("content-type", "application/json")
    handler.send_header("content-length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def is_admin(handler: BaseHTTPRequestHandler) -> bool:
    expected = os.environ.get("BUILDER_ADMIN_TOKEN", "")
    supplied = handler.headers.get("authorization", "")
    supplied = supplied.removeprefix("Bearer ")
    return bool(expected and supplied and hmac.compare_digest(expected, supplied))


def project_id_from_path(path: str) -> str | None:
    prefix = "/api/projects/"
    if path.startswith(prefix) and path.endswith("/proposal"):
        project_id = path[len(prefix) : -len("/proposal")].strip("/")
        return project_id or None
    return None


class Handler(BaseHTTPRequestHandler):
    server_version = "DIGBuilder/0.1"

    def log_message(self, format: str, *args: object) -> None:
        # Never log request bodies, authorization headers, prompts or provider output.
        return

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/healthz":
            json_response(self, 200, {"status": "ok", "service": "builder-api"})
            return
        if not is_admin(self):
            json_response(self, 403, {"error": "admin_required"})
            return
        if path == "/api/providers":
            json_response(self, 200, {"providers": statuses()})
            return
        if path == "/api/projects":
            json_response(self, 200, {"projects": store.list_projects()})
            return
        if path.startswith("/api/projects/"):
            project_id = path.removeprefix("/api/projects/").strip("/")
            project = store.get_project(project_id)
            if project is not None:
                json_response(self, 200, {"project": project})
                return
        json_response(self, 404, {"error": "not_found"})

    def do_POST(self) -> None:
        if not is_admin(self):
            json_response(self, 403, {"error": "admin_required"})
            return
        path = urlparse(self.path).path
        try:
            length = int(self.headers.get("content-length", "0"))
            if length > 64 * 1024:
                json_response(self, 413, {"error": "request_too_large"})
                return
            raw = self.rfile.read(length) if length else b"{}"
            payload = json.loads(raw.decode("utf-8"))
        except (ValueError, json.JSONDecodeError):
            json_response(self, 400, {"error": "invalid_json"})
            return

        if path == "/api/providers/test":
            provider = payload.get("provider")
            prompt = payload.get("prompt", "DIG Builder provider connectivity test")
            model = payload.get("model")
            if (
                not isinstance(provider, str)
                or not isinstance(prompt, str)
                or not isinstance(model, (str, type(None)))
                or (isinstance(model, str) and len(model) > 200)
                or len(prompt) > 2000
            ):
                json_response(self, 400, {"error": "invalid_provider_test"})
                return
            try:
                json_response(self, 200, {"result": test(provider, model, prompt)})
            except ProviderError as error:
                json_response(self, 503, {"error": str(error)})
            return

        if path == "/api/projects":
            description = payload.get("description", "")
            provider = payload.get("provider", "")
            model = payload.get("model", "")
            if not isinstance(description, str) or not description.strip() or len(description) > 20_000:
                json_response(self, 400, {"error": "description_required"})
                return
            if provider not in {"openai", "anthropic"}:
                json_response(self, 400, {"error": "explicit_provider_required"})
                return
            if not isinstance(model, str) or not model.strip() or len(model) > 200:
                json_response(self, 400, {"error": "model_required"})
                return
            json_response(self, 201, {"project": store.create_project(description.strip(), provider, model.strip())})
            return

        project_id = project_id_from_path(path)
        if project_id is not None:
            project = store.get_project(project_id)
            if project is None:
                json_response(self, 404, {"error": "project_not_found"})
                return
            prompt = (
                "Create a concise implementation proposal for an Odoo 20 addon. "
                "Return requirements, affected standard models, files to create, tests, "
                "security controls, and unresolved questions. Do not claim that code was "
                "built or tested.\n\nUser request:\n" + project["description"]
            )
            try:
                result = test(project["provider"], project["model"], prompt)
            except ProviderError as error:
                json_response(self, 503, {"error": str(error)})
                return
            if not result.get("text"):
                json_response(self, 502, {"error": "provider_empty_response"})
                return
            json_response(self, 200, {"project": store.set_proposal(project_id, result["text"])})
            return

        json_response(self, 404, {"error": "not_found"})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
