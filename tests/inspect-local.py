"""Read-only metadata inspection. Never emit proxy credentials or chat bodies."""
import json
import os
import pathlib
import sqlite3
import urllib.request
import yaml

profile_dir = pathlib.Path(os.environ.get('APPDATA', pathlib.Path.home() / 'AppData/Roaming')) / 'io.github.clash-verge-rev.clash-verge-rev'
cfg = yaml.safe_load((profile_dir / 'clash-verge.yaml').read_text(encoding='utf-8-sig'))
report = {'fileMode': cfg.get('mode'), 'controllerConfigured': bool(cfg.get('external-controller'))}
report['proxyMetadata'] = [{k: p.get(k) for k in ('name', 'type', 'server', 'port', 'tls', 'servername', 'network') if k in p} for p in cfg.get('proxies', [])]
report['relevantRules'] = [r for r in cfg.get('rules', []) if any(s in r.lower() for s in ('google', 'aiplatform', 'gcp', 'match,'))]
base_cfg = yaml.safe_load((profile_dir / 'config.yaml').read_text(encoding='utf-8-sig'))
controller = cfg.get('external-controller') or base_cfg.get('external-controller')
if controller and controller.split(':')[0] in ('127.0.0.1', 'localhost'):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    secret = cfg.get('secret') or base_cfg.get('secret')
    headers = {'Authorization': 'Bearer ' + secret} if secret else {}

    def get(endpoint):
        with opener.open(urllib.request.Request('http://' + controller + endpoint, headers=headers), timeout=3) as response:
            return json.load(response)

    try:
        live = get('/configs')
        report['liveMode'] = live.get('mode')
        proxies = get('/proxies')['proxies']
        report['selectedGroups'] = {name: {'type': p.get('type'), 'now': p.get('now')} for name, p in proxies.items() if p.get('now')}
        report['liveGoogleConnections'] = [{
            'host': c.get('metadata', {}).get('host'),
            'destinationPort': c.get('metadata', {}).get('destinationPort'),
            'chains': c.get('chains'),
            'rule': c.get('rule'),
        } for c in get('/connections').get('connections', []) if any(s in c.get('metadata', {}).get('host', '') for s in ('googleapis', 'aiplatform'))]
    except Exception as exc:
        report['controllerErrorType'] = type(exc).__name__

db_path = pathlib.Path.home() / '.cc-switch' / 'cc-switch.db'
with sqlite3.connect(db_path.as_uri() + '?mode=ro', uri=True) as db:
    tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    report['ccSwitchTables'] = tables
    report['ccSwitchColumns'] = {t: [r[1] for r in db.execute('PRAGMA table_info("' + t.replace('"', '""') + '")')] for t in tables if any(s in t for s in ('request', 'usage', 'proxy'))}

out = pathlib.Path(__file__).parent / 'local-metadata.json'
out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(report, ensure_ascii=False, indent=2))
