#!/bin/bash
# pg-query.sh: uma query de leitura no PostgreSQL.
# Uso: pg-query.sh <base de dados> <sql>
# Corre dentro de BEGIN READ ONLY com SET LOCAL statement_timeout = '15s', e termina
# com ROLLBACK. Aceita só SELECT, WITH, SHOW e EXPLAIN (sem ANALYZE), uma instrução,
# sem comandos do psql e sem funções com efeitos que uma transação de leitura ainda
# permite (pg_terminate_backend, pg_sleep, lo_*, dblink*, set_config, ...).
# Liga como o utilizador SSH; se não conseguir e o sudo não pedir password, como postgres.

export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PGCONNECT_TIMEOUT=5
MAX_LINES=1000
shopt -s nullglob

PSQL=""
AS_POSTGRES=0
# Vazio = socket local; senão -h 127.0.0.1, para quando o socket não está no sítio habitual.
PGH=()

# Funções que uma transação READ ONLY não trava, ou que executam SQL vindo de texto.
FORBIDDEN='(^|[^a-z0-9_$])(pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_sleep[a-z_]*|lo_[a-z_]+|dblink[a-z_]*|set_config|pg_advisory[a-z_]*|pg_try_advisory[a-z_]*|pg_notify|pg_read_file|pg_read_binary_file|pg_ls_[a-z_]+|pg_stat_file|pg_file_[a-z_]+|pg_switch_[a-z_]+|pg_create_[a-z_]+|pg_drop_[a-z_]+|pg_promote|pg_wal_[a-z_]+|pg_xlog_[a-z_]+|pg_logical_[a-z_]+|pg_replication_[a-z_]+|pg_start_backup|pg_stop_backup|pg_backup_[a-z_]+|pg_log_[a-z_]+|pg_stat_reset[a-z_]*|pg_import_[a-z_]+|[a-z_]*_to_xml[a-z_]*|query_to_[a-z_]+)([^a-z0-9_$]|$)'

find_psql() {
  if command -v psql >/dev/null 2>&1; then
    PSQL=$(command -v psql)
    return 0
  fi
  local p
  for p in /usr/pgsql-*/bin/psql; do
    [ -x "$p" ] && PSQL=$p
  done
  [ -n "$PSQL" ]
}

run_psql() {
  if [ "$AS_POSTGRES" = 1 ]; then
    sudo -n -u postgres "$PSQL" "${PGH[@]}" "$@"
  else
    "$PSQL" "${PGH[@]}" "$@"
  fi
}

connect() {
  local db=$1 err
  if err=$("$PSQL" -X -w -At -d "$db" -c 'select 1' 2>&1); then
    return 0
  fi
  if "$PSQL" -X -w -At -h 127.0.0.1 -d "$db" -c 'select 1' >/dev/null 2>&1; then
    PGH=(-h 127.0.0.1)
    return 0
  fi
  if sudo -n -u postgres "$PSQL" -X -w -At -d "$db" -c 'select 1' >/dev/null 2>&1; then
    AS_POSTGRES=1
    return 0
  fi
  echo "não consegui ligar à base $db."
  echo "como $(id -un): $(echo "$err" | head -n 2 | tr '\n' ' ')"
  echo "como postgres: o sudo pede password ou não é permitido."
  echo "Para correres na tua sessão SSH: sudo -u postgres psql -d $db"
  return 1
}

# Põe em REASON o motivo para recusar o SQL; se o aceitar, põe em S_CLEAN a instrução sem
# o ; final nem os espaços e comentários do início.
check_sql() {
  local sql=$1 s lower first
  [ "${#sql}" -gt 4000 ] && { REASON="a query tem mais de 4000 caracteres"; return; }
  [[ $sql == *[[:cntrl:]]* ]] && { REASON="a query tem caracteres de controlo (mudanças de linha incluídas)"; return; }
  [[ $sql == *\\* ]] && { REASON="a query tem '\\', que o psql leria como um comando seu"; return; }

  # Tira espaços e comentários /* */ do início. Um comentário -- tapava o resto da linha.
  s=$sql
  while :; do
    s="${s#"${s%%[![:space:]]*}"}"
    if [[ $s == /\** ]]; then
      [[ $s == *\*/* ]] || { REASON="comentário /* sem fim"; return; }
      s=${s#*\*/}
      continue
    fi
    break
  done
  [[ $s == --* ]] && { REASON="a query começa por um comentário -- e não tem nada depois"; return; }

  # Um ; só no fim. Qualquer outro, mesmo dentro de texto, é recusado.
  s="${s%"${s##*[![:space:]]}"}"
  s=${s%;}
  [[ $s == *\;* ]] && { REASON="só uma instrução: o ';' só pode vir no fim"; return; }

  lower=$(printf '%s' "$s" | tr 'A-Z' 'a-z')
  first=${lower%%[^a-z]*}
  case "$first" in
    select | with | show) ;;
    explain)
      if [[ $lower =~ analy[sz]e ]]; then
        REASON="EXPLAIN com ANALYZE executa a query; usa EXPLAIN sem ANALYZE"
        return
      fi
      ;;
    *)
      REASON="só SELECT, WITH, SHOW e EXPLAIN; esta começa por '${first:-?}'"
      return
      ;;
  esac
  if [[ $lower =~ $FORBIDDEN ]]; then
    REASON="a query chama ${BASH_REMATCH[2]}, que tem efeitos fora da leitura"
    return
  fi
  # SELECT INTO e FOR UPDATE não precisam de regra: a transação de leitura recusa-os.
  S_CLEAN=$s
}

main() {
  if [ "$#" -ne 2 ]; then
    echo "uso: pg-query.sh <base de dados> <sql>" >&2
    return 2
  fi
  local db=$1 sql=$2
  if ! [[ $db =~ ^[A-Za-z_][A-Za-z0-9_-]{0,62}$ ]]; then
    echo "nome de base de dados inválido: $db" >&2
    return 2
  fi
  REASON=""
  S_CLEAN=""
  check_sql "$sql"
  if [ -n "$REASON" ] || [ -z "$S_CLEAN" ]; then
    echo "query recusada: ${REASON:-vazia}" >&2
    return 2
  fi
  cd / || return 1

  if ! find_psql; then
    echo "psql: não instalado"
    return 1
  fi
  connect "$db" || return 1

  echo "== Query em $db =="
  echo "$S_CLEAN;"
  echo "== Resultado =="
  printf '%s\n' \
    'BEGIN READ ONLY;' \
    "SET LOCAL statement_timeout = '15s';" \
    "$S_CLEAN;" \
    'ROLLBACK;' |
    run_psql -X -w -q -v ON_ERROR_STOP=1 -P pager=off -P footer=on -d "$db" 2>&1
}

main "$@" 2>&1 | awk -v max="$MAX_LINES" '
  { if (length($0) > 2000) $0 = substr($0, 1, 2000) " [linha cortada]"; print }
  NR >= max { print "[saída cortada em " max " linhas; usa LIMIT]"; exit }'
rc=${PIPESTATUS[0]}
[ "$rc" = 141 ] && rc=0
exit "$rc"
