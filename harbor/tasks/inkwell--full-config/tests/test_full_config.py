import yaml, pathlib

SERVICE = pathlib.Path("service.yaml")

def test_full_config():
    doc = yaml.safe_load(SERVICE.read_text())
    spec = doc["spec"]
    s = spec.get("scaling", {})
    assert s.get("min") == 2, f"expected scaling.min=2, got {s.get('min')}"
    assert s.get("max") == 10, f"expected scaling.max=10, got {s.get('max')}"
    assert s.get("metric") == "rps", f"expected metric=rps, got {s.get('metric')}"
    assert s.get("target") == 150, f"expected target=150, got {s.get('target')}"
    h = spec.get("healthcheck", {})
    assert h.get("path") == "/health", f"expected path=/health, got {h.get('path')}"
    assert h.get("interval") == 15, f"expected interval=15, got {h.get('interval')}"
    assert h.get("threshold") == 3, f"expected threshold=3, got {h.get('threshold')}"
    l = spec.get("limits", {})
    assert l.get("rps") == 200, f"expected limits.rps=200, got {l.get('rps')}"
    assert l.get("burst") == 400, f"expected limits.burst=400, got {l.get('burst')}"


def test_inkwell_envelope_preserved():
    """The edit must keep the documented inkwell/v2 envelope intact.

    A rewrite-from-memory that drops apiVersion/kind/metadata/runtime is not
    a form the inkwell stash documents, so it must not score 1.
    """
    svc = yaml.safe_load(pathlib.Path("service.yaml").read_text())
    assert svc.get("apiVersion") == "inkwell/v2", f"expected apiVersion=inkwell/v2, got {svc.get('apiVersion')!r}"
    assert svc.get("kind") == "Service", f"expected kind=Service, got {svc.get('kind')!r}"
    assert svc.get("metadata", {}).get("name") == "web-app", "spec metadata.name must be preserved"
    rt = svc.get("spec", {}).get("runtime", {})
    assert rt.get("image") == "webapp:v2.1.0", f"runtime.image must be preserved, got {rt.get('image')!r}"
    assert rt.get("port") == 3000, f"runtime.port must be preserved, got {rt.get('port')!r}"
