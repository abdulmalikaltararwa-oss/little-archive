"""Publish a minimal, sanitized test report; never upload browser session capture."""
import html
import os
from pathlib import Path
import re
import shutil
import sys
import xml.etree.ElementTree as ET


def redact(value, password):
    if password:
        value = value.replace(password, "[ephemeral credential]")
    # Sessions/CSRF/import tokens are long random URL-safe strings. Redacting
    # unrelated long hashes too is preferable to publishing an auth credential.
    return re.sub(r"[A-Za-z0-9_-]{43,}", "[redacted ephemeral value]", value)


def sanitize(root):
    results = root / "test-results"
    reports = root / "playwright-report"
    password = os.environ.get("LA_E2E_OWNER_PASSWORD", "")
    if not password:
        raise ValueError("Sanitizing requires this run's generated credential")
    if reports.exists():
        shutil.rmtree(reports)
    reports.mkdir(parents=True)
    cases = []
    if results.exists():
        for file in results.rglob("*"):
            if not file.is_file():
                continue
            if file.suffix.lower() in {".xml", ".log", ".txt", ".md", ".json"}:
                file.write_text(redact(file.read_text(encoding="utf-8"), password), encoding="utf-8")
            else:
                # Backup downloads are validated during the tests, then removed.
                # Binary artifacts cannot be safely inspected by this redactor.
                file.unlink()
        for report in sorted(results.glob("*.xml")):
            for case in ET.parse(report).getroot().iter("testcase"):
                failure = case.find("failure")
                error = case.find("error")
                skipped = case.find("skipped")
                problem = failure if failure is not None else error
                status = "failed" if problem is not None else "skipped" if skipped is not None else "passed"
                cases.append({
                    "name": case.get("name", "Test"), "group": case.get("classname", ""),
                    "time": case.get("time", "0"), "status": status,
                    "detail": (problem.text or problem.get("message", "")) if problem is not None else "",
                })
    rows = []
    for case in cases:
        details = f'<details><summary>Failure details</summary><pre>{html.escape(case["detail"])}</pre></details>' if case["detail"] else ""
        rows.append(f'<tr><td>{html.escape(case["group"])}</td><td>{html.escape(case["name"])}{details}</td><td class="{case["status"]}">{case["status"]}</td><td>{html.escape(case["time"])}s</td></tr>')
    passed = sum(case["status"] == "passed" for case in cases)
    failed = sum(case["status"] == "failed" for case in cases)
    page = f'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Little Archive browser checks</title>
<style>body{{font:16px system-ui;max-width:1100px;margin:40px auto;padding:0 24px;background:#f7f4ef;color:#25372c}}table{{border-collapse:collapse;width:100%;background:white}}th,td{{padding:14px;text-align:left;border-bottom:1px solid #dcded5;vertical-align:top}}pre{{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}}.passed{{color:#32633b}}.failed{{color:#9f3030}}</style>
<h1>Authenticated browser checks</h1><p>{passed} passed · {failed} failed · {len(cases)} test cases</p><p>Real isolated server and browser sessions. Synthetic records only. Session traces and screenshots are disabled; authentication values are redacted from these results.</p>
<table><thead><tr><th>Browser / file</th><th>Test</th><th>Result</th><th>Time</th></tr></thead><tbody>{"".join(rows)}</tbody></table></html>'''
    (reports / "index.html").write_text(redact(page, password), encoding="utf-8")


if __name__ == "__main__":
    sanitize(Path(sys.argv[1]).resolve())
