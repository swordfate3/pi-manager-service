"""Opt-in acceptance against real official Pi, Docker, Gate, Hub and Chromium.

Run from the repository root with PI_REAL_DOCKER_TEST=1 and an explicitly
selected PI_RUNTIME_TEST_IMAGE=pi-runtime-update-test:<test-tag>. All state,
credentials and session text are synthetic. No production volume is accepted.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import select
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / "integrations/runtime-updater/gate"), str(Path(__file__).parent)]
from gate.service import start_servers
from runtime_test_bootstrap import create_runtime_test_components, RuntimeTestEngine


def command(*args, timeout=30):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=True)
    return result.stdout.strip()


def wait_for(callback, timeout=45):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = callback()
        if value:
            return value
        time.sleep(.1)
    raise AssertionError("Synthetic acceptance condition timed out")


def generation_deferral_observed(idle, generating, original, calls):
    # busy denotes uncertain/tainted input, not model generation. The actual
    # faux provider's recorded call plus nonidle status prove live generation.
    return bool(idle and generating and idle['version'] == '1.4.0' and
                generating['version'] == '1.3.0' and generating['idle'] is False and
                generating['runtime_id'] == original['runtime_id'] and
                calls == [{'generation': True}])


def conversation_history_matches(entries, *, generated):
    # Real Pi persists a system message before generation. It is not another
    # conversation turn. Retain exact user/assistant ordering and reject tools
    # or unknown roles; byte preservation and provider-call checks are separate.
    roles = [entry.get('message', {}).get('role') for entry in entries
             if entry.get('type') == 'message']
    return [role for role in roles if role != 'system'] == ['user', 'assistant'] * (2 if generated else 1)


def main():
    image = os.environ.get("PI_RUNTIME_TEST_IMAGE", "")
    if os.environ.get("PI_REAL_DOCKER_TEST") != "1" or not re.fullmatch(
            r"pi-runtime-update-test:[a-zA-Z0-9_.-]+", image):
        raise ValueError("explicit isolated test image and opt-in are required")
    image_id = command("docker", "image", "inspect", "--format", "{{.Id}}", image)
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
        raise ValueError("invalid immutable test image")
    namespace = uuid.uuid4().hex
    volume = "pi-runtime-update-test-" + namespace
    os.environ["PI_RUNTIME_SOURCE"] = str(ROOT / "integrations/runtime-updater/pi-runtime")
    os.environ["PI_RUNTIME_TEST_VERSION"] = "1.3.0"
    spec = importlib.util.spec_from_file_location("acceptance_tui", ROOT / "e2e/harness/test-managed-runtime.py")
    tui = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(tui)
    output = ROOT / ".tmp/runtime-version-acceptance" / namespace
    output.mkdir(parents=True)
    evidence = {"namespace": namespace, "image": image_id, "volume": volume, "transitions": [],
                "cleanup": False, "production_touched": False}
    busy_case = os.environ.get('PI_RUNTIME_ACCEPTANCE_BUSY') == '1'
    incompatible_case = os.environ.get('PI_RUNTIME_ACCEPTANCE_INCOMPATIBLE') == '1'
    with tempfile.TemporaryDirectory(prefix="pi-version-acceptance-") as temporary:
        directory = Path(temporary)
        engine = RuntimeTestEngine(runtime_volume=volume)
        components = create_runtime_test_components(directory / "gate", engine, runtime_volume=volume)
        gate = components.gate
        gate.lifecycle.engine = engine
        gate.runtime_updates.runtime_engine = components.runtime_engine
        if os.environ.get('PI_RUNTIME_ACCEPTANCE_DIAGNOSTICS') == '1':
            evidence['diagnostic_only'] = True
            original_definition = components.runtime_engine.definition
            trace_code = '''
import sys,json,traceback
from pathlib import Path
path='/usr/local/lib/pi-runtime/runtime_probe.py'
source=Path(path).read_text()
old="    except Exception:\\n        print('{\\\"ok\\\":false,\\\"stage\\\":\\\"compatibility_probe_failed\\\"}', flush=True)"
new="""    except Exception as error:
        reason=str(error) if isinstance(error,ProbeFailure) else type(error).__name__
        if len(reason)<=64 and all(c.isalpha() or c=='_' for c in reason):
            print(json.dumps({'reason':reason,'frames':[(row.name,row.lineno) for row in traceback.extract_tb(error.__traceback__)]}),file=sys.stderr,flush=True)
        print('{"ok":false,"stage":"compatibility_probe_failed"}',flush=True)"""
assert source.count(old)==1
sys.argv=[path,*sys.argv[1:]]
exec(compile(source.replace(old,new),path,'exec'),{'__name__':'__main__','__file__':path,'traceback':traceback})
'''
            preamble = '''
_original_run=subprocess.run
def diagnostic_run(argv,*args,**kwargs):
 if argv[:3]==['/usr/bin/python3','-I','/usr/local/lib/pi-runtime/runtime_probe.py']:
  argv=['/usr/bin/python3','-I','-c',%r,*argv[3:]]
  kwargs['stderr']=subprocess.PIPE
 try:
  return _original_run(argv,*args,**kwargs)
 except subprocess.CalledProcessError as error:
  print((error.stderr or '')[-8192:],file=sys.stderr,flush=True)
  raise
subprocess.run=diagnostic_run
''' % trace_code
            def diagnostic_definition(job, phase):
                definition = original_definition(job, phase)
                if phase.startswith('source-'):
                    script = definition['Cmd'][0]
                    prefix, entry = script.rsplit('\ntry:\n    outcome = run_probe(', 1)
                    definition['Cmd'][0] = prefix + preamble + '\ntry:\n    outcome = run_probe(' + entry
                elif phase == 'validate':
                    prefix, entry = definition['Cmd'][0].rsplit("\nif __name__ == '__main__':", 1)
                    definition['Cmd'][0] = prefix + preamble + "\nif __name__ == '__main__':" + entry
                return definition
            components.runtime_engine.definition = diagnostic_definition
            # Restore helpers are removed by the product's finally block. Capture
            # only their fixed synthetic diagnostics before that exact deletion.
            from gate.runtime_restore import RestoreEngine
            original_restore_definition = RestoreEngine.definition
            def diagnostic_restore_definition(instance, job, phase):
                definition = original_restore_definition(instance, job, phase)
                prefix, entry = definition['Cmd'][0].rsplit('\ntry:\n value=scope["run_probe"]', 1)
                definition['Cmd'][0] = (prefix + '\nimport subprocess\n' + preamble +
                                       '\ntry:\n value=scope["run_probe"]' + entry)
                return definition
            RestoreEngine.definition = diagnostic_restore_definition
            original_call = engine.call
            def diagnostic_call(method, endpoint, *args, **kwargs):
                match = re.fullmatch(r'/containers/([a-f0-9]{64})\?force=1&v=1', endpoint)
                if method == 'DELETE' and match:
                    helper = match[1]
                    allowed = {child.get('restore_helper', {}).get('helpers', {}).get('validate', {}).get('id')
                               for child in gate.lifecycle._jobs()}
                    if helper in allowed:
                        logs = subprocess.run(['docker', 'logs', '--tail', '4', helper],
                            capture_output=True, text=True, timeout=5)
                        (output / ('synthetic-restore-' + helper + '.json')).write_text(json.dumps({
                            'stdout': logs.stdout[-4096:], 'stderr': logs.stderr[-4096:]}))
                return original_call(method, endpoint, *args, **kwargs)
            engine.call = diagnostic_call
        gate.runtime_updates.set_policy({"mode": "auto", "images": [image_id]})
        gate.lifecycle.set_policy({"mode": "auto", "images": [image_id]})
        servers = start_servers(gate, port=0)
        stopped = threading.Event()
        restore_diagnostics = []
        runtime_diagnostics = []
        def trace_restore(frame, event, value):
            if frame.f_code.co_filename.endswith('/gate/runtime_restore.py') and event == 'exception':
                restore_diagnostics.append({'line': frame.f_lineno, 'function': frame.f_code.co_name,
                    'error': value[0].__name__, 'message': str(value[1])[:500]})
            runtime_file = Path(frame.f_code.co_filename).name
            if (runtime_file in ('runtime_updates.py', 'runtime_engine.py') and event == 'exception'
                    and issubclass(value[0], Exception)):
                runtime_diagnostics.append({'file': runtime_file, 'line': frame.f_lineno,
                    'function': frame.f_code.co_name, 'error': value[0].__name__,
                    'message': str(value[1])[:500]})
                del runtime_diagnostics[:-200]
            return trace_restore if runtime_file in ('runtime_restore.py', 'runtime_updates.py', 'runtime_engine.py') else None
        threading.settrace(trace_restore)
        def tick():
            while not stopped.wait(.1):
                gate.tick()
        ticker = threading.Thread(target=tick, daemon=True)
        ticker.start()
        hub_process = None
        consumers = []
        created_volume = False
        releases = []
        config = directory / "hub.json"
        cli = ["node", str(ROOT / "dist/hub/pi-web-hub.mjs")]
        def hub_command(*args):
            return json.loads(command(*cli, *args, "--config", str(config)))
        def sessions():
            with urllib.request.urlopen(hub["localUrl"] + "api/sessions", timeout=3) as response:
                return json.load(response)["sessions"]
        try:
            command("docker", "volume", "create", "--label", "pi.runtime.acceptance=" + namespace, volume)
            created_volume = True
            hub_command("init", "--port", "0")
            for name, token in (("runtime", gate.token), ("lifecycle", gate.lifecycle_token)):
                credential = directory / (name + ".json")
                credential.write_text(json.dumps({"token": token}))
                credential.chmod(0o600)
            settings = json.loads(config.read_text())
            for key, name in (("runtimeUpdates", "runtime"), ("lifecycle", "lifecycle")):
                settings[key] = {"endpoint": f"http://127.0.0.1:{servers[0].server_port}",
                                 "credentialFile": str(directory / (name + ".json"))}
            settings["management"] = {"port": 0}
            config.write_text(json.dumps(settings))
            hub_process = subprocess.Popen([*cli, "serve", "--config", str(config)],
                                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
            if not select.select([hub_process.stdout], [], [], 10)[0]:
                raise AssertionError("Isolated Hub did not start")
            hub = json.loads(hub_process.stdout.readline())
            names = ("a",) if os.environ.get("PI_RUNTIME_ACCEPTANCE_SINGLE") == "1" else ("a", "b")
            for name in names:
                capability = hub_command("issue", "--label", "Synthetic version " + name,
                                         "--output", str(directory / (name + ".json")))
                (directory / name).mkdir()
                consumers.append(tui.RealTui(directory / name, hub, capability, name, image_id,
                                             runtime_volume=volume, image_owned_package=True))
            before = [tui.wait_for(consumer.status) for consumer in consumers]
            initial_history = [consumer.session.read_bytes() for consumer in consumers]
            observations = lambda consumer: [json.loads(line) for line in
                (consumer.directory / 'runtime-observations.jsonl').read_text().splitlines()]
            initial_settings = [observations(consumer)[-1] for consumer in consumers]
            if any(state["version"] != "1.3.0" for state in before):
                raise AssertionError("Initial real process is not official Pi1.3.0")
            identities = [engine.inspect(consumer.container)["Id"] for consumer in consumers]
            evidence["initial_versions"] = [state["version"] for state in before]
            wait_for(lambda: len(sessions()) == len(consumers))
            readiness = gate.runtime_updates.readiness()
            evidence["initial_readiness"] = readiness
            if readiness["status"] != "ready":
                trust = []
                for consumer in consumers:
                    item = engine.inspect(consumer.container)
                    row = {"image": item["Image"], "entrypoint": item["Config"]["Entrypoint"],
                           "user": item["Config"]["User"]}
                    run = item["Config"]["Labels"]["cn.swordfate.pi.run-id"]
                    try:
                        gate.lifecycle._resolve(run, gate.runtime_updates.policy(), expected=item["Id"], role="inventory")
                        row["trust"] = True
                    except (ValueError, RuntimeError) as error:
                        row["trust_error"] = str(error)
                    trust.append(row)
                evidence["synthetic_trust_diagnostics"] = trust
                raise AssertionError("Isolated real source processes are not eligible: " + json.dumps(readiness))
            if os.environ.get("PI_RUNTIME_ACCEPTANCE_PREFLIGHT") == "1":
                evidence["preflight_only"] = True
                return  # Startup evidence, explicitly NOT full version-update acceptance.
            for version in ("1.4.0", "1.3.0"):
                expect_refusal = incompatible_case and version == '1.3.0'
                if expect_refusal:
                    # A synthetic future format which the actual selected SDK
                    # must refuse before the already-running source is stopped.
                    incompatible_history = []
                    for consumer in consumers:
                        lines = consumer.session.read_bytes().splitlines(keepends=True)
                        header = json.loads(lines[0])
                        header['version'] = 2147483647
                        lines[0] = json.dumps(header).encode() + b'\n'
                        consumer.session.write_bytes(b''.join(lines))
                        incompatible_history.append(consumer.session.read_bytes())
                for consumer in consumers:
                    consumer.expected_version = None  # Assert transitions below, not during the transition.
                generation = None
                if busy_case and version == '1.4.0':
                    if len(consumers) != 2:
                        raise ValueError('busy acceptance requires two isolated consumers')
                    generation = capability['runId']
                    def release_when_idle_target_updated():
                        try:
                            end = time.monotonic() + 290
                            while time.monotonic() < end and not stopped.is_set():
                                idle, busy = consumers[0].status(), consumers[1].status()
                                call_file = consumers[1].directory / 'model-calls.jsonl'
                                calls = [json.loads(line) for line in call_file.read_text().splitlines()] if call_file.exists() else []
                                if generation_deferral_observed(idle, busy, before[1], calls):
                                    evidence['busy_deferral_observed'] = True
                                    (consumers[1].directory / 'release-generation').touch()
                                    return
                                stopped.wait(.2)
                            evidence['busy_deferral_failure'] = 'not_observed'
                        except Exception as error:
                            evidence['busy_deferral_failure'] = type(error).__name__
                    release = threading.Thread(target=release_when_idle_target_updated, daemon=True)
                    releases.append(release)
                    release.start()
                browser = subprocess.run(
                    ["node", "--import", "./tests/register-ts.mjs", "e2e/harness/browser-runtime-version-picker.ts"],
                    input=json.dumps({"adminUrl": hub["managementUrl"], "chatUrl": hub["localUrl"],
                                      "version": version, "code": hub_command("pair")["code"],
                                      'runs': [state['run_id'] for state in before],
                                      'paths': [next(row['path'] for row in sessions()
                                          if row['label'] == 'Synthetic version ' + name) for name in names],
                                      **({'busyGeneration': generation} if generation else {}),
                                      'expectRefusal': expect_refusal,
                                      "screenshotDir": str(output)}),
                    cwd=ROOT, capture_output=True, text=True, timeout=360)
                events = []
                for line in browser.stdout.splitlines():
                    try:
                        events.append(json.loads(line))
                    except ValueError:
                        pass
                evidence["transitions"].append({"version": version, "browser_exit": browser.returncode,
                                                "events": events, "jobs": gate.runtime_updates.jobs()})
                if browser.returncode:
                    raise AssertionError("Real browser transition failed: " + browser.stderr[-3000:] +
                                         "\nJobs: " + json.dumps(gate.runtime_updates.jobs()))
                after = [consumer.status() for consumer in consumers]
                if expect_refusal:
                    if not any(event.get('event') == 'refused' for event in events):
                        raise AssertionError('Browser did not observe incompatible-session refusal')
                    for index, (old, current) in enumerate(zip(before, after)):
                        for key in ('version', 'runtime_id', 'session_id', 'leaf_id'):
                            if current[key] != old[key]:
                                raise AssertionError('Incompatible rollback changed original ' + key)
                        if consumers[index].session.read_bytes() != incompatible_history[index]:
                            raise AssertionError('Incompatible rollback modified original session bytes')
                        if engine.inspect(consumers[index].container)['Id'] != identities[index]:
                            raise AssertionError('Incompatible rollback replaced original container')
                    evidence['incompatible_refused_before_stop'] = True
                    break
                for index, (old, current) in enumerate(zip(before, after)):
                    if current["version"] != version or current["runtime_id"] == old["runtime_id"]:
                        raise AssertionError("Installed version did not become the actual running version")
                    for key in ("session_id",):
                        if current[key] != old[key]:
                            raise AssertionError("Synthetic session identity changed: " + key)
                    if (not busy_case or index == 0 or version == '1.3.0') and current['leaf_id'] != old['leaf_id']:
                        raise AssertionError('Synthetic leaf changed without a new generation')
                    if engine.inspect(consumers[index].container)["Id"] != identities[index]:
                        raise AssertionError("Consumer container was recreated")
                    entries = [json.loads(line) for line in consumers[index].session.read_text().splitlines()]
                    generated = busy_case and index == 1
                    if not conversation_history_matches(entries, generated=generated) or not consumers[index].session.read_bytes().startswith(initial_history[index]):
                        original_entries = [json.loads(line) for line in initial_history[index].splitlines()]
                        raise AssertionError(json.dumps({'failure': 'saved_history_preservation',
                            'consumer': index, 'expected_generated_turn': generated,
                            'message_roles': [row.get('message', {}).get('role') for row in entries
                                              if row.get('type') == 'message'],
                            'byte_prefix': consumers[index].session.read_bytes().startswith(initial_history[index]),
                            'parsed_prefix': entries[:len(original_entries)] == original_entries,
                            'entry_types': [row.get('type') for row in entries],
                            'model_calls': (consumers[index].directory / 'model-calls.jsonl').read_text()
                                if (consumers[index].directory / 'model-calls.jsonl').exists() else ''}))
                    # Pi may persist model/thinking nodes after a message. The
                    # branch leaf is a session entry, not necessarily a message.
                    if not any(entry.get('id') == current['leaf_id'] for entry in entries):
                        raise AssertionError('Successor branch leaf is absent from the actual saved history')
                    parent = gate.runtime_updates._get(events[0]['id'])
                    target = next(row for row in parent['targets'] if row['run_id'] == old['run_id'])
                    frozen_child = gate.lifecycle._get(target['restart_id'])
                    if current['leaf_id'] != frozen_child['leaf_id']:
                        raise AssertionError('Successor did not preserve the actual pre-stop frozen leaf')
                    actual_settings = observations(consumers[index])[-1]
                    for key in ('cwd', 'session_id', 'provider', 'model', 'thinking'):
                        if actual_settings[key] != initial_settings[index][key]:
                            raise AssertionError('Actual successor setting changed: ' + key)
                    if actual_settings['leaf_id'] != current['leaf_id']:
                        raise AssertionError('Actual successor did not open the observed branch leaf')
                    if actual_settings['version'] != version:
                        raise AssertionError('Successor instrumentation did not load selected version')
                    calls = consumers[index].directory / 'model-calls.jsonl'
                    rows = [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []
                    if rows != ([{'generation': True}] if busy_case and index == 1 else []):
                        raise AssertionError('Saved model request was replayed')
                evidence["transitions"][-1]["actual_versions"] = [state["version"] for state in after]
                before = after
            evidence["passed_basic_transitions"] = not incompatible_case and not evidence.get('diagnostic_only')
            if busy_case and evidence.get('busy_deferral_observed') is not True:
                raise AssertionError('Busy deferral did not exercise a live generation')
        except BaseException as error:
            evidence["failure"] = type(error).__name__
            evidence['restore_diagnostics'] = restore_diagnostics
            evidence['runtime_diagnostics'] = runtime_diagnostics[-50:]
            (output / 'synthetic-gate-jobs.json').write_text(json.dumps({
                'runtime': gate.runtime_updates._jobs(), 'lifecycle': gate.lifecycle._jobs()}, indent=2))
            helper_outcomes = []
            for job in gate.runtime_updates._jobs():
                for phase, helper in job.get('helpers', {}).items():
                    identity = helper.get('id')
                    if not isinstance(identity, str) or not re.fullmatch('[a-f0-9]{64}', identity):
                        continue
                    item = engine.inspect(identity)
                    if item and item.get('Config', {}).get('Labels', {}).get('cn.swordfate.pi.runtime-update') == job['id']:
                        logs = subprocess.run(['docker', 'logs', '--tail', '4', identity],
                                              capture_output=True, text=True, timeout=5)
                        helper_outcomes.append({'phase': phase, 'state': item.get('State'),
                                                'stdout': logs.stdout[-4096:], 'stderr': logs.stderr[-4096:]})
            (output / 'synthetic-helper-outcomes.json').write_text(json.dumps(helper_outcomes, indent=2))
            for index, consumer in enumerate(consumers):
                terminal = consumer.output[-12000:].decode("utf8", errors="replace")
                terminal = re.sub(r"[a-f0-9]{64}", "[synthetic-token-redacted]", terminal)
                (output / (f"synthetic-startup-{index}.txt")).write_text(terminal)
                diagnostic = r'''
import json, os, pathlib, socket
print('control', pathlib.Path('/run/pi-runtime/control.sock').exists())
print('extension', pathlib.Path('/run/pi-runtime/extension.sock').exists())
for pid in pathlib.Path('/proc').iterdir():
    if not pid.name.isdecimal(): continue
    try:
        env = dict(part.split(b'=',1) for part in (pid/'environ').read_bytes().split(b'\0') if b'=' in part)
        token = env.get(b'PI_RUNTIME_CHILD_TOKEN')
        endpoint = env.get(b'PI_RUNTIME_EXTENSION_SOCKET')
        if not token or not endpoint: continue
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(2)
            client.connect(endpoint.decode())
            client.sendall(json.dumps({'action':'snapshot','token':token.decode()}).encode()+b'\n')
            print('synthetic_snapshot',client.recv(16384).decode())
        break
    except (OSError, ValueError) as error:
        print('diagnostic',type(error).__name__)
'''
                result = subprocess.run(["docker", "exec", "--user", "1000:1000", consumer.container,
                                         "/usr/bin/python3", "-c", diagnostic],
                                        capture_output=True, text=True, timeout=5)
                (output / (f"synthetic-diagnostic-{index}.txt")).write_text(result.stdout + result.stderr)
                control = subprocess.run(["docker", "exec", "--user", "1000:1000", consumer.container,
                                          "/usr/local/bin/pi-session-control", "--request", '{"action":"status"}'],
                                         capture_output=True, text=True, timeout=5)
                (output / (f"synthetic-control-{index}.txt")).write_text(control.stdout + control.stderr)
            raise
        finally:
            stopped.set()
            threading.settrace(None)
            ticker.join(timeout=3)
            for release in releases:
                release.join(timeout=3)
            for consumer in consumers:
                consumer.close()
            for child in gate.lifecycle._jobs():
                helper = child.get('restore_helper', {}).get('helpers', {}).get('validate', {}).get('id')
                if not isinstance(helper, str) or not re.fullmatch(r'[a-f0-9]{64}', helper):
                    continue
                item = engine.inspect(helper)
                if item and item.get('Config', {}).get('Labels', {}).get('cn.swordfate.pi.runtime-update') == child['id']:
                    command('docker', 'rm', '-f', helper)
            # Only helper IDs persisted in THIS isolated Gate's jobs are candidates.
            for job in gate.runtime_updates._jobs():
                for helper in job.get("helpers", {}).values():
                    identity = helper.get("id")
                    if not isinstance(identity, str) or not re.fullmatch(r"[a-f0-9]{64}", identity):
                        continue
                    item = engine.inspect(identity)
                    if item and item.get("Config", {}).get("Labels", {}).get("cn.swordfate.pi.runtime-update") == job["id"]:
                        command("docker", "rm", "-f", identity)
            if hub_process is not None:
                hub_process.terminate()
                hub_process.wait(timeout=10)
                hub_process.stdout.close()
            for server in servers:
                server.shutdown()
                server.server_close()
            gate.close()
            if created_volume:
                command("docker", "volume", "rm", volume)
            evidence["cleanup"] = True
            (output / "evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
            print(json.dumps(evidence, separators=(",", ":")))


if __name__ == "__main__":
    main()
