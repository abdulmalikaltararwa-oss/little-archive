#!/usr/bin/env python3
"""Verify real Compose image replacement, retained-data removal, and rollback.

Requires Python 3.10+, Docker, Compose, and two already-built local images.
Each image must carry org.opencontainers.image.revision with its full Git SHA.
Only uniquely named, run-labelled projects, containers, networks, and volumes
are created or removed. No existing .env, Compose project, or library is used.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import secrets
import shutil
import signal
import socket
import sys
import tempfile
from urllib.parse import urlencode

from container_smoke import Client, Harness, LABEL, VerificationError, require, synthetic_png, timestamp


REVISION_LABEL = "org.opencontainers.image.revision"


class UpgradeHarness(Harness):
    def __init__(self, args, temporary):
        # Reuse the bounded Docker/HTTP, backup, restore and hardening helpers.
        # Restore always uses the previous image, never the replacement image.
        args.image = args.previous_image
        super().__init__(args, temporary)
        self.prefix = "little-archive-upgrade-" + self.run_id
        self.projects = {}
        self.networks = []
        self.report = {
            "format": "little-archive-upgrade-verification",
            "started_at": timestamp(), "status": "running", "checks": [],
            "previous_ref": args.previous_ref, "candidate_ref": args.candidate_ref,
            "images": {}, "deployments": {}, "runtime_probes": {},
        }

    def inspect_network(self, name):
        result = self.docker("network", "inspect", name, check=False)
        if result.returncode:
            detail = result.stderr.decode(errors="replace")
            if "no such network" in detail.lower() or re.search(r"network .+ not found", detail, re.IGNORECASE):
                return None
            raise VerificationError("Network inspection failed: " + self.redact(detail[-1200:]))
        return json.loads(result.stdout)[0]

    def inspect_images(self):
        for role in ("previous", "candidate"):
            image = self.inspect("image", getattr(self.args, role + "_image"))
            require(image is not None, f"Build or load the {role} image before running this gate.")
            revision = (image.get("Config", {}).get("Labels") or {}).get(REVISION_LABEL)
            require(revision == getattr(self.args, role + "_ref"), f"The {role} image revision label does not match its requested source SHA.")
            platform = image["Os"] + "/" + image["Architecture"]
            require(platform in {"linux/amd64", "linux/arm64"}, "Use a supported Linux application image.")
            self.report["images"][role] = {
                "source_ref": revision, "image_id": image["Id"], "image_platform": platform,
            }
        before, after = self.report["images"]["previous"], self.report["images"]["candidate"]
        require(before["image_id"] != after["image_id"], "The previous and candidate image IDs are identical; no replacement would be tested.")
        require(before["image_platform"] == after["image_platform"], "Previous and candidate images must use the same native platform.")
        if self.args.platform:
            require(self.args.platform == before["image_platform"], "The images differ from the requested platform.")
        self.args.platform = before["image_platform"]
        self.args.image = before["image_id"]
        self.record("distinct_source_revision_labels_and_image_ids", platform=self.args.platform)

    def plan_project(self, role, image_id, password, *, volume=None, data_dir="/data"):
        project = self.prefix + "-" + role
        name, network = project + "-archive", project + "-default"
        require(self.inspect("container", name) is None, "A generated container name already exists.")
        require(self.inspect_network(network) is None, "A generated Compose network already exists.")
        external = volume is not None
        if not external:
            volume = project + "-archive-data"
            require(self.inspect("volume", volume) is None, "A generated Compose volume already exists.")
            self.volumes.append(volume)
        else:
            owned = self.inspect("volume", volume)
            require(owned and (owned.get("Labels") or {}).get(LABEL) == self.run_id, "Rollback requires a fresh volume owned by this verification run.")
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        origin = f"http://127.0.0.1:{port}"
        env_path, config_path = self.temporary / (role + ".env"), self.temporary / (role + ".compose.json")
        with env_path.open("x", encoding="utf-8") as stream:
            env_path.chmod(0o600)
            stream.write(f"LA_ADMIN_PASSWORD={password}\nLA_PUBLIC_URL={origin}\nLA_DATA_DIR={data_dir}\nLA_OLLAMA_URL=\nLA_OLLAMA_MODEL=\n")
        labels = {LABEL: self.run_id}
        definition = {
            "services": {"archive": {
                "image": image_id, "pull_policy": "never", "container_name": name,
                "labels": labels, "env_file": [str(env_path)], "restart": "unless-stopped",
                "ports": [f"127.0.0.1:{port}:8787"], "volumes": ["archive-data:/data"],
                "read_only": True, "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"],
                "tmpfs": ["/tmp:size=512m,mode=1777"],
            }},
            "volumes": {"archive-data": {"name": volume, **({"external": True} if external else {"labels": labels})}},
            "networks": {"default": {"name": network, "labels": labels}},
        }
        with config_path.open("x", encoding="utf-8") as stream:
            config_path.chmod(0o600)
            json.dump(definition, stream)
        self.containers.append(name)
        self.networks.append(network)
        self.projects[role] = {
            "project": project, "name": name, "volume": volume, "network": network,
            "origin": origin, "env": env_path, "env_bytes": env_path.read_bytes(),
            "config": config_path, "definition": definition, "data_dir": data_dir,
        }
        return Client(origin)

    def compose(self, role, *args, timeout=90):
        project = self.projects[role]
        # Explicit paths/project prevent ambient .env or Compose discovery.
        return self.docker(
            "compose", "--project-directory", str(self.temporary),
            "--env-file", str(project["env"]), "--file", str(project["config"]),
            "--project-name", project["project"], *args, timeout=timeout,
        )

    def change_image(self, role, image_id):
        project = self.projects[role]
        project["definition"]["services"]["archive"]["image"] = image_id
        project["config"].write_text(json.dumps(project["definition"]), encoding="utf-8")

    def check_deployment(self, role, expected_image, phase, owner):
        project = self.projects[role]
        self.wait_ready(project["name"], owner)
        state = self.inspect("container", project["name"])
        labels = state.get("Config", {}).get("Labels") or {}
        require(labels.get(LABEL) == self.run_id and labels.get("com.docker.compose.project") == project["project"], "The service is not owned by the expected Compose project.")
        require(state["Image"] == expected_image, "The running service uses the wrong image; image replacement was not established.")
        mounts = [mount for mount in state["Mounts"] if mount["Destination"] == "/data"]
        require(len(mounts) == 1 and mounts[0]["Type"] == "volume" and mounts[0]["RW"], "The service does not use one writable named library volume.")
        mount = mounts[0]
        require(mount["Name"] == project["volume"], "The service mounted a different library volume.")
        if "mount_source" in project:
            require(project["mount_source"] == mount["Source"], "The named volume's actual mount source changed.")
        else:
            project["mount_source"] = mount["Source"]
        require(project["env"].read_bytes() == project["env_bytes"], "The private configuration changed during the lifecycle check.")
        self.verify_hardening(project["name"])
        self.report["runtime_probes"][phase] = self.report.pop("runtime")
        health = owner.json("GET", "/api/health")
        self.report["deployments"][phase] = {
            "container_id": state["Id"], "image_id": state["Image"],
            "compose_project": project["project"], "volume_name": mount["Name"],
            "mount_source_sha256": hashlib.sha256(mount["Source"].encode()).hexdigest(),
            "application_version": health.get("version"), "private_configuration_unchanged": True,
        }
        return state

    def source_digest(self, role):
        code = """from pathlib import Path
import hashlib
root=Path('/app'); digest=hashlib.sha256()
for folder in ('server', 'web'):
    for path in sorted((root/folder).rglob('*')):
        if path.is_file() and '__pycache__' not in path.parts and path.suffix != '.pyc':
            digest.update(path.relative_to(root).as_posix().encode()); digest.update(bytes([0]))
            digest.update(path.read_bytes()); digest.update(bytes([0]))
print(digest.hexdigest())
"""
        value = self.docker("exec", self.projects[role]["name"], "python", "-c", code).stdout.decode().strip()
        require(re.fullmatch(r"[0-9a-f]{64}", value) is not None, "The packaged-source fingerprint is invalid.")
        return value

    def edit_flags(self, role):
        code = """import json,sqlite3,sys
c=sqlite3.connect('file:'+sys.argv[1]+'/library.sqlite3?mode=ro',uri=True)
print(json.dumps(c.execute('SELECT id,manual_title,manual_summary FROM items ORDER BY id').fetchall()))
"""
        project = self.projects[role]
        return json.loads(self.docker("exec", project["name"], "python", "-c", code, project["data_dir"]).stdout)

    def snapshot(self, owner):
        result = super().snapshot(owner)
        # The previous export predates these two public export fields. Their
        # underlying database values are independently checked by edit_flags.
        for item in result["items"]:
            item.pop("manual_title", None)
            item.pop("manual_summary", None)
        return result

    def check_existing_auth(self, owner, extension, token, cookie, instance_id, item_id):
        require(owner.cookie() == cookie, "The original owner cookie was replaced before persistence could be tested.")
        # An empty PATCH exercises owner session + Origin + retained CSRF and
        # preserves timestamps, so exact content comparisons remain meaningful.
        owner.json("PATCH", "/api/items/" + item_id, payload={})
        identity = extension.json("GET", "/api/extension/status", headers={"Authorization": "Bearer " + token})["instance_id"]
        require(identity == instance_id, "The update/removal unexpectedly changed instance identity or import-token access.")
        extension.request("GET", "/api/items", headers={"Authorization": "Bearer " + token}, expected=401)

    def fresh_login(self, origin, password):
        client = Client(origin)
        client.login(password)
        self.secrets += [client.cookie(), client.csrf]
        return client

    def run(self):
        self.report["docker_engine"] = self.docker("info", "--format", "{{.ServerVersion}}", timeout=20).stdout.decode().strip()
        self.report["docker_compose"] = self.docker("compose", "version", "--short", timeout=20).stdout.decode().strip()
        self.inspect_images()
        old_id = self.report["images"]["previous"]["image_id"]
        candidate_id = self.report["images"]["candidate"]["image_id"]
        password, restored_password = secrets.token_urlsafe(30), secrets.token_urlsafe(30)
        self.secrets += [password, restored_password]
        owner = self.plan_project("source", old_id, password)
        self.compose("source", "up", "-d", "--no-build", "archive")
        old_state = self.check_deployment("source", old_id, "previous", owner)
        old_digest = self.source_digest("source")
        self.report["images"]["previous"]["packaged_source_sha256"] = old_digest
        Client(owner.origin).request("GET", "/api/items", expected=401)
        owner.login(password)
        original_cookie = owner.cookie()
        self.secrets += [original_cookie, owner.csrf]
        local = owner.json("POST", "/api/collections", payload={"name": "Upgrade local shelf", "color": "#735A93"})
        owner.json("POST", "/api/collections", payload={"name": "Empty retained shelf", "color": "#D5A7AC"})
        manual = owner.json("POST", "/api/items", payload={
            "url": "https://example.com/pre-upgrade-note", "title": "Before image replacement",
            "summary": "My summary", "notes": "Keep this note — محفوظ", "tags": ["before", "استعادة"],
            "collection_ids": [local["id"]],
        })
        owner.json("PATCH", "/api/items/" + manual["id"], payload={"favorite": True, "status": "done", "needs_review": False})
        media = owner.json("POST", f"/api/items/{manual['id']}/thumbnail", body=synthetic_png(), headers={"Content-Type": "image/png"})
        thumbnail_url = media["thumbnail_url"]
        thumbnail = owner.request("GET", thumbnail_url)
        token = owner.json("POST", "/api/extension/tokens", payload={"name": "Upgrade continuity check"})["token"]
        self.secrets.append(token)
        extension, bearer = Client(owner.origin), {"Authorization": "Bearer " + token}
        instance_id = extension.json("GET", "/api/extension/status", headers=bearer)["instance_id"]
        run = extension.json("POST", "/api/extension/imports", payload={"platform": "instagram", "source_account": "synthetic-upgrade", "scope": "Original recipe collection"}, headers=bearer)["run_id"]
        batch = extension.json("POST", f"/api/extension/imports/{run}/batches", payload={
            "batch_id": "synthetic-upgrade-batch", "sequence": 0, "items": [{
                "url": "https://www.instagram.com/p/UPGRADEVERIFY/", "title": "Synthetic source title",
                "caption": "Synthetic recipe caption", "thumbnail_alt": "Synthetic recipe cover",
                "collections": [{"source_key": "original-recipes", "name": "Original Recipes"}],
            }],
        }, headers=bearer)
        require(batch["created"] == 1, "The previous version did not ingest the synthetic source record.")
        extension.json("POST", f"/api/extension/imports/{run}/finish", payload={"expected_batches": 1, "coverage": "partial", "reason": "Synthetic lifecycle fixture"}, headers=bearer)
        source = next(item for item in owner.json("GET", "/api/items")["items"] if item["platform"] == "instagram")
        source = owner.json("PATCH", "/api/items/" + source["id"], payload={
            "title": "My source title", "summary": "", "notes": "Preserve original and local memberships",
            "tags": ["recipe", "mine"], "favorite": True, "status": "to_revisit", "collection_ids": [local["id"]],
        })
        require({entry["kind"] for entry in source["collections"]} == {"local", "source"}, "The fixture lacks overlapping original and local collection membership.")
        require(owner.json("GET", "/api/items?" + urlencode({"q": "محفوظ"}))["total"] == 1, "The previous version cannot find the Unicode fixture note.")
        before = self.snapshot(owner)
        before_flags = self.edit_flags("source")
        require(len(before["items"]) == 2 and len(before["collections"]) == 3, "The previous library has unexpected fixture counts.")
        old_hash = self.docker("exec", self.projects["source"]["name"], "python", "-c", "import sqlite3; c=sqlite3.connect('/data/library.sqlite3'); print(c.execute(\"SELECT value FROM meta WHERE key='password_hash'\").fetchone()[0])").stdout.decode().strip()
        self.secrets.append(old_hash)
        backup = owner.request("GET", "/api/backup")
        forbidden = [old_hash, owner.csrf, hashlib.sha256(original_cookie.encode()).hexdigest(), hashlib.sha256(token.encode()).hexdigest()]
        self.verify_backup(backup, 2, forbidden)
        self.report["pre_update_backup"] = {"sha256": hashlib.sha256(backup).hexdigest(), "items": 2, "local_assets_verified": True, "authentication_excluded": True}
        self.record("previous_compose_library_and_pre_update_backup", items=2, collections=3)

        # Images are prepared before this script. Match the documented stop /
        # up replacement while retaining the same project, env and named disk.
        self.compose("source", "stop", "archive")
        self.change_image("source", candidate_id)
        self.compose("source", "up", "-d", "--no-build", "archive")
        updated_state = self.check_deployment("source", candidate_id, "candidate", owner)
        require(updated_state["Id"] != old_state["Id"], "Compose did not replace the old service container.")
        candidate_digest = self.source_digest("source")
        require(candidate_digest != old_digest, "The packaged application source is identical; this is not a version-replacement check.")
        self.report["images"]["candidate"]["packaged_source_sha256"] = candidate_digest
        self.check_existing_auth(owner, extension, token, original_cookie, instance_id, manual["id"])
        require(self.snapshot(owner) == before and self.edit_flags("source") == before_flags, "Image replacement changed records, collections, timestamps, or edit-protection flags.")
        require(owner.request("GET", thumbnail_url) == thumbnail, "Image replacement changed local thumbnail bytes.")
        self.fresh_login(owner.origin, password)
        self.record("image_replacement_preserves_project_volume_original_session_csrf_token_and_library")

        sentinel = owner.json("POST", "/api/items", payload={"url": "https://example.com/post-upgrade-sentinel", "title": "Created only after replacement", "notes": "Must remain in the updated library and must not appear in pre-update rollback."})
        after = self.snapshot(owner)
        after_flags = self.edit_flags("source")
        require(len(after["items"]) == 3 and sentinel["id"] not in {item["id"] for item in before["items"]}, "The candidate-only sentinel was not created.")
        self.verify_backup(owner.request("GET", "/api/backup"), 3, forbidden)
        self.record("candidate_accepts_new_writes_and_produces_valid_backup")

        volume_name = self.projects["source"]["volume"]
        volume_before = self.inspect("volume", volume_name)
        # Deliberately the documented retain-data command: no -v/--volumes.
        self.compose("source", "down")
        require(self.inspect("container", self.projects["source"]["name"]) is None, "Compose down did not remove the service container.")
        require(self.inspect_network(self.projects["source"]["network"]) is None, "Compose down did not remove the owned project network.")
        volume_after = self.inspect("volume", volume_name)
        require(volume_after is not None and all(volume_after.get(key) == volume_before.get(key) for key in ("Name", "Mountpoint", "CreatedAt", "Labels")), "Compose down removed or replaced the library volume.")
        self.compose("source", "up", "-d", "--no-build", "archive")
        retained_state = self.check_deployment("source", candidate_id, "after_down_up", owner)
        require(retained_state["Id"] != updated_state["Id"], "The retain-data check did not recreate the service.")
        self.check_existing_auth(owner, extension, token, original_cookie, instance_id, manual["id"])
        require(self.snapshot(owner) == after and self.edit_flags("source") == after_flags, "Compose down/up did not preserve the complete updated library.")
        require(owner.request("GET", thumbnail_url) == thumbnail, "Compose down/up changed the local thumbnail.")
        self.fresh_login(owner.origin, password)
        self.record("compose_down_without_volumes_retains_data_and_authentication")

        rollback_volume = self.new_volume("rollback-data")
        require(rollback_volume != volume_name, "Rollback must never use the updated library volume.")
        self.restore(rollback_volume, backup)
        rollback = self.plan_project("rollback", old_id, restored_password, volume=rollback_volume, data_dir="/data/restored")
        self.compose("rollback", "up", "-d", "--no-build", "archive")
        self.check_deployment("rollback", old_id, "rollback_previous", rollback)
        require(self.projects["rollback"]["mount_source"] != self.projects["source"]["mount_source"], "Rollback and updated services share a writable volume source.")
        require(self.source_digest("rollback") == old_digest, "Rollback did not start the previous packaged application source.")
        stale = Client(rollback.origin)
        stale.request("GET", "/api/items", headers={"Cookie": "little_archive_session=" + original_cookie}, expected=401)
        stale.request("GET", "/api/extension/status", headers=bearer, expected=401)
        stale.request("POST", "/api/auth/login", payload={"password": password}, expected=401)
        rollback.login(restored_password)
        self.secrets += [rollback.cookie(), rollback.csrf]
        require(self.snapshot(rollback) == before and self.edit_flags("rollback") == before_flags, "Rollback did not exactly restore the pre-update records, memberships, or edit flags.")
        require(rollback.request("GET", thumbnail_url) == thumbnail, "Rollback changed the pre-update local thumbnail.")
        require(rollback.json("GET", "/api/items?" + urlencode({"q": "Created only after replacement"}))["total"] == 0, "Rollback mistakenly used a post-update backup.")
        require(rollback.json("GET", "/api/extension/tokens")["tokens"] == [], "Rollback revived old extension credentials.")
        fresh_token = rollback.json("POST", "/api/extension/tokens", payload={"name": "Fresh rollback import token"})["token"]
        self.secrets.append(fresh_token)
        recovered_identity = Client(rollback.origin).json("GET", "/api/extension/status", headers={"Authorization": "Bearer " + fresh_token})["instance_id"]
        require(recovered_identity != instance_id, "Rollback did not receive a fresh instance identity.")
        self.record("previous_image_restores_pre_update_backup_to_separate_fresh_volume")
        self.record("rollback_requires_fresh_password_session_token_and_instance_identity")

        final_state = self.check_deployment("source", candidate_id, "original_after_rollback", owner)
        require(final_state["Id"] == retained_state["Id"], "Rollback replaced the original upgraded container.")
        self.check_existing_auth(owner, extension, token, original_cookie, instance_id, manual["id"])
        require(self.snapshot(owner) == after and self.edit_flags("source") == after_flags, "Rollback altered the upgraded original library or its candidate-only sentinel.")
        require(owner.request("GET", thumbnail_url) == thumbnail, "Rollback altered the upgraded original asset.")
        self.record("upgraded_original_remains_unchanged_after_separate_rollback")

    def cleanup(self):
        errors = super().cleanup()
        for name in reversed(self.networks):
            try:
                network = self.inspect_network(name)
                if network is None:
                    continue
                require((network.get("Labels") or {}).get(LABEL) == self.run_id, "Cleanup refused a network without this run's ownership label.")
                self.docker("network", "rm", name, timeout=30)
            except Exception as exc:
                errors.append(self.redact(str(exc)))
        return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--previous-image", required=True, help="Already-built local image of the previous source revision.")
    parser.add_argument("--candidate-image", required=True, help="Already-built local image of the candidate source revision.")
    parser.add_argument("--previous-ref", required=True, help="Full Git SHA matching the previous image's OCI revision label.")
    parser.add_argument("--candidate-ref", required=True, help="Full Git SHA matching the candidate image's OCI revision label.")
    parser.add_argument("--platform", choices=["linux/amd64", "linux/arm64"], help="Require this native image/runtime platform.")
    parser.add_argument("--startup-timeout", type=int, default=90)
    parser.add_argument("--report", type=Path, help="Write a credential-free report to a new filename.")
    args = parser.parse_args()
    if not all(re.fullmatch(r"[0-9a-f]{40}", value) for value in (args.previous_ref, args.candidate_ref)):
        parser.error("both source refs must be full lowercase 40-character Git SHAs")
    if args.previous_ref == args.candidate_ref:
        parser.error("previous and candidate source refs must differ")
    if not 15 <= args.startup_timeout <= 600:
        parser.error("startup timeout must be between 15 and 600 seconds")
    if args.report and args.report.exists():
        parser.error("report destination already exists; choose a new file")
    if shutil.which("docker") is None:
        print("Upgrade verification requires Docker Engine or Docker Desktop and the Compose plugin.", file=sys.stderr)
        return 2
    def interrupted(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    with tempfile.TemporaryDirectory(prefix="little-archive-upgrade-check-") as temporary:
        harness = UpgradeHarness(args, temporary)
        result = 1
        try:
            harness.run()
            harness.report["status"] = "passed"
            result = 0
        except (Exception, KeyboardInterrupt) as exc:
            reason = "Verification interrupted." if isinstance(exc, KeyboardInterrupt) else str(exc)
            harness.report.update({"status": "failed", "error": harness.redact(reason)})
            print("FAIL " + harness.redact(reason), file=sys.stderr)
            try:
                harness.failure_logs()
            except (OSError, ValueError, VerificationError):
                pass
        finally:
            errors = harness.cleanup()
            harness.report["cleanup"] = {"status": "failed" if errors else "passed", "errors": errors}
            if errors:
                harness.report["status"] = "failed"
                result = 1
                print("Cleanup needs attention: " + "; ".join(errors), file=sys.stderr)
            harness.report["finished_at"] = timestamp()
            if args.report:
                args.report.parent.mkdir(parents=True, exist_ok=True)
                with args.report.open("x", encoding="utf-8") as stream:
                    json.dump(harness.report, stream, indent=2)
                    stream.write("\n")
        if result == 0:
            print("Compose upgrade, retained-data removal, and separate rollback verification passed.")
        return result


if __name__ == "__main__":
    raise SystemExit(main())
