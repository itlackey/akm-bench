import pathlib
import yaml


def test_limits_present():
    svc = yaml.safe_load(pathlib.Path("service.yaml").read_text())
    assert "limits" in svc["spec"], "spec.limits block missing"
    lim = svc["spec"]["limits"]
    assert lim.get("rps") == 500, f"expected rps=500, got {lim.get('rps')!r}"
    assert lim.get("burst") == 1000, f"expected burst=1000, got {lim.get('burst')!r}"


def test_inkwell_envelope_preserved():
    """The edit must keep the documented inkwell/v2 envelope intact.

    A rewrite-from-memory that drops apiVersion/kind/metadata/runtime is not
    a form the inkwell stash documents, so it must not score 1.
    """
    svc = yaml.safe_load(pathlib.Path("service.yaml").read_text())
    assert svc.get("apiVersion") == "inkwell/v2", f"expected apiVersion=inkwell/v2, got {svc.get('apiVersion')!r}"
    assert svc.get("kind") == "Service", f"expected kind=Service, got {svc.get('kind')!r}"
    assert svc.get("metadata", {}).get("name") == "data-api", "spec metadata.name must be preserved"
    rt = svc.get("spec", {}).get("runtime", {})
    assert rt.get("image") == "data-api:v2.1.0", f"runtime.image must be preserved, got {rt.get('image')!r}"
    assert rt.get("port") == 9000, f"runtime.port must be preserved, got {rt.get('port')!r}"
