/**
 * The read-only runbook shipped with Argos (resources/runbooks/diagnosis), loaded from the
 * real folder and run through the real gate. Two directions: the commands a despiste
 * actually needs come back `allow`, and everything the plan puts out of bounds comes
 * back `deny`. A runbook whose own steps are denied is as broken as one that lets a
 * restart through.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import * as path from 'path'
import { sha256Hex } from './ops-audit-pure'
import { assembleRunbook, type LoadedRunbook } from './ops-runbook-pure'
import { classify } from './ops-gate-pure'
import { resolveHostGroups } from './ops-policy-pure'
import type { OpsHostRef, OpsToolInput } from './ops-types'
import { makeT } from '../shared/i18n'

const DIR = path.resolve(__dirname, '../../resources/runbooks/diagnosis')
const SCRIPTS = path.join(DIR, 'scripts')
const HOST: OpsHostRef = { id: 'h1', name: 'cm-tvedras-app', host: '10.0.0.5' }

/** Same as ops-runbook.ts hashScripts: every regular file directly in scripts/. */
function hashScripts(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of readdirSync(SCRIPTS, { withFileTypes: true })) {
    if (e.isFile()) out[e.name] = sha256Hex(readFileSync(path.join(SCRIPTS, e.name)))
  }
  return out
}

function load(): LoadedRunbook {
  const r = assembleRunbook(
    {
      dir: DIR,
      runbookMd: readFileSync(path.join(DIR, 'RUNBOOK.md')),
      policyJson: readFileSync(path.join(DIR, 'policy.json')),
      scriptHashes: hashScripts(),
      hosts: [HOST]
    },
    makeT('en')
  )
  if (!r.ok) throw new Error(`${r.error}\n${(r.errors ?? []).join('\n')}`)
  return r.runbook
}

const runbook = load()
const groups = resolveHostGroups(runbook.policy, HOST)

/** OpsToolInput without hostId, kept as a union (a plain Omit would collapse it). */
type ToolCall = OpsToolInput extends infer T ? (T extends OpsToolInput ? Omit<T, 'hostId'> : never) : never

function decide(input: ToolCall): string {
  return classify({ ...input, hostId: HOST.id } as OpsToolInput, runbook.policy, HOST, groups).decision
}
const run = (cmd: string): string => decide({ tool: 'run', cmd })
const script = (name: string, ...args: string[]): string => decide({ tool: 'script', name, args })

describe('despiste runbook: loading', () => {
  it('loads with no warnings, strict, every rule and script a read', () => {
    expect(runbook.warnings).toEqual([])
    expect(runbook.policy.strict).toBe(true)
    expect(runbook.policy.allow.length).toBeGreaterThan(30)
    expect(runbook.policy.allow.every((r) => r.class === 'read' && r.approval === undefined && !!r.title)).toBe(true)
    expect(runbook.policy.scripts.every((s) => s.class === 'read' && s.approval === undefined && !!s.title)).toBe(true)
    expect(runbook.policy.write).toBeUndefined()
    expect(groups).toEqual(['todos'])
  })

  it('pins every script in scripts/ and nothing else', () => {
    const hashes = hashScripts()
    const pinned = Object.fromEntries(runbook.policy.scripts.map((s) => [s.name, s.sha256]))
    expect(pinned).toEqual(hashes)
    expect(Object.keys(hashes).sort()).toEqual([
      'app-status.sh', 'env-get.sh', 'log-rate.sh', 'log-window.sh', 'pg-health.sh',
      'pg-query.sh', 'proc-inspect.sh', 'snapshot.sh', 'tls-check.sh'
    ])
  })

  it('keeps every file LF-only, so the pinned hashes hold on every checkout', () => {
    for (const name of readdirSync(SCRIPTS)) {
      expect(readFileSync(path.join(SCRIPTS, name)).includes(0x0d), name).toBe(false)
    }
    expect(readFileSync(path.join(DIR, 'policy.json')).includes(0x0d)).toBe(false)
    expect(readFileSync(path.join(DIR, 'RUNBOOK.md')).includes(0x0d)).toBe(false)
  })

  it('opens RUNBOOK.md with one plain paragraph and no em or en dashes', () => {
    expect(runbook.guidelines.startsWith('# ')).toBe(true)
    expect(runbook.guidelines).not.toMatch(/[–—]/)
    expect(runbook.guidelines).toContain('Para correres na tua sessão SSH')
  })
})

describe('despiste runbook: allowed', () => {
  const allowed = [
    // Sistema e recursos
    'uptime',
    'nproc',
    'uname -r',
    'lscpu',
    'df -hT',
    'df -i',
    'free -h',
    'free -m',
    'vmstat 1 5',
    'iostat -x 1 3',
    'sar -r',
    'sar -u -f /var/log/sa/sa19 -s 15:00:00 -e 15:30:00',
    'sar -q -s 15:00:00 -e 15:30:00 -f /var/log/sa/sa28',
    'last -x -n 30 reboot shutdown',
    'w',
    'who',
    // Processos
    'ps -eo pid,ppid,pgid,sid,user,%cpu,%mem,etime,stat,cmd --sort=-%cpu',
    'ps -eo pid,ppid,pgid,sid,user,%cpu,%mem,etime,stat,cmd --sort=-%mem',
    'ps -o pid,ppid,pgid,sid,user,%cpu,%mem,etime,stat,cmd -p 4242',
    'ps -p 4242 -o pid,ppid,etime,cmd',
    'pgrep -af puma',
    'pstree -ap 4242',
    'lsof -nP -p 4242',
    'readlink /proc/123/fd/0',
    'ls -la /proc/123/fd',
    // Serviços, journal e monit
    'systemctl --failed --no-pager',
    'systemctl list-units --type=service --no-pager',
    'systemctl status pumactl_smile-saas --no-pager',
    'systemctl is-active nginx',
    'systemctl cat monit --no-pager',
    'systemctl show pumactl_smile-saas -p MainPID,ActiveState,SubState',
    'systemctl show nginx -p MainPID',
    'systemctl show nginx --no-pager -p ActiveState -p SubState,Result',
    'systemctl show nginx --property=Restart,RestartUSec,User',
    'journalctl -b -p 3 --no-pager -n 200',
    'journalctl -b -1 -p 0..4 --no-pager -n 500',
    'journalctl -b -t monit -o json --no-pager',
    "journalctl -u pumactl_smile-saas --since '2026-10-19 17:00' --until '2026-10-19 17:30' -o short-iso --no-pager -n 2000",
    'journalctl --list-boots --no-pager',
    'sudo -n journalctl -b -p 3 --no-pager -n 200',
    'sudo -n monit summary',
    'sudo -n monit status puma',
    'crontab -l',
    // Rede e HTTP
    'ss -tlnp',
    'ss -s',
    'ip -br addr',
    'ip route',
    "curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1/",
    "curl -sk -o /dev/null -w '%{http_code} %{time_total}\\n' http://localhost:3000/health",
    "curl -sk -o /dev/null -w '%{http_code}' --resolve recrutamento.cm-tvedras.pt:443:127.0.0.1 https://recrutamento.cm-tvedras.pt/",
    'getent hosts recrutamento.cm-tvedras.pt',
    'sudo -n nginx -T',
    // Logs e ficheiros
    'tail -n 40 /home/wiremaze/www/smile-saas/log/puma.log',
    'tail -n 2000 /var/log/nginx/error.log',
    'head -n 100 /var/log/nginx/access.log',
    'grep -n -m 200 Timeout /home/wiremaze/www/smile-saas/log/production.log',
    "grep -c -E ' (502|504) ' /var/log/nginx/access.log",
    "zgrep -i -m 100 'oom' /var/log/nginx/error.log-20261019.gz",
    'wc -l /var/log/nginx/access.log',
    'stat /home/wiremaze/www/smile-saas/tmp/pids/puma.pid',
    'ls -la /home/wiremaze/www/smile-saas/tmp/pids',
    'ls -la /home/wiremaze/www/smile-saas/tmp/sockets',
    "find /var/log -maxdepth 2 -name '*.gz' -mmin -120",
    'find /home/wiremaze/www/smile-saas/log -maxdepth 1 -type f -newermt 2026-10-19',
    'du -xh -d 1 /home',
    'du -xh -d 1 /var/log',
    'diff -u /etc/nginx/conf.d/smile.conf /etc/nginx/conf.d/smile.conf.bak',
    'sudo -n tail -n 200 /var/log/messages',
    'sudo -n grep -m 100 -i puma /var/log/messages-20261019',
    // Aplicação
    '/usr/local/sbin/jarvis version',
    'redis-cli ping',
    'redis-cli info memory',
    'redis-cli llen queue:default',
    // Lacunas dos runbooks do wm-devsecops (docs/BASE_INTERVENTION_PLAN.md §2.1)
    'sudo -n tail -n 200 /var/log/nginx/error.log',
    'sudo -n zgrep -h -F -m 500 /admin/manager/citizen_issues/12/ /var/log/nginx/access.log.1.gz',
    'sudo -n ls -l /var/log/nginx',
    'tail -n 200 /var/www/smile/shared/log/production.log',
    'grep -n -m 50 OpenSSL /var/www/smile/shared/log/production.log',
    'ls /var/www',
    'ls -laZ /home/wiremaze/www/smile-saas/tmp/pids',
    'ruby -v',
    'node -v',
    'openssl version',
    "ruby -ropenssl -e 'puts OpenSSL::OPENSSL_LIBRARY_VERSION'",
    'gem list openssl',
    'pm2 list',
    'openssl x509 -in /etc/nginx/ssl/site.crt -noout -enddate -subject -issuer',
    'sudo -n openssl x509 -in /var/lib/pgsql/15/data/server.crt -noout -enddate -subject',
    'last -F -s 2026-11-01 -t 2026-11-02',
    'getenforce',
    'sestatus',
    'sudo -n semanage fcontext -l -C',
    'rpm -q podman buildah runc containerd.io docker-ce docker-ce-cli docker-compose-plugin container-selinux policycoreutils-python-utils',
    'xfs_info /data',
    'lsblk -f',
    'findmnt /data',
    'id wiremaze',
    'ls -laZd /data',
    'ls -d /var/lib/docker',
    'sudo -n firewall-cmd --get-active-zones',
    'sudo -n firewall-cmd --zone=public --list-all',
    'sudo -n docker ps -a',
    'sudo -n docker logs --tail 200 workspot-web',
    'docker compose ls',
    '/usr/local/sbin/jarvis version --value',
    '/usr/local/sbin/jarvis run script diagnostics/installation_state',
    '/usr/local/sbin/jarvis run script diagnostics/services',
    '/usr/local/sbin/jarvis run script backup/list',
    '/usr/local/sbin/jarvis run script diagnostics/published_versions --lane=current',
    '/usr/local/sbin/jarvis run script diagnostics/update_steps --user=joao.leite',
    '/usr/local/sbin/jarvis run script diagnostics/update_summary --user=joao.leite --version=10.14.0 --lane=current --from_version=10.13.1 --from_lane=current',
    '/usr/local/sbin/jarvis run script diagnostics/update_checkup --version=10.14.0 --lane=next',
    '/usr/local/sbin/jarvis run script ruby/check --lane=next'
  ]
  it.each(allowed)('allows %s', (cmd) => {
    expect(run(cmd)).toBe('allow')
  })

  it.each([
    '/proc/123/wchan',
    '/proc/123/status',
    '/proc/123/limits',
    '/proc/loadavg',
    '/etc/os-release',
    '/etc/monitrc',
    '/etc/monit.d/puma',
    '/etc/nginx/conf.d/smile.conf',
    '/home/wiremaze/www/smile-saas/.wire-studio-version',
    '/home/wiremaze/www/smile-saas/config/puma.rb',
    '/home/wiremaze/www/smile-saas/log/puma.log',
    '/var/lib/pgsql/15/data/log/postgresql-Mon.log',
    '/var/www/smile/shared/log/production.log',
    '/var/www/smile/current/config/puma.rb',
    '/etc/docker/daemon.json'
  ])('allows reading %s', (p) => {
    expect(decide({ tool: 'read', path: p })).toBe('allow')
  })

  it.each(['/proc/123/fd', '/home/wiremaze/www/smile-saas/tmp/sockets', '/var/log/nginx'])('allows listing %s', (p) => {
    expect(decide({ tool: 'list', path: p })).toBe('allow')
  })

  it.each<[string, string[]]>([
    ['snapshot.sh', []],
    ['proc-inspect.sh', ['4242']],
    ['proc-inspect.sh', ['puma']],
    ['app-status.sh', []],
    ['app-status.sh', ['/home/wiremaze/www/smile-saas']],
    ['log-window.sh', ['/home/wiremaze/www/smile-saas/log/puma.log', '2026-10-19 17:00', '2026-10-19 17:30']],
    ['log-window.sh', ['/var/log/messages', '2026-10-19 17:00', '2026-10-19 17:30', 'monit|puma']],
    ['log-rate.sh', ['/var/log/nginx/access.log', '2026-10-19 17:00', '2026-10-19 18:00']],
    ['pg-health.sh', []],
    ['pg-health.sh', ['smile_production']],
    ['pg-query.sh', ['smile_production', 'SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY 2 DESC LIMIT 20']],
    ['pg-query.sh', ['smile_production', 'EXPLAIN SELECT * FROM candidaturas WHERE estado = 1']],
    ['pg-query.sh', ['smile_production', 'show work_mem']],
    ['env-get.sh', ['wiremaze', 'WMCP_APP_NAME']],
    ['tls-check.sh', ['recrutamento.cm-tvedras.pt']],
    ['tls-check.sh', ['127.0.0.1:443', 'recrutamento.cm-tvedras.pt']]
  ])('allows script %s %j', (name, args) => {
    expect(script(name, ...args)).toBe('allow')
  })

  // The gate's sudo parser refuses `-l` and a sudo with no command, so `sudo -n -l` cannot
  // be a rule; snapshot.sh prints it under "Permissões sudo" instead.
  it.todo('allows sudo -n -l once the gate accepts it')
})

describe('despiste runbook: refused', () => {
  const refused = [
    // Fica de fora (#fora)
    'bundle exec rails runner \'puts 1\'',
    'bundle exec rails console',
    'bundle exec rake db:migrate',
    '/usr/local/sbin/jarvis run update',
    '/usr/local/sbin/jarvis',
    // Jarvis: só os comandos do catálogo que não alteram nada
    '/usr/local/sbin/jarvis run script app/restart',
    '/usr/local/sbin/jarvis run script app/test_rails',
    '/usr/local/sbin/jarvis run script backup/create',
    'sudo /usr/local/sbin/jarvis run script system/fix_permissions --mode=all',
    '/usr/local/sbin/jarvis run script update_app/production --user=joao',
    '/usr/local/sbin/jarvis run script diagnostics/update_steps --user=joao --timing=true',
    '/usr/local/sbin/jarvis run script diagnostics/../app/restart',
    // Docker, firewall, SELinux e pacotes: só leitura
    'sudo -n docker inspect workspot-web',
    'sudo -n docker exec workspot-web env',
    'sudo -n docker restart workspot-web',
    'sudo -n docker logs workspot-web',
    'sudo -n docker run --rm hello-world',
    'docker inspect workspot-web',
    'sudo -n firewall-cmd --zone=public --remove-service=dhcpv6-client',
    'sudo -n firewall-cmd --reload',
    'sudo -n semanage fcontext -a -e /var/lib/docker /data/docker',
    'sudo restorecon -R -v /data',
    'rpm -e podman',
    'rpm -qa',
    'pm2 restart all',
    'pm2 jlist',
    'gem install openssl',
    "ruby -e 'puts 1'",
    'openssl x509 -in /etc/nginx/ssl/site.key -noout -enddate',
    'openssl x509 -in /etc/nginx/ssl/site.pem -noout -enddate',
    'openssl x509 -in /etc/nginx/ssl/site.crt -text',
    'ls -la /data',
    'ls -ld /root/.ssh',
    'sudo -n tail -n 200 /var/log/secure',
    'tail -n 50 /var/www/smile/shared/config/database.yml',
    'curl -sI https://download.docker.com/linux/rhel/docker-ce.repo',
    'systemctl restart nginx',
    // systemctl show: every property from the closed list, never the environment
    'systemctl show nginx',
    'systemctl show nginx -p Environment',
    'systemctl show nginx -p MainPID,Environment',
    'systemctl show nginx -p EnvironmentFiles',
    'systemctl show nginx --property=MainPID,EnvironmentFiles',
    'systemctl show nginx -p MainPID -p Environment',
    'systemctl show nginx -p MainPIDEnvironment',
    'systemctl show nginx,MainPID',
    'systemctl stop pumactl_smile-saas',
    'systemctl start pumactl_smile-saas',
    'systemctl reload nginx',
    'sudo -n systemctl restart nginx',
    'sudo -n monit start puma',
    'sudo -n monit stop puma',
    'sudo -n monit monitor puma',
    'sudo -n monit unmonitor puma',
    'sudo -n monit reload',
    'sudo -n nginx -s reload',
    'nginx -s reload',
    'kill 123',
    'kill -9 123',
    'pkill puma',
    'curl -X POST https://127.0.0.1/',
    'curl -sk -d a=1 https://127.0.0.1/',
    'curl -sk --data-binary x https://127.0.0.1/',
    'curl -sk -F f=x https://127.0.0.1/',
    'curl -sk -T x https://127.0.0.1/',
    'curl -sk -o /home/wiremaze/x https://127.0.0.1/',
    'curl -sk -K /home/wiremaze/c https://127.0.0.1/',
    "curl -sk -w '@/etc/passwd x' https://127.0.0.1/",
    "curl -sk -w '%output{x}' https://127.0.0.1/",
    'curl https://example.com/',
    'curl -sk https://127.0.0.1.evil.com/',
    'curl -sk http://127.0.0.1@evil.com/',
    'curl -sk -L https://127.0.0.1/',
    'curl -sk --resolve evil.com:443:127.0.0.1 https://example.com/',
    'curl -sk --resolve example.com:443:10.0.0.9 https://example.com/',
    'curl -sk --resolve example.com:80:127.0.0.1 http://example.com/',
    'strace -p 123',
    'gdb -p 123',
    'tcpdump -i any',
    'find /var/log -name x',
    'find /var/log -maxdepth 2 -exec cat {} +',
    "find /var/log -maxdepth 2 -exec cat '{}' ';'",
    'find /var/log -maxdepth 2 -delete',
    'find /var/log -maxdepth 2 -fprint /home/wiremaze/x',
    'find /var/log -maxdepth 2 -fls /home/wiremaze/x',
    'find /var/log -maxdepth 2 -execdir ls',
    'find /var/log -maxdepth 2 -ok ls',
    'find / -maxdepth 2 -name x',
    'du -xh -d 1 /',
    'du -sh /',
    'grep -r x /var/log',
    'grep -R -m 5 x /var/log',
    'grep -m 5 -f /home/wiremaze/p /var/log/messages',
    'grep -m 5 --include=x x /var/log/nginx/error.log',
    'grep -m 5 -d recurse x /var/log',
    'grep -m 5 x /etc/passwd',
    'top',
    'top -b -n 1',
    'htop',
    'less /var/log/messages',
    'vi /etc/nginx/nginx.conf',
    'watch uptime',
    'cat /etc/shadow',
    'sudo -n cat /etc/shadow',
    'tail -n 5 /home/w/wmcp.env',
    'tail -n 5 /home/w/www/app/.env',
    'tail -n 5 /home/w/www/app/config/database.yml',
    'grep -m 5 password /home/w/www/app/config/database.yml',
    'tail -n 5 /home/w/www/app/config/master.key',
    'tail -n 5 /home/w/www/app/config/secrets.yml',
    'tail -n 5 /home/app/www/app/config/application.yml',
    'head -n 5 /var/www/smile/shared/config/application.yml',
    'grep -m 5 password /home/app/www/app/config/application.production.yml',
    'tail -n 5 /home/app/www/app/config/secrets/production.yml',
    'tail -n 5 /proc/1/environ',
    'journalctl -f',
    'journalctl --no-pager',
    'journalctl --vacuum-size=1M',
    'journalctl -b --file /home/w/x',
    'journalctl -b --rotate',
    'tail -f /var/log/messages',
    'tail -n 100 /var/log/../../etc/shadow',
    'ss -K dst 10.0.0.1',
    'sar -o /home/w/sa 1 3',
    'ps eww',
    'ps -eo pid,cmd e',
    'redis-cli flushall',
    'redis-cli -a secret ping',
    'redis-cli config set maxmemory 1',
    'crontab -r',
    'crontab -e',
    'tail -n 100 /var/log/nginx/error.log | grep x',
    'uptime; reboot',
    'sudo -n tail -n 5 /etc/sudoers',
    'sudo -n -l',
    'sudo -i'
  ]
  it.each(refused)('refuses %s', (cmd) => {
    expect(run(cmd)).toBe('deny')
  })

  it.each([
    '/home/w/www/app/config/database.yml',
    '/home/w/www/app/config/credentials.yml.enc',
    '/home/w/www/app/config/master.key',
    '/home/w/www/app/.env',
    '/home/w/wmcp.env',
    '/proc/1/environ',
    '/proc/1/mem',
    '/proc/1/cwd',
    '/etc/shadow',
    '/etc/sudoers',
    '/etc/nginx/ssl/site.key',
    '/home/w/.ssh/id_rsa',
    '/home/w/.bash_wmcp',
    '/root/.bash_history',
    '/etc/passwd',
    '/var/www/smile/shared/config/database.yml',
    '/var/www/smile/shared/config/master.key',
    '/home/w/www/app/.docker/config.json',
    '/etc/docker/certs.d/registry/client.key',
    '/home/app/www/app/config/application.yml',
    '/var/www/smile/shared/config/application.yml',
    '/home/app/www/app/config/secrets/production.yml'
  ])('refuses reading %s', (p) => {
    expect(decide({ tool: 'read', path: p })).toBe('deny')
  })

  it('refuses listing a secrets folder', () => {
    expect(decide({ tool: 'list', path: '/home/app/www/app/config/secrets' })).toBe('deny')
  })

  it('refuses any write', () => {
    expect(decide({ tool: 'write', path: '/var/log/x', content: 'x' })).toBe('deny')
  })

  it.each<[string, string[]]>([
    ['snapshot.sh', ['x']],
    ['proc-inspect.sh', ['-9']],
    ['proc-inspect.sh', ['1', '2']],
    ['app-status.sh', ['/home/w/www/../../etc']],
    ['app-status.sh', ['/etc/nginx']],
    ['log-window.sh', ['/etc/shadow', '2026-10-19 17:00', '2026-10-19 17:30']],
    ['log-window.sh', ['/home/w/www/app/config/database.yml', '2026-10-19 17:00', '2026-10-19 17:30']],
    ['log-window.sh', ['/home/w/wmcp.env', '2026-10-19 17:00', '2026-10-19 17:30']],
    ['log-window.sh', ['/var/log/../../etc/shadow', '2026-10-19 17:00', '2026-10-19 17:30']],
    ['log-rate.sh', ['/var/log/nginx/access.log', 'x', 'y', 'z']],
    ['pg-health.sh', ['db; drop table x']],
    ['pg-query.sh', ['smile', 'DELETE FROM users']],
    ['pg-query.sh', ['smile', 'UPDATE users SET admin = true']],
    ['pg-query.sh', ['smile', 'EXPLAIN ANALYZE SELECT * FROM t']],
    ['pg-query.sh', ['smile', 'explain (analyze, buffers) select 1']],
    ['pg-query.sh', ['smile', 'SELECT 1; DROP TABLE users']],
    ['pg-query.sh', ['smile', 'select pg_terminate_backend(123)']],
    ['pg-query.sh', ['smile', 'select 1 \\g /tmp/x']],
    ['env-get.sh', ['wiremaze', 'PATH']],
    ['env-get.sh', ['/home/wiremaze/wmcp.env', 'WMCP_X']],
    ['tls-check.sh', ['-connect', 'x']],
    ['rm.sh', []]
  ])('refuses script %s %j', (name, args) => {
    expect(script(name, ...args)).toBe('deny')
  })
})
