#!/bin/bash
# env-get.sh: o valor de uma variável WMCP_* da configuração de um utilizador, só de leitura.
# Uso: env-get.sh <utilizador> <VARIAVEL>
# Lê /home/<utilizador>/wmcp.env e depois /home/<utilizador>/.bash_wmcp, só para nomes
# WMCP_*. Mascara o valor quando o nome tem PASS, SECRET, TOKEN ou KEY. Se o ficheiro
# não se deixar ler, tenta uma vez sudo -n grep; se o sudo pedir password, diz o que
# deves correr tu.

export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MAX_LINES=200

masked_name() { [[ $1 =~ (PASS|SECRET|TOKEN|KEY) ]]; }

# Valor da última definição de $2 nas linhas recebidas em stdin, sem export nem aspas.
last_value() {
  local var=$1 line="" l v
  while IFS= read -r l; do line=$l; done
  [ -z "$line" ] && return 1
  v=${line#*"$var"=}
  v=${v%%[[:space:]]#*}
  v="${v%"${v##*[![:space:]]}"}"
  if [[ $v == \"*\" ]] || [[ $v == \'*\' ]]; then v=${v:1:${#v}-2}; fi
  printf '%s' "$v"
}

show() {
  local file=$1 var=$2 value
  value=$(last_value "$var") || { echo "$file: $var não está definida"; return; }
  if masked_name "$var"; then
    echo "$file: $var está definida (valor mascarado, ${#value} caracteres)"
  elif [ -z "$value" ]; then
    echo "$file: $var está definida e vazia"
  else
    echo "$file: $var=$value"
  fi
}

main() {
  if [ "$#" -ne 2 ]; then
    echo "uso: env-get.sh <utilizador> <WMCP_VARIAVEL>" >&2
    return 2
  fi
  local user=$1 var=$2 file pattern out found=0
  if ! [[ $user =~ ^[a-z_][a-z0-9_.-]{0,31}$ ]] || [[ $user == *..* ]]; then
    echo "utilizador inválido: $user" >&2
    return 2
  fi
  if ! [[ $var =~ ^WMCP_[A-Za-z0-9_]+$ ]]; then
    echo "só variáveis WMCP_*: $var" >&2
    return 2
  fi
  pattern="^[[:space:]]*(export[[:space:]]+)?$var="

  echo "== Variável $var de $user =="
  for file in "/home/$user/wmcp.env" "/home/$user/.bash_wmcp"; do
    if [ ! -e "$file" ]; then
      echo "$file: não existe"
      continue
    fi
    found=1
    if [ -r "$file" ]; then
      grep -E "$pattern" "$file" 2>/dev/null | show "$file" "$var"
      continue
    fi
    local rc
    out=$(sudo -n grep -E "$pattern" "$file" 2>&1)
    rc=$?
    if [ "$rc" = 0 ]; then
      printf '%s\n' "$out" | show "$file" "$var"
    elif [ "$rc" = 1 ] && [ -z "$out" ]; then
      echo "$file: $var não está definida (lido com sudo)"
    elif ! echo "$out" | grep -qi 'password'; then
      echo "$file: o sudo recusou a leitura: $(echo "$out" | head -n 1)"
    else
      echo "$file: sem permissão de leitura e o sudo pede password."
      if masked_name "$var"; then
        echo "É um segredo: não o tragas para esta conversa. Confirma tu na tua sessão SSH se está definido."
      else
        echo "Para correres na tua sessão SSH: sudo grep -E '^(export )?$var=' $file"
      fi
    fi
  done
  [ "$found" = 0 ] && echo "nenhum dos ficheiros existe para $user"
  return 0
}

main "$@" 2>&1 | awk -v max="$MAX_LINES" '
  { if (length($0) > 1000) $0 = substr($0, 1, 1000) " [linha cortada]"; print }
  NR >= max { print "[saída cortada em " max " linhas]"; exit }'
rc=${PIPESTATUS[0]}
[ "$rc" = 141 ] && rc=0
exit "$rc"
