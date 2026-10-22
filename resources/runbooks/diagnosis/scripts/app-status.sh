#!/bin/bash
# app-status.sh: estado de uma aplicação smile-saas / WMCP, só de leitura.
# Uso: app-status.sh [/home/<utilizador>/www/<app>]
# Sem argumento, descobre as aplicações em /home/*/www/*/tmp/pids.
# Compara os ficheiros de PID com os processos vivos, assinala órfãos, verifica os
# sockets face ao upstream do nginx, e mostra versão, monit, puma.log e HTTP local.

export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MAX_LINES=2500
shopt -s nullglob

has() { command -v "$1" >/dev/null 2>&1; }

valid_app() {
  [[ $1 =~ ^/home/[a-z_][a-z0-9_.-]{0,31}/www/[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$ ]] && [[ $1 != *..* ]]
}

etimes() { ps -o etimes= -p "$1" 2>/dev/null | tr -d ' '; }

# Processos da aplicação: diretório atual igual à pasta da app, ou a pasta no comando.
app_pids() {
  local app=$1 d pid cwd args
  for d in /proc/[0-9]*; do
    pid=${d#/proc/}
    [ "$pid" = "$$" ] && continue
    [ "$pid" = "$BASHPID" ] && continue
    args=$(tr '\0' ' ' <"$d/cmdline" 2>/dev/null)
    [ -z "$args" ] && continue
    case "$args" in *app-status.sh*) continue ;; esac
    cwd=$(readlink "$d/cwd" 2>/dev/null)
    if [ "$cwd" = "$app" ] || [[ $cwd == "$app"/* ]] || [[ $args == *"$app"* ]]; then
      echo "$pid"
    fi
  done
}

# Verdadeiro se $1 descende de algum PID da lista $2 (separada por espaços).
descends_from() {
  local p=$1 list=" $2 " n=0
  while [ -n "$p" ] && [ "$p" -gt 1 ] 2>/dev/null && [ "$n" -lt 25 ]; do
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
    [[ $list == *" $p "* ]] && return 0
    n=$((n + 1))
  done
  return 1
}

report_app() {
  local app=$1 name f pid mtime live_pidfile_pids="" oldest_pidfile=0 e
  name=${app##*/}

  echo "== Aplicação $name =="
  echo "pasta: $app"
  if [ -r "$app/.wire-studio-version" ]; then
    echo "versão instalada: $(head -c 200 "$app/.wire-studio-version" | tr -d '\r')"
  else
    echo "versão instalada: .wire-studio-version não encontrado ou sem acesso"
  fi

  echo "== Ficheiros de PID de $name =="
  local pidfiles=("$app"/tmp/pids/*.pid)
  if [ "${#pidfiles[@]}" -eq 0 ]; then
    echo "nenhum ficheiro .pid em $app/tmp/pids"
  fi
  for f in "${pidfiles[@]}"; do
    pid=$(head -c 32 "$f" 2>/dev/null | tr -dc '0-9')
    mtime=$(stat -c '%y' "$f" 2>/dev/null | cut -c1-19)
    if [ -z "$pid" ]; then
      echo "${f##*/}: vazio ou ilegível (alterado em $mtime)"
    elif [ -d "/proc/$pid" ]; then
      e=$(etimes "$pid")
      echo "${f##*/}: PID $pid vivo há ${e:-?}s (ficheiro de $mtime)"
      ps -o pid=,ppid=,user=,etime=,stat=,cmd= -p "$pid" 2>/dev/null | cut -c1-200 | sed 's/^/  /'
      live_pidfile_pids="$live_pidfile_pids $pid"
      if [ -n "$e" ] && [ "$e" -gt "$oldest_pidfile" ]; then oldest_pidfile=$e; fi
    else
      echo "${f##*/}: PID $pid NÃO existe (ficheiro de PID órfão, de $mtime)"
    fi
  done

  echo "== Processos de $name =="
  local pids p tag
  pids=$(app_pids "$app")
  if [ -z "$pids" ]; then
    echo "nenhum processo desta aplicação visível para este utilizador"
  fi
  for p in $pids; do
    [ -d "/proc/$p" ] || continue
    e=$(etimes "$p")
    if [[ " $live_pidfile_pids " == *" $p "* ]]; then
      tag="do ficheiro de PID"
    elif [ -n "$live_pidfile_pids" ] && descends_from "$p" "$live_pidfile_pids"; then
      tag="filho do processo do ficheiro de PID"
    elif [ -n "$live_pidfile_pids" ] && [ -n "$e" ] && [ "$e" -gt "$oldest_pidfile" ]; then
      tag="ÓRFÃO: mais antigo que o processo do ficheiro de PID e fora da sua árvore"
    elif [ -n "$live_pidfile_pids" ]; then
      tag="fora da árvore do ficheiro de PID"
    else
      tag="sem ficheiro de PID vivo"
    fi
    echo "[$tag]"
    ps -o pid=,ppid=,pgid=,sid=,tty=,user=,etime=,stat=,cmd= -p "$p" 2>/dev/null | cut -c1-200 | sed 's/^/  /'
  done

  echo "== Sockets de $name =="
  local socks=("$app"/tmp/sockets/*) s listening
  if [ "${#socks[@]}" -eq 0 ]; then
    echo "nenhum socket em $app/tmp/sockets"
  fi
  for s in "${socks[@]}"; do
    listening="não verificado (ss não instalado)"
    if has ss; then
      if ss -xl 2>/dev/null | grep -qF " $s "; then listening="à escuta"; else listening="NINGUÉM à escuta"; fi
    fi
    echo "$s: $listening"
  done

  echo "== Upstream do nginx para $name =="
  if [ -r /etc/nginx ]; then
    local ups u path
    ups=$(grep -rhoE 'unix:[^ ;:]+' /etc/nginx 2>/dev/null | grep -F "$app" | sort -u)
    if [ -z "$ups" ]; then
      echo "nenhum upstream unix: com $app na configuração legível do nginx"
    fi
    for u in $ups; do
      path=${u#unix:}
      if [ -S "$path" ]; then
        if has ss && ss -xl 2>/dev/null | grep -qF " $path "; then
          echo "$u: socket existe e está à escuta"
        else
          echo "$u: socket existe mas ninguém está à escuta"
        fi
      else
        echo "$u: socket NÃO existe"
      fi
    done
  else
    echo "/etc/nginx sem acesso"
  fi

  echo "== Fim do puma.log de $name =="
  local logs=("$app"/log/puma*.log)
  if [ "${#logs[@]}" -eq 0 ]; then
    echo "nenhum log/puma*.log"
  fi
  for f in "${logs[@]}"; do
    echo "--- ${f##*/}"
    tail -n 30 "$f" 2>&1 | cut -c1-300
  done

  echo "== HTTP pelo socket de $name =="
  if has curl; then
    local code
    for s in "${socks[@]}"; do
      [ -S "$s" ] || continue
      code=$(curl -s -o /dev/null --connect-timeout 3 --max-time 10 -w '%{http_code}' --unix-socket "$s" http://localhost/ 2>/dev/null)
      echo "$s -> ${code:-sem resposta (ou curl sem --unix-socket)}"
    done
  else
    echo "curl: não instalado"
  fi
}

main() {
  local apps=() d
  if [ "$#" -gt 1 ]; then
    echo "uso: app-status.sh [/home/<utilizador>/www/<app>]" >&2
    return 2
  fi
  if [ "$#" -eq 1 ]; then
    d=${1%/}
    if ! valid_app "$d"; then
      echo "pasta inválida: tem de ser /home/<utilizador>/www/<app>" >&2
      return 2
    fi
    apps=("$d")
  else
    for d in /home/*/www/*/tmp/pids; do
      [ -d "$d" ] && apps+=("${d%/tmp/pids}")
    done
  fi
  if [ "${#apps[@]}" -eq 0 ]; then
    echo "== Aplicações =="
    echo "nenhuma aplicação encontrada em /home/*/www/*/tmp/pids"
  fi
  for d in "${apps[@]}"; do
    report_app "$d"
  done

  echo "== Monit =="
  if has sudo; then
    local out
    out=$(sudo -n monit summary 2>&1)
    if echo "$out" | grep -qiE 'password is required|a password|senha'; then
      echo "o sudo pede password. Para veres o monit, corre tu na tua sessão SSH: sudo monit summary"
    else
      echo "$out" | head -n 40
    fi
  else
    echo "sudo: não instalado"
  fi

  echo "== HTTP local =="
  if has curl; then
    local url code
    for url in https://127.0.0.1/ http://127.0.0.1/; do
      code=$(curl -sk -o /dev/null --connect-timeout 3 --max-time 10 -w '%{http_code} em %{time_total}s' "$url" 2>/dev/null)
      echo "$url -> ${code:-sem resposta}"
    done
  else
    echo "curl: não instalado"
  fi
}

main "$@" 2>&1 | awk -v max="$MAX_LINES" '
  { if (length($0) > 2000) $0 = substr($0, 1, 2000) " [linha cortada]"; print }
  NR >= max { print "[saída cortada em " max " linhas]"; exit }'
rc=${PIPESTATUS[0]}
[ "$rc" = 141 ] && rc=0
exit "$rc"
