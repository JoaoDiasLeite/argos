#!/bin/bash
# tls-check.sh: validade, emissor e cadeia de um certificado TLS, só de leitura.
# Uso: tls-check.sh <host[:porta]> [nome SNI]
#   tls-check.sh recrutamento.exemplo.pt
#   tls-check.sh 127.0.0.1:443 recrutamento.exemplo.pt   (o certificado servido localmente)
# Só abre a ligação e lê o certificado; não envia nenhum pedido HTTP.

export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MAX_LINES=400

has() { command -v "$1" >/dev/null 2>&1; }

valid_host() { [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$ ]]; }

# O certificado número $1 (a contar de 1) do texto em stdin.
nth_cert() {
  awk -v n="$1" '/-----BEGIN CERTIFICATE-----/ { c++ } c == n { print } c == n && /-----END CERTIFICATE-----/ { exit }'
}

main() {
  if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
    echo "uso: tls-check.sh <host[:porta]> [nome SNI]" >&2
    return 2
  fi
  local target=$1 host port sni out i cert count end_date end_epoch now days
  host=${target%%:*}
  port=443
  [[ $target == *:* ]] && port=${target#*:}
  sni=${2:-$host}
  if ! valid_host "$host" || ! valid_host "$sni" || ! [[ $port =~ ^[0-9]{1,5}$ ]]; then
    echo "argumentos inválidos: use host[:porta] [nome SNI]" >&2
    return 2
  fi
  if ! has openssl; then
    echo "openssl: não instalado"
    return 1
  fi

  echo "== Ligação TLS a $host:$port (SNI $sni) =="
  if has timeout; then
    out=$(timeout 15 openssl s_client -connect "$host:$port" -servername "$sni" -showcerts </dev/null 2>&1)
  else
    out=$(openssl s_client -connect "$host:$port" -servername "$sni" -showcerts </dev/null 2>&1)
  fi
  count=$(printf '%s\n' "$out" | grep -c -- '-----BEGIN CERTIFICATE-----')
  if [ "$count" = 0 ]; then
    echo "nenhum certificado recebido"
    printf '%s\n' "$out" | grep -iE 'error|errno|refused|timeout|unable' | head -n 10
    return 1
  fi
  printf '%s\n' "$out" | grep -E '^(Protocol|    Protocol|    Cipher|Verify return code|Verification)' | sort -u | head -n 6

  echo "== Certificado do servidor =="
  cert=$(printf '%s\n' "$out" | nth_cert 1)
  printf '%s\n' "$cert" | openssl x509 -noout -subject -issuer -dates -serial 2>&1
  printf '%s\n' "$cert" | openssl x509 -noout -text 2>/dev/null |
    grep -A1 'Subject Alternative Name' | tail -n 1 | sed 's/^ *//' | cut -c1-1500
  end_date=$(printf '%s\n' "$cert" | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  if [ -n "$end_date" ]; then
    end_epoch=$(date -d "$end_date" +%s 2>/dev/null)
    now=$(date +%s)
    if [ -n "$end_epoch" ]; then
      days=$(((end_epoch - now) / 86400))
      if [ "$days" -lt 0 ]; then
        echo "EXPIRADO há $((-days)) dias"
      else
        echo "expira daqui a $days dias"
      fi
    fi
  fi
  if printf '%s\n' "$cert" | openssl x509 -noout -checkhost "$sni" >/dev/null 2>&1; then
    printf '%s\n' "$cert" | openssl x509 -noout -checkhost "$sni" 2>&1
  fi

  echo "== Cadeia enviada pelo servidor =="
  echo "certificados na cadeia: $count"
  for ((i = 1; i <= count && i <= 6; i++)); do
    echo "[$i]"
    printf '%s\n' "$out" | nth_cert "$i" | openssl x509 -noout -subject -issuer -enddate 2>&1 | sed 's/^/  /'
  done
}

main "$@" 2>&1 | awk -v max="$MAX_LINES" '
  { if (length($0) > 2000) $0 = substr($0, 1, 2000) " [linha cortada]"; print }
  NR >= max { print "[saída cortada em " max " linhas]"; exit }'
rc=${PIPESTATUS[0]}
[ "$rc" = 141 ] && rc=0
exit "$rc"
