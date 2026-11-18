"""Isolated hc 0.1.18 keep-recovery probe; no user daemon, app, or model APIs."""
import json, os, pathlib, shlex, shutil, signal, socket, socketserver, subprocess, sys, tempfile, threading, time

# Fail before creating a daemon unless this Linux-only isolated probe has every
# required executable. HC_BIN explicitly selects hc; otherwise use PATH.
if not sys.platform.startswith('linux'):
    sys.exit('SKIP: core keep-recovery probe requires Linux and a private Unix socket.')
HC = os.environ.get('HC_BIN') or shutil.which('hc')
NODE = shutil.which('node')
SLEEP = shutil.which('sleep')
SHELL = shutil.which('sh')
missing = [name for name, value in [('hc (set HC_BIN or add hc to PATH)', HC), ('node', NODE), ('sleep', SLEEP), ('sh', SHELL)] if not value]
if HC and (not pathlib.Path(HC).is_file() or not os.access(HC, os.X_OK)):
    missing.append(f'executable hc at {HC}')
if missing:
    sys.exit('SKIP: core keep-recovery probe missing required executable(s): ' + ', '.join(missing))

ROOT = pathlib.Path(tempfile.mkdtemp(prefix='boundary-keep-'))
REPO = pathlib.Path(__file__).resolve().parent.parent
for part in ['home', 'config/herdr-core', 'state', 'runtime', 'bin']:
    (ROOT / part).mkdir(parents=True, exist_ok=True)
(ROOT / 'config/herdr-core/config.toml').write_text('notes = false\n')
# A fake Pi only: no model invocation. Its PID belongs to this probe.
(ROOT / 'bin/pi').write_text(f'#!{SHELL}\necho $$ > "$PROBE_PID"\nexec {shlex.quote(str(pathlib.Path(SLEEP).absolute()))} 600\n')
(ROOT / 'bin/pi').chmod(0o755)
ENV = {'HOME': str(ROOT/'home'), 'XDG_CONFIG_HOME': str(ROOT/'config'),
       'XDG_STATE_HOME': str(ROOT/'state'), 'XDG_RUNTIME_DIR': str(ROOT/'runtime'),
       'HC_SESSION': 'boundary-keep', 'HC_SOCKET': str(ROOT/'core.sock'),
       'PATH': os.pathsep.join([str(ROOT/'bin'), str(pathlib.Path(HC).resolve().parent), str(pathlib.Path(NODE).resolve().parent), str(pathlib.Path(SLEEP).resolve().parent), str(pathlib.Path(SHELL).resolve().parent)]),
       'SHELL': str(pathlib.Path(SHELL).resolve()), 'LANG': 'C.UTF-8', 'PI_SUBAGENT_APP_LAYOUT': 'hidden'}
LOG = open(ROOT/'daemon.log', 'w')
DAEMON = subprocess.Popen([HC, 'serve'], env=ENV, cwd=ROOT, stdout=LOG, stderr=LOG)

def rpc(method, params):
    with socket.socket(socket.AF_UNIX) as sock:
        sock.settimeout(15)
        sock.connect(str(ROOT/'core.sock'))
        sock.sendall((json.dumps({'jsonrpc':'2.0', 'id':1, 'method':method, 'params':params})+'\n').encode())
        data = b''
        while b'\n' not in data:
            chunk = sock.recv(65536)
            if not chunk: raise RuntimeError('RPC closed')
            data += chunk
        reply = json.loads(data.split(b'\n')[0])
        if 'error' in reply: raise RuntimeError(reply['error'])
        return reply['result']

def until(probe):
    for _ in range(150):
        result = probe()
        if result: return result
        time.sleep(.05)
    raise RuntimeError('Timed out waiting for isolated recovery')

# Record extension RPCs through a forwarding socket owned by this probe. Python's
# setup/cleanup RPCs use core.sock directly, so mutations cannot hide in the log.
CALLS = []
class Proxy(socketserver.StreamRequestHandler):
    def handle(self):
        request = self.rfile.readline()
        if not request: return
        CALLS.append(json.loads(request))
        with socket.socket(socket.AF_UNIX) as upstream:
            upstream.connect(str(ROOT/'core.sock'))
            upstream.sendall(request)
            reply = b''
            while b'\n' not in reply:
                chunk = upstream.recv(65536)
                if not chunk: raise RuntimeError('proxy upstream closed')
                reply += chunk
            self.wfile.write(reply)
PROXY = socketserver.ThreadingUnixStreamServer(str(ROOT/'probe.sock'), Proxy)
THREAD = threading.Thread(target=PROXY.serve_forever, daemon=True)
THREAD.start()

def extension_probe(phase, child, session):
    env = {**ENV, 'HC_TERMINAL_SOCKET':str(ROOT/'probe.sock'), 'HC_TERMINAL_ID':child['address'],
           'PROBE_TERMINAL':child['address'], 'PROBE_SESSION':session}
    before = len(CALLS)
    subprocess.run([NODE, 'test/core-keep-probe.ts', phase], cwd=REPO, env=env, check=True, timeout=30)
    methods = [call['method'] for call in CALLS[before:]]
    assert 'terminal.keep' not in methods, methods
    if phase in ['done', 'cancel']:
        assert methods.count('terminal.kill') == 1 and methods.count('terminal.rm') == 1, methods
    else:
        assert not {'terminal.kill', 'terminal.rm'}.intersection(methods), methods
    print('EXTENSION_RPC', phase, json.dumps(methods), flush=True)

try:
    until(lambda: (ROOT/'core.sock').exists() or (DAEMON.poll() is not None and (_ for _ in ()).throw(RuntimeError('isolated hc daemon exited; see its private daemon.log'))))
    print('ISOLATED_ROOT', ROOT, flush=True)
    print('SERVER', json.dumps(rpc('server.status', {})), flush=True)
    for preexisting_marker in [False, True]:
        session = str(ROOT/('marked.jsonl' if preexisting_marker else 'unmarked.jsonl'))
        pidfile = ROOT/('marked.pid' if preexisting_marker else 'unmarked.pid')
        child = rpc('terminal.run', {'argv':['pi'], 'cwd':str(ROOT), 'env':{'PROBE_PID':str(pidfile)},
            'keep':True, 'wait':False, 'no_notify':True,
            'labels':{'pi.subagent.managed':'1', 'pi.subagent.session':session}})
        print('ORIGINAL', json.dumps(child), flush=True)
        assert child['argv'][0] == 'pi', child
        until(lambda: pidfile.exists())
        extension_probe('original', child, session)
        if preexisting_marker:
            pathlib.Path(session+'.exit').write_text(json.dumps({'type':'done', 'summary':'ORIGINAL_RESULT'}))
        pid = int(pidfile.read_text())
        assert pid == rpc('terminal.get', {'terminal':child['address']})['pid'], 'only signal our known terminal program'
        os.kill(pid, signal.SIGKILL)
        transitions = []
        def recovery():
            record = rpc('terminal.get', {'terminal':child['address']})
            snapshot = [record['state'], record['argv'], record['reason']]
            if not transitions or transitions[-1] != snapshot:
                transitions.append(snapshot)
            return record if record['state']=='live' and record['argv'][0]!='pi' else None
        recovered = until(recovery)
        print('TRANSITIONS', json.dumps(transitions), flush=True)
        print('RECOVERED', json.dumps(recovered), flush=True)
        # Runtime startup clears reason; assert argv still proves replacement later.
        time.sleep(1.6)
        stable = rpc('terminal.get', {'terminal':child['address']})
        assert stable['reason'] is None and stable['argv'][0] != 'pi' and pathlib.Path(stable['argv'][0]).is_absolute(), stable
        assert stable['labels'] == child['labels'], stable
        extension_probe('recovered', child, session)
        final = rpc('terminal.get', {'terminal':child['address']})
        assert final['pid'] == stable['pid'] and final['keep'] is True and final['state'] == 'live', final
        print('PASS replacement shell remains live with the same PID and keep=true; marker before signal:', preexisting_marker, flush=True)
    for phase in ['done', 'cancel']:
        session = str(ROOT/(phase+'.jsonl'))
        child = rpc('terminal.run', {'argv':['pi'], 'cwd':str(ROOT), 'env':{'PROBE_PID':str(ROOT/(phase+'.pid'))},
            'keep':True, 'wait':False, 'no_notify':True,
            'labels':{'pi.subagent.managed':'1', 'pi.subagent.session':session}})
        until(lambda: (ROOT/(phase+'.pid')).exists())
        extension_probe(phase, child, session)
finally:
    # This socket and every terminal on it were created by this probe only.
    try:
        for terminal in rpc('terminal.list', {'all':True})['terminals']:
            try:
                rpc('terminal.kill', {'terminal':terminal['address']})
                rpc('terminal.rm', {'terminal':terminal['address']})
            except Exception as error: print('CLEANUP_TERMINAL', error, flush=True)
        rpc('server.stop', {})
    except Exception as error: print('CLEANUP_SERVER', error, flush=True)
    try: DAEMON.wait(timeout=10)
    except subprocess.TimeoutExpired:
        DAEMON.terminate(); DAEMON.wait(timeout=5)
    PROXY.shutdown(); PROXY.server_close(); THREAD.join()
    (ROOT/'extension-rpc.json').write_text(json.dumps(CALLS, indent=2))
    LOG.close()
    print('DAEMON_STOPPED', DAEMON.returncode, 'logs:', ROOT, flush=True)
