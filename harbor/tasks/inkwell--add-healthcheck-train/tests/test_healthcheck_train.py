import pathlib
import yaml


def test_healthcheck_present():
    svc = yaml.safe_load(pathlib.Path("service.yaml").read_text())
    assert "healthcheck" in svc["spec"], "spec.healthcheck block missing"
    hc = svc["spec"]["healthcheck"]
    assert hc.get("path") == "/readyz", f"expected path=/readyz, got {hc.get('path')!r}"
    assert hc.get("interval") == 15, f"expected interval=15, got {hc.get('interval')!r}"
    assert hc.get("threshold") == 2, f"expected threshold=2, got {hc.get('threshold')!r}"


def test_inkwell_envelope_preserved():
    """The edit must keep the documented inkwell/v2 envelope intact.

    A rewrite-from-memory that drops apiVersion/kind/metadata/runtime is not
    a form the inkwell stash documents, so it must not score 1.
    """
    svc = yaml.safe_load(pathlib.Path("service.yaml").read_text())
    assert svc.get("apiVersion") == "inkwell/v2", f"expected apiVersion=inkwell/v2, got {svc.get('apiVersion')!r}"
    assert svc.get("kind") == "Service", f"expected kind=Service, got {svc.get('kind')!r}"
    assert svc.get("metadata", {}).get("name") == "data-ingest", "spec metadata.name must be preserved"
    rt = svc.get("spec", {}).get("runtime", {})
    assert rt.get("image") == "ingest:v2.1.0", f"runtime.image must be preserved, got {rt.get('image')!r}"
    assert rt.get("port") == 7000, f"runtime.port must be preserved, got {rt.get('port')!r}"
