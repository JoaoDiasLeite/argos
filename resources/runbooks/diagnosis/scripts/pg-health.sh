#!/bin/bash
# pg-health.sh: saúde do PostgreSQL, só de leitura.
# Uso: pg-health.sh [base de dados]
# Sem base de dados, mostra o que é do cluster e lista as bases; com ela, também as
# tabelas (seq_scan face a idx_scan, autovacuum, tamanhos).
# Liga como o utilizador SSH; se não conseguir e o sudo não pedir password, como postgres.
# A sessão corre com default_transaction_read_only e statement_timeout de 15s.

export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PGCONNECT_TIMEOUT=5
MAX_LINES=1500
shopt -s nullglob

PSQL=""
AS_POSTGRES=0
# Vazio = socket local; senão -h 127.0.0.1, para quando o socket não está no sítio habitual.
PGH=()

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

# Escolhe como ligar: como este utilizador, ou como postgres via sudo sem password.
connect() {
  local db=$1 err
  if err=$("$PSQL" -X -w -At -d "$db" -c 'select 1' 2>&1); then
    echo "ligação: como $(id -un)"
    return 0
  fi
  if "$PSQL" -X -w -At -h 127.0.0.1 -d "$db" -c 'select 1' >/dev/null 2>&1; then
    PGH=(-h 127.0.0.1)
    echo "ligação: como $(id -un), por TCP em 127.0.0.1"
    return 0
  fi
  if sudo -n -u postgres "$PSQL" -X -w -At -d "$db" -c 'select 1' >/dev/null 2>&1; then
    AS_POSTGRES=1
    echo "ligação: como postgres (sudo sem password)"
    return 0
  fi
  echo "não consegui ligar à base $db."
  echo "como $(id -un): $(echo "$err" | head -n 2 | tr '\n' ' ')"
  echo "como postgres: o sudo pede password ou não é permitido."
  echo "Para correres na tua sessão SSH: sudo -u postgres psql -d $db"
  return 1
}

main() {
  if [ "$#" -gt 1 ]; then
    echo "uso: pg-health.sh [base de dados]" >&2
    return 2
  fi
  local db=${1:-postgres} per_db=0
  [ "$#" -eq 1 ] && per_db=1
  if ! [[ $db =~ ^[A-Za-z_][A-Za-z0-9_-]{0,62}$ ]]; then
    echo "nome de base de dados inválido: $db" >&2
    return 2
  fi
  cd / || return 1

  echo "== Ligação ao PostgreSQL =="
  if ! find_psql; then
    echo "psql: não instalado"
    return 1
  fi
  echo "psql: $PSQL"
  connect "$db" || return 1

  {
    printf '%s\n' "$SQL_CLUSTER"
    if [ "$per_db" = 1 ]; then
      printf '%s\n' "$SQL_TABLES"
    else
      printf '%s\n' '\echo == Tabelas ==' '\echo indica a base de dados (pg-health.sh <bd>) para ver as tabelas'
    fi
  } | run_psql -X -w -q -P pager=off -d "$db" 2>&1
}

# As queries vão para o psql por um pipe. Sem heredocs, porque o bash pode guardá-los
# num ficheiro temporário, e este script não escreve em lado nenhum.
SQL_CLUSTER="SET default_transaction_read_only = on;
SET statement_timeout = '15s';
\pset pager off
\echo == Versão ==
SELECT version();
\echo == Ligações ==
SELECT count(*) AS ligacoes, current_setting('max_connections') AS max_connections FROM pg_stat_activity;
SELECT datname, state, count(*) AS n FROM pg_stat_activity GROUP BY 1, 2 ORDER BY 3 DESC;
\echo == Queries ativas há mais de 1s ==
SELECT pid, usename, datname, date_trunc('second', now() - query_start) AS duracao, state,
       left(regexp_replace(query, '\s+', ' ', 'g'), 200) AS query
  FROM pg_stat_activity
 WHERE state <> 'idle' AND pid <> pg_backend_pid() AND now() - query_start > interval '1 second'
 ORDER BY query_start LIMIT 30;
\echo == Sessões idle in transaction ==
SELECT pid, usename, datname, date_trunc('second', now() - state_change) AS ha,
       left(regexp_replace(query, '\s+', ' ', 'g'), 150) AS ultima_query
  FROM pg_stat_activity
 WHERE state LIKE 'idle in transaction%'
 ORDER BY state_change LIMIT 20;
\echo == Locks em espera ==
SELECT l.pid, a.usename, l.locktype, l.mode, l.relation::regclass AS relacao,
       date_trunc('second', now() - a.query_start) AS espera,
       left(regexp_replace(a.query, '\s+', ' ', 'g'), 150) AS query
  FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
 WHERE NOT l.granted LIMIT 30;
\echo == Bases de dados ==
SELECT datname,
       CASE WHEN has_database_privilege(datname, 'CONNECT') THEN pg_size_pretty(pg_database_size(datname)) ELSE 'sem acesso' END AS tamanho
  FROM pg_database WHERE NOT datistemplate ORDER BY datname;
\echo == Parâmetros principais ==
SELECT name, setting, unit FROM pg_settings
 WHERE name IN ('max_connections', 'shared_buffers', 'work_mem', 'maintenance_work_mem',
                'effective_cache_size', 'statement_timeout', 'idle_in_transaction_session_timeout',
                'lock_timeout', 'log_min_duration_statement', 'autovacuum', 'autovacuum_max_workers',
                'random_page_cost', 'max_wal_size', 'checkpoint_timeout')
 ORDER BY name;"

SQL_TABLES="\echo == Tabelas com mais seq_scan do que idx_scan ==
SELECT relname, seq_scan, seq_tup_read, idx_scan, n_live_tup
  FROM pg_stat_user_tables
 WHERE seq_scan > coalesce(idx_scan, 0) AND n_live_tup > 10000
 ORDER BY seq_tup_read DESC LIMIT 15;
\echo == Autovacuum e analyze ==
SELECT relname, n_live_tup, n_dead_tup, last_autovacuum, last_autoanalyze, last_vacuum, last_analyze
  FROM pg_stat_user_tables ORDER BY n_dead_tup DESC LIMIT 15;
\echo == Maiores tabelas ==
SELECT c.relname, pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
       pg_size_pretty(pg_relation_size(c.oid)) AS so_tabela
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
 ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 15;"

main "$@" 2>&1 | awk -v max="$MAX_LINES" '
  { if (length($0) > 2000) $0 = substr($0, 1, 2000) " [linha cortada]"; print }
  NR >= max { print "[saída cortada em " max " linhas]"; exit }'
rc=${PIPESTATUS[0]}
[ "$rc" = 141 ] && rc=0
exit "$rc"
