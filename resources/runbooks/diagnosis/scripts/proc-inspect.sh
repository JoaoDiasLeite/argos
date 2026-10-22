#!/bin/bash
# proc-inspect.sh: onde está um processo e a que sessão pertence, só de leitura.
# Uso: proc-inspect.sh <pid|nome>
# Com um nome, inspeciona até 5 processos cujo comando o contém.
# Nunca lê /proc/<pid>/environ nem /proc/<pid>/mem.

export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MAX_LINES=1500
PS_FIELDS=pid,ppid,pgid,sid,tty,user,etime,stat,wchan:20,cmd

has() { command -v "$1" >/dev/null 2>&1; }

inspect() {
  local pid=$1 p d n
  echo "== Processo $pid =="
  if [ ! -d "/proc/$pid" ]; then
    echo "o processo $pid já não existe"
    return 0
  fi
  ps -o "$PS_FIELDS" -p "$pid" 2>/dev/null | cut -c1-300

  echo "== Ascendência de $pid =="
  p=$pid
  n=0
  while [ -n "$p" ] && [ "$p" -gt 0 ] 2>/dev/null && [ "$n" -lt 30 ]; do
    ps -o pid=,ppid=,pgid=,sid=,tty=,user=,etime=,cmd= -p "$p" 2>/dev/null | cut -c1-200
    [ "$p" = 1 ] && break
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
    n=$((n + 1))
  done

  echo "== Árvore de $pid =="
  if has pstree; then
    pstree -ap "$pid" 2>/dev/null | head -n 60 | cut -c1-200
  else
    echo "pstree: não instalado"
    ps -o pid,ppid,etime,cmd --ppid "$pid" 2>/dev/null | head -n 40 | cut -c1-200
  fi

  echo "== Estado e espera de $pid =="
  if [ -r "/proc/$pid/wchan" ]; then
    echo "wchan: $(cat "/proc/$pid/wchan" 2>/dev/null)"
  fi
  if [ -r "/proc/$pid/status" ]; then
    grep -E '^(Name|State|PPid|Threads|VmRSS|VmSwap|voluntary_ctxt_switches|nonvoluntary_ctxt_switches):' "/proc/$pid/status"
  fi

  echo "== Descritores e diretório de $pid =="
  for d in 0 1 2; do
    echo "fd/$d -> $(readlink "/proc/$pid/fd/$d" 2>/dev/null || echo 'sem acesso')"
  done
  echo "cwd -> $(readlink "/proc/$pid/cwd" 2>/dev/null || echo 'sem acesso')"
  echo "exe -> $(readlink "/proc/$pid/exe" 2>/dev/null || echo 'sem acesso')"
  if [ -r "/proc/$pid/fd" ] && [ -x "/proc/$pid/fd" ]; then
    local total sockets pipes
    total=$(ls "/proc/$pid/fd" 2>/dev/null | wc -l)
    sockets=$(ls -l "/proc/$pid/fd" 2>/dev/null | grep -c 'socket:')
    pipes=$(ls -l "/proc/$pid/fd" 2>/dev/null | grep -c 'pipe:')
    echo "descritores abertos: $total (sockets: $sockets, pipes: $pipes)"
  else
    echo "descritores: sem acesso (processo de outro utilizador)"
  fi

  echo "== Sockets de $pid =="
  if has ss; then
    ss -tanp 2>/dev/null | grep -F "pid=$pid," | head -n 30
    ss -xap 2>/dev/null | grep -F "pid=$pid," | head -n 30
    echo "(sem sudo, o ss só mostra os sockets dos processos deste utilizador)"
  else
    echo "ss: não instalado"
  fi

  echo "== Limites de $pid =="
  if [ -r "/proc/$pid/limits" ]; then
    grep -E '^(Max open files|Max processes|Max address space|Max resident set)' "/proc/$pid/limits"
  else
    echo "sem acesso"
  fi
}

main() {
  if [ "$#" -ne 1 ]; then
    echo "uso: proc-inspect.sh <pid|nome>" >&2
    return 2
  fi
  local target=$1 pids pid
  if [[ $target =~ ^[0-9]{1,7}$ ]]; then
    pids=$target
  elif [[ $target =~ ^[A-Za-z0-9_][A-Za-z0-9_.:@-]{0,63}$ ]]; then
    if ! has pgrep; then
      echo "pgrep: não instalado"
      return 1
    fi
    # Sem o próprio script, cujo comando também contém o nome procurado.
    pids=$(for pid in $(pgrep -f -- "$target" 2>/dev/null); do
      case "$(ps -o cmd= -p "$pid" 2>/dev/null)" in
        '' | *proc-inspect.sh*) ;;
        *) echo "$pid" ;;
      esac
    done | head -n 5)
    echo "== Processos com '$target' no comando =="
    if [ -z "$pids" ]; then
      echo "nenhum processo encontrado"
      return 0
    fi
    ps -o pid,ppid,etime,cmd -p "$(echo "$pids" | paste -sd, -)" 2>/dev/null | cut -c1-200
  else
    echo "argumento inválido: use um PID ou um nome simples" >&2
    return 2
  fi
  for pid in $pids; do
    inspect "$pid"
  done
}

main "$@" 2>&1 | awk -v max="$MAX_LINES" '
  { if (length($0) > 2000) $0 = substr($0, 1, 2000) " [linha cortada]"; print }
  NR >= max { print "[saída cortada em " max " linhas]"; exit }'
rc=${PIPESTATUS[0]}
[ "$rc" = 141 ] && rc=0
exit "$rc"
