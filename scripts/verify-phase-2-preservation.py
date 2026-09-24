import hashlib
import json
import subprocess
from pathlib import Path

workspace = Path(__file__).resolve().parents[3]
artifacts = workspace / ".cartera/harness/artifacts"
baseline = json.loads((artifacts / "preflight-workspace-state.json").read_text())
prior = json.loads((artifacts / "phase-2-workspace-preservation.json").read_text())
report = {}
for repository, original in baseline.items():
    def git(*arguments):
        return subprocess.check_output(["git", "--no-optional-locks", "-C", str(workspace / repository), *arguments], text=True).rstrip("\n")
    status = git("status", "--short")
    head = git("rev-parse", "HEAD")
    branch = git("branch", "--show-current")
    changed = [path for path, digest in original["files"].items()
               if not (workspace / path).is_file() or hashlib.sha256((workspace / path).read_bytes()).hexdigest() != digest]
    report[repository] = {"HEAD": head, "branch": branch,
        "status_unchanged": status == original["status"].rstrip("\n"),
        "changed_paths": changed, "files_compared": len(original["files"]),
        "deletions": sum("D" in line[:2] for line in status.splitlines())}
    assert head == prior[repository]["HEAD"] and branch == prior[repository]["branch"]
    assert report[repository]["status_unchanged"] and not changed, repository
assert report["cartera-frontend"]["deletions"] == 299
(artifacts / "phase-2-completion-workspace-preservation.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
