#!/bin/bash
# log-window.sh: linhas de um log numa janela de tempo, só de leitura.
# Uso: log-window.sh <ficheiro> <de> <até> [regex]
#   <de> e <até> no formato 'AAAA-MM-DD HH:MM' (até inclui o minuto inteiro).
# Reconhece datas ISO (2026-10-19 17:13:02 ou 2026-10-19T17:13:02), syslog
# (Oct 19 17:13:02), nginx access (19/Oct/2026:17:13:02) e nginx error
# (2026/10/19 17:13:02). Uma linha sem data herda a da linha anterior.
# Lê também os rodados do mesmo ficheiro (.1, -AAAAMMDD, .gz) alterados depois de <de>.

export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MAX_MATCHES=2000
MAX_LINES=2200
shopt -s nullglob

allowed_file() {
  local f=$1 base=${1##*/}
  [[ $f == *..* ]] && return 1
  [[ $f =~ ^/var/log/ || $f =~ ^/home/[a-z_][a-z0-9_.-]*/www/ || $f =~ ^/var/lib/pgsql/[0-9.]+/data/log/ ]] || return 1
  [[ $base =~ (\.env|database\.yml|secrets|credentials|master\.key|\.key|\.pem|\.p12|\.pfx|^id_|pgpass|netrc|git-credentials) ]] && return 1
  return 0
}

valid_time() { [[ $1 =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{2}:[0-9]{2}$ ]]; }

reader() {
  if command -v gzip >/dev/null 2>&1; then gzip -dcf -- "$1"; else cat -- "$1"; fi
}

main() {
  if [ "$#" -lt 3 ] || [ "$#" -gt 4 ]; then
    echo "uso: log-window.sh <ficheiro> <'AAAA-MM-DD HH:MM'> <'AAAA-MM-DD HH:MM'> [regex]" >&2
    return 2
  fi
  local file=$1 from=$2 to=$3 re=${4:-}
  if ! allowed_file "$file"; then
    echo "ficheiro fora dos caminhos de leitura do despiste: $file" >&2
    return 2
  fi
  if ! valid_time "$from" || ! valid_time "$to"; then
    echo "datas inválidas: use 'AAAA-MM-DD HH:MM'" >&2
    return 2
  fi
  if [[ $to < $from ]]; then
    echo "a data final é anterior à inicial" >&2
    return 2
  fi
  if [ ! -e "$file" ]; then
    echo "o ficheiro não existe: $file"
    return 1
  fi
  if [ ! -r "$file" ]; then
    echo "sem permissão de leitura: $file"
    echo "Se for um log do sistema, corre tu na tua sessão SSH com sudo, ou usa o journal."
    return 1
  fi

  # Rodados alterados depois do início da janela, do mais antigo para o mais recente.
  local files=() from_epoch f m
  from_epoch=$(date -d "$from" +%s 2>/dev/null || echo 0)
  case "$file" in
    *.gz | *.[0-9] | *-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;;
    *)
      while read -r _ f; do
        [ -n "$f" ] && files+=("$f")
      done < <(for f in "$file".[0-9]* "$file"-[0-9]*; do
        [ -r "$f" ] || continue
        m=$(stat -c %Y "$f" 2>/dev/null) || continue
        [ "$m" -ge "$from_epoch" ] && echo "$m $f"
      done | sort -n)
      ;;
  esac
  files+=("$file")

  echo "== Janela $from a $to em ${file##*/} =="
  echo "ficheiros lidos: ${files[*]}"
  [ -n "$re" ] && echo "filtro: $re"

  for f in "${files[@]}"; do
    printf '\001FILE %s\n' "$f"
    reader "$f" 2>/dev/null
  done | FROM="$from:00" TO="$to:59" RE="$re" YEAR="${from:0:4}" MAXM="$MAX_MATCHES" awk '
    BEGIN {
      from = ENVIRON["FROM"]; to = ENVIRON["TO"]; re = ENVIRON["RE"]; year = ENVIRON["YEAR"]
      maxm = ENVIRON["MAXM"] + 0
      split("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec", m, " ")
      for (i = 1; i <= 12; i++) mon[m[i]] = sprintf("%02d", i)
    }
    function ts(line,   s, a) {
      if (match(line, /[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][T ][0-9][0-9]:[0-9][0-9]:[0-9][0-9]/)) {
        s = substr(line, RSTART, 19); return substr(s, 1, 10) " " substr(s, 12, 8)
      }
      if (match(line, /[0-9][0-9]\/[A-Z][a-z][a-z]\/[0-9][0-9][0-9][0-9]:[0-9][0-9]:[0-9][0-9]:[0-9][0-9]/)) {
        s = substr(line, RSTART, 20); return substr(s, 8, 4) "-" mon[substr(s, 4, 3)] "-" substr(s, 1, 2) " " substr(s, 13, 8)
      }
      if (match(line, /[0-9][0-9][0-9][0-9]\/[0-9][0-9]\/[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]/)) {
        s = substr(line, RSTART, 19); gsub(/\//, "-", s); return s
      }
      if (match(line, /^[A-Z][a-z][a-z] +[0-9]+ [0-9][0-9]:[0-9][0-9]:[0-9][0-9]/)) {
        split(substr(line, 1, RLENGTH), a, / +/)
        if (a[1] in mon) return year "-" mon[a[1]] "-" sprintf("%02d", a[2]) " " a[3]
      }
      return ""
    }
    /^\001FILE / { file = substr($0, 7); cur = ""; shown = 0; next }
    {
      t = ts($0)
      if (t != "") cur = t
      if (cur == "" || cur < from || cur > to) next
      if (re != "" && $0 !~ re) next
      total++
      if (n >= maxm) next
      if (!shown) { print "--- " file; shown = 1 }
      line = $0
      if (length(line) > 1000) line = substr(line, 1, 1000) " [linha cortada]"
      print line
      n++
    }
    END {
      print "== Resumo da janela =="
      print "linhas na janela" (re != "" ? " com o filtro" : "") ": " total + 0
      if (total > n) print "mostradas só as primeiras " n "; estreita a janela ou o filtro"
    }'
}

main "$@" 2>&1 | awk -v max="$MAX_LINES" '
  { if (length($0) > 2000) $0 = substr($0, 1, 2000) " [linha cortada]"; print }
  NR >= max { print "[saída cortada em " max " linhas]"; exit }'
rc=${PIPESTATUS[0]}
[ "$rc" = 141 ] && rc=0
exit "$rc"
