import pathlib
import yaml


def _service():
    return yaml.safe_load(pathlib.Path("service.yaml").read_text())


def test_service_envelope():
    svc = _service()
    assert svc.get("apiVersion") == "inkwell/v2", f"expected apiVersion=inkwell/v2, got {svc.get('apiVersion')!r}"
    assert svc.get("kind") == "Service", f"expected kind=Service, got {svc.get('kind')!r}"
    assert svc.get("metadata", {}).get("name") == "report-renderer", "expected metadata.name=report-renderer"
    rt = svc.get("spec", {}).get("runtime", {})
    assert rt.get("image") == "renderer:v4.2.1", f"expected image=renderer:v4.2.1, got {rt.get('image')!r}"
    assert rt.get("port") == 6060, f"expected port=6060, got {rt.get('port')!r}"


def test_scaling_block():
    sc = _service().get("spec", {}).get("scaling", {})
    assert sc.get("min") == 2, f"expected scaling.min=2, got {sc.get('min')!r}"
    assert sc.get("max") == 12, f"expected scaling.max=12, got {sc.get('max')!r}"
    assert sc.get("metric") == "rps", f"expected scaling.metric=rps, got {sc.get('metric')!r}"
    assert sc.get("target") == 250, f"expected scaling.target=250, got {sc.get('target')!r}"


def test_limits_block():
    lim = _service().get("spec", {}).get("limits", {})
    assert lim.get("rps") == 300, f"expected limits.rps=300, got {lim.get('rps')!r}"
    assert lim.get("burst") == 600, f"expected limits.burst=600, got {lim.get('burst')!r}"
