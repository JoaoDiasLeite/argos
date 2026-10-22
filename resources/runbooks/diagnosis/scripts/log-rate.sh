#!/bin/bash
# log-rate.sh: pedidos por minuto e contagem por código de estado, só de leitura.
# Uso: log-rate.sh <access.log> <de> <até>
#   <de> e <até> no formato 'AAAA-MM-DD HH:MM' (até inclui o minuto inteiro).
# Espera o formato combined do nginx: ... [19/Oct/2026:17:13:02 +0100] "GET / HTTP/1.1" 200 ...
# Lê também os rodados do mesmo ficheiro (.1, -AAAAMMDD, .gz) alterados depois de <de>.

export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MAX_LINES=2000
shopt -s nullglob

allowed_file() {
  local f=$1 base=${1##*/}
  [[ $f == *..* ]] && return 1
  [[ $f =~ ^/var/log/ || $f =~ ^/home/[a-z_][a-z0-9_.-]*/www/ ]] || return 1
  [[ $base =~ (\.env|database\.yml|secrets|credentials|master\.key|\.key|\.pem|\.p12|\.pfx|^id_|pgpass|netrc|git-credentials) ]] && return 1
  return 0
}

valid_time() { [[ $1 =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{2}:[0-9]{2}$ ]]; }

reader() {
  if command -v gzip >/dev/null 2>&1; then gzip -dcf -- "$1"; else cat -- "$1"; fi
}

main() {
  if [ "$#" -ne 3 ]; then
    echo "uso: log-rate.sh <access.log> <'AAAA-MM-DD HH:MM'> <'AAAA-MM-DD HH:MM'>" >&2
    return 2
  fi
  local file=$1 from=$2 to=$3
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
  if [ ! -r "$file" ]; then
    echo "sem permissão de leitura ou ficheiro inexistente: $file"
    return 1
  fi

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

  echo "== Pedidos por minuto em ${file##*/} =="
  echo "janela: $from a $to"
  echo "ficheiros lidos: ${files[*]}"

  for f in "${files[@]}"; do
    reader "$f" 2>/dev/null
  done | FROM="$from" TO="$to" awk '
    BEGIN {
      from = ENVIRON["FROM"]; to = ENVIRON["TO"]
      split("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec", m, " ")
      for (i = 1; i <= 12; i++) mon[m[i]] = sprintf("%02d", i)
    }
    {
      if (!match($0, /\[[0-9][0-9]\/[A-Z][a-z][a-z]\/[0-9][0-9][0-9][0-9]:[0-9][0-9]:[0-9][0-9]/)) { skipped++; next }
      s = substr($0, RSTART + 1, 17)
      k = substr(s, 8, 4) "-" mon[substr(s, 4, 3)] "-" substr(s, 1, 2) " " substr(s, 13, 5)
      if (k < from || k > to) next
      code = "???"
      if (match($0, /" [0-9][0-9][0-9] /)) code = substr($0, RSTART + 2, 3)
      total++; per[k]++; byCode[code]++
      c = substr(code, 1, 1)
      if (c == "2" || c == "3") ok[k]++
      else if (c == "4") c4[k]++
      else if (c == "5") c5[k]++
      if (code == "499") x499[k]++
      if (code == "502") x502[k]++
      if (code == "504") x504[k]++
      if (!(k in seen)) { seen[k] = 1; keys[++nk] = k }
    }
    END {
      if (total == 0) { print "nenhum pedido na janela"; if (skipped) print "linhas sem data no formato nginx: " skipped; exit }
      # Ordena os minutos (inserção simples; a janela tem poucas centenas de minutos).
      for (i = 2; i <= nk; i++) { v = keys[i]; j = i - 1; while (j > 0 && keys[j] > v) { keys[j + 1] = keys[j]; j-- } keys[j + 1] = v }
      printf "%-16s %7s %7s %6s %6s %6s %6s %6s\n", "minuto", "total", "2xx3xx", "4xx", "5xx", "499", "502", "504"
      for (i = 1; i <= nk; i++) {
        k = keys[i]
        printf "%-16s %7d %7d %6d %6d %6d %6d %6d\n", k, per[k], ok[k], c4[k], c5[k], x499[k], x502[k], x504[k]
      }
      print "== Códigos de estado na janela =="
      for (c in byCode) printf "%s %d\n", c, byCode[c] | "sort"
      close("sort")
      print "total: " total
    }'
}

main "$@" 2>&1 | awk -v max="$MAX_LINES" '
  { if (length($0) > 2000) $0 = substr($0, 1, 2000) " [linha cortada]"; print }
  NR >= max { print "[saída cortada em " max " linhas]"; exit }'
rc=${PIPESTATUS[0]}
[ "$rc" = 141 ] && rc=0
exit "$rc"
