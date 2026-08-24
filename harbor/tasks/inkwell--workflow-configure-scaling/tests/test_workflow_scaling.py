import yaml, pathlib, pytest

SERVICE = pathlib.Path("service.yaml")

def test_scaling_config():
    doc = yaml.safe_load(SERVICE.read_text())
    spec = doc["spec"]
    scaling = spec.get("scaling", {})
    assert scaling.get("min") == 2, f"expected min=2, got {scaling.get('min')}"
    assert scaling.get("max") == 20, f"expected max=20, got {scaling.get('max')}"
    assert scaling.get("metric") == "rps", f"expected metric=rps, got {scaling.get('metric')}"
    assert scaling.get("target") == 100, f"expected target=100, got {scaling.get('target')}"


def test_inkwell_envelope_preserved():
    """The edit must keep the documented inkwell/v2 envelope intact.

    A rewrite-from-memory that drops apiVersion/kind/metadata/runtime is not
    a form the inkwell stash documents, so it must not score 1.
    """
    svc = yaml.safe_load(pathlib.Path("service.yaml").read_text())
    assert svc.get("apiVersion") == "inkwell/v2", f"expected apiVersion=inkwell/v2, got {svc.get('apiVersion')!r}"
    assert svc.get("kind") == "Service", f"expected kind=Service, got {svc.get('kind')!r}"
    assert svc.get("metadata", {}).get("name") == "inkwell-app", "spec metadata.name must be preserved"
    rt = svc.get("spec", {}).get("runtime", {})
    assert rt.get("image") == "inkwell:v1.0.0", f"runtime.image must be preserved, got {rt.get('image')!r}"
    assert rt.get("port") == 8080, f"runtime.port must be preserved, got {rt.get('port')!r}"
