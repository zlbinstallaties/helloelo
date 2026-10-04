import json
import os
import urllib.error
import urllib.request


class ProviderError(Exception):
    pass


def _config() -> dict[str, dict[str, str]]:
    return {
        "openai": {
            "key": os.environ.get("OPENAI_API_KEY", ""),
            "model": os.environ.get("OPENAI_MODEL", ""),
        },
        "anthropic": {
            "key": os.environ.get("ANTHROPIC_API_KEY", ""),
            "model": os.environ.get("ANTHROPIC_MODEL", ""),
        },
    }


def statuses() -> list[dict]:
    result = []
    for name, values in _config().items():
        result.append(
            {
                "provider": name,
                "configured": bool(values["key"] and values["model"]),
                "model_configured": bool(values["model"]),
                "credential_configured": bool(values["key"]),
            }
        )
    return result


def _post(url: str, headers: dict[str, str], payload: dict) -> dict:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json", **headers},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise ProviderError(f"provider returned HTTP {error.code}") from error
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        raise ProviderError("provider request failed") from error


def test(provider: str, requested_model: str | None, prompt: str) -> dict:
    config = _config().get(provider)
    if config is None:
        raise ProviderError("unknown provider")
    if not config["key"] or not config["model"]:
        raise ProviderError("provider_not_configured")
    model = requested_model or config["model"]

    if provider == "openai":
        data = _post(
            "https://api.openai.com/v1/responses",
            {"authorization": f"Bearer {config['key']}"},
            {"model": model, "input": prompt, "max_output_tokens": 128},
        )
        output = "\n".join(
            item.get("text", "")
            for item in data.get("output", [])
            for content in item.get("content", [])
            if (content.get("type") == "output_text")
        ).strip()
        return {"provider": provider, "model": model, "ok": bool(data.get("id")), "text": output}

    data = _post(
        "https://api.anthropic.com/v1/messages",
        {"x-api-key": config["key"], "anthropic-version": "2023-06-01"},
        {"model": model, "max_tokens": 128, "messages": [{"role": "user", "content": prompt}]},
    )
    content = data.get("content", [])
    output = "\n".join(item.get("text", "") for item in content if item.get("type") == "text").strip()
    return {"provider": provider, "model": model, "ok": bool(data.get("id")), "text": output}
