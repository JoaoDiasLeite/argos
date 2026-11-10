#!/bin/bash
# snapshot.sh: fotografia do servidor numa só chamada, só de leitura.
# Uso: snapshot.sh (sem argumentos)
# Não escreve em lado nenhum, não muda serviços nem processos.

export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MAX_LINES=1500

has() { command -v "$1" >/dev/null 2>&1; }
missing() { echo "$1: não instalado"; }

main() {
  if [ "$#" -gt 0 ]; then
    echo "snapshot.sh não aceita argumentos" >&2
    return 2
  fi

  echo "== Sistema =="
  if [ -r /etc/os-release ]; then
    grep -E '^PRETTY_NAME=' /etc/os-release | head -n 1 | sed -e 's/^PRETTY_NAME=//' -e 's/"//g'
  elif [ -r /etc/redhat-release ]; then
    head -n 1 /etc/redhat-release
  fi
  echo "kernel: $(uname -r)"
  echo "máquina: $(uname -n)"
  echo "agora: $(date '+%Y-%m-%d %H:%M:%S %z')"
  echo "utilizador: $(id 2>/dev/null)"

  echo "== Carga e CPU =="
  uptime
  if has nproc; then echo "CPUs: $(nproc)"; fi
  if has vmstat; then vmstat 1 3; else missing vmstat; fi

  echo "== Memória e swap =="
  if has free; then free -m; else missing free; fi

  echo "== Discos =="
  df -hT -x tmpfs -x devtmpfs 2>/dev/null || df -h

  echo "== Inodes =="
  df -i -x tmpfs -x devtmpfs 2>/dev/null || df -i

  echo "== Serviços falhados =="
  if has systemctl; then
    systemctl --failed --no-pager --no-legend 2>&1 | head -n 40
  else
    missing systemctl
  fi

  echo "== Top 10 por CPU =="
  ps -eo pid,ppid,user,%cpu,%mem,etime,stat,cmd --sort=-%cpu 2>/dev/null | head -n 11 | cut -c1-220

  echo "== Top 10 por memória =="
  ps -eo pid,ppid,user,%cpu,%mem,rss,etime,stat,cmd --sort=-%mem 2>/dev/null | head -n 11 | cut -c1-220

  echo "== Portas à escuta =="
  if has ss; then
    ss -tlnp 2>/dev/null | head -n 60
  elif has netstat; then
    netstat -tln 2>/dev/null | head -n 60
  else
    missing ss
  fi

  echo "== Últimos reboots =="
  if has last; then last -x -n 10 reboot shutdown 2>&1 | head -n 12; else missing last; fi

  echo "== OOM no boot atual =="
  local oom=""
  if has journalctl; then
    oom=$(journalctl -k -b --no-pager 2>/dev/null | grep -i -E 'out of memory|oom-kill|oom_reaper|killed process' | tail -n 20)
  fi
  if [ -z "$oom" ] && has dmesg; then
    oom=$(dmesg 2>/dev/null | grep -i -E 'out of memory|oom-kill|killed process' | tail -n 20)
  fi
  if [ -n "$oom" ]; then echo "$oom"; else echo "nenhum registo de OOM visível para este utilizador"; fi

  echo "== HTTP local =="
  if has curl; then
    local url code
    for url in https://127.0.0.1/ http://127.0.0.1/; do
      code=$(curl -sk -o /dev/null --connect-timeout 3 --max-time 10 -w '%{http_code} em %{time_total}s' "$url" 2>/dev/null)
      echo "$url -> ${code:-sem resposta}"
    done
  else
    missing curl
  fi

  echo "== Permissões sudo =="
  if has sudo; then
    sudo -n -l 2>&1 | head -n 40
  else
    missing sudo
  fi
}

main "$@" 2>&1 | awk -v max="$MAX_LINES" '
  { if (length($0) > 2000) $0 = substr($0, 1, 2000) " [linha cortada]"; print }
  NR >= max { print "[saída cortada em " max " linhas]"; exit }'
rc=${PIPESTATUS[0]}
[ "$rc" = 141 ] && rc=0
exit "$rc"
