import pathlib
import yaml


def test_scaling_config():
    svc = yaml.safe_load(pathlib.Path("service.yaml").read_text())
    assert "scaling" in svc["spec"], "spec.scaling block missing"
    sc = svc["spec"]["scaling"]
    assert sc.get("min") == 2, f"expected min=2, got {sc.get('min')!r}"
    assert sc.get("max") == 20, f"expected max=20, got {sc.get('max')!r}"
    assert sc.get("metric") == "rps", f"expected metric=rps, got {sc.get('metric')!r}"
    assert sc.get("target") == 100, f"expected target=100, got {sc.get('target')!r}"


def test_inkwell_envelope_preserved():
    """The edit must keep the documented inkwell/v2 envelope intact.

    A rewrite-from-memory that drops apiVersion/kind/metadata/runtime is not
    a form the inkwell stash documents, so it must not score 1.
    """
    svc = yaml.safe_load(pathlib.Path("service.yaml").read_text())
    assert svc.get("apiVersion") == "inkwell/v2", f"expected apiVersion=inkwell/v2, got {svc.get('apiVersion')!r}"
    assert svc.get("kind") == "Service", f"expected kind=Service, got {svc.get('kind')!r}"
    assert svc.get("metadata", {}).get("name") == "worker-pool", "spec metadata.name must be preserved"
    rt = svc.get("spec", {}).get("runtime", {})
    assert rt.get("image") == "worker:v3.0.1", f"runtime.image must be preserved, got {rt.get('image')!r}"
    assert rt.get("port") == 8080, f"runtime.port must be preserved, got {rt.get('port')!r}"
