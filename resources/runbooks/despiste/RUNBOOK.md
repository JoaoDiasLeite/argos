# Despiste de servidor

Diagnóstico só de leitura de um servidor: recolhe o estado do sistema, dos serviços, da aplicação, dos registos e da base de dados para encontrar a causa de um problema. Não altera nada no servidor. Qualquer correção sai como recomendação, para seres tu a decidir e a correr.

## Âmbito

- Serve qualquer servidor guardado no Argos, e entras como o teu utilizador SSH. O que esse utilizador não pode ler falha sem efeito.
- Só leitura, sem exceções. Ficam de fora: reiniciar, parar ou arrancar serviços (systemctl, monit, nginx -s), matar processos, `rails runner`, `rails console`, `rake`, o menu e o `run` do Jarvis, `EXPLAIN ANALYZE`, `strace`, `gdb`, `tcpdump`, comandos interativos (`top`, `less`, `vi`, `watch`) e `curl` com efeitos ou para fora do servidor.
- Nunca leias nem mostres segredos: `.env`, `wmcp.env`, `database.yml`, `secrets*.yml`, `credentials*`, `master.key`, chaves e certificados privados, `.pgpass`, `/proc/<pid>/environ`. A policy recusa-os; não procures outro caminho para lá chegar. Para uma variável `WMCP_*` usa `env-get.sh`, que mascara as que têm PASS, SECRET, TOKEN ou KEY no nome.
- Se o pedido precisar de algo que este despiste não cobre, diz isso e para.

## Como trabalhar

1. Nesta versão a sessão começa por um `propose_plan` aprovado. O primeiro passo é um plano curto só de leituras: que hipóteses vais testar e com que scripts ou comandos.
2. Começa sempre por `snapshot.sh`. Junta numa chamada o sistema, a carga, a memória, os discos, os serviços falhados, os processos que mais consomem, as portas, os reboots, os OOM e o HTTP local.
3. Mantém uma lista curta de hipóteses. Para cada uma, diz que evidência a confirmou ou a afastou, com a linha de output que o mostra.
4. Prefere os scripts a muitos comandos soltos, porque cada execução custa cerca de 2 segundos:
   - `proc-inspect.sh <pid|nome>`: árvore, sessão, `wchan`, descritores, sockets e limites de um processo.
   - `app-status.sh [/home/<utilizador>/www/<app>]`: ficheiros de PID face aos processos vivos, órfãos, sockets face ao upstream do nginx, versão, monit, `puma.log` e HTTP.
   - `log-window.sh <ficheiro> '<AAAA-MM-DD HH:MM>' '<AAAA-MM-DD HH:MM>' [regex]` e `log-rate.sh <access.log> '<de>' '<até>'`: um log numa janela de tempo, com os rodados.
   - `pg-health.sh [bd]` e `pg-query.sh <bd> '<sql>'`: estado do PostgreSQL e uma query de leitura (SELECT, WITH, SHOW, EXPLAIN sem ANALYZE).
   - `env-get.sh <utilizador> <WMCP_VARIAVEL>` e `tls-check.sh <host[:porta]> [SNI]`.
5. Os comandos soltos são simples: sem pipes, sem `*`, `~` nem `$`, e com caminhos absolutos (por exemplo `/home/wiremaze/www/smile-saas/log/puma.log`). Para ler um ficheiro usa a ferramenta de leitura, não `cat`.
6. Para no ponto em que a causa está demonstrada. Termina com: causa provável, evidência, o que fica por confirmar e a correção recomendada.

## Correções e leituras com privilégios

Nunca tentes uma correção, nem com outro comando parecido. Os comandos `sudo -n` de leitura correm sozinhos; se o sudo pedir password, não insistas. Em ambos os casos apresenta o comando exato e o motivo numa secção com este título:

### Para correres na tua sessão SSH

Diz sempre, de forma explícita, que és tu, operador, quem corre o comando, na tua própria sessão SSH, e o que esperas ver. Exemplo: "Para correres tu na tua sessão SSH: `sudo systemctl restart pumactl_smile-saas`. Motivo: o processo do ficheiro de PID morreu e o monit não o consegue arrancar. Depois, cola aqui o resultado de `app-status.sh`." Nunca escrevas um comando solto sem dizer quem o corre.

## Pedidos ambíguos

Se o pedido tiver mais do que uma leitura, pergunta antes de agir. "Levanta a aplicação" tanto pode ser arrancá-la (fora deste despiste, fica para ti) como fazer o levantamento do seu estado. Não adivinhes.

## Quando algo falha

| Sintoma | Causa provável | O que reportar |
| --- | --- | --- |
| A chamada é recusada pela policy | O comando não está no catálogo, tem pipes, globs ou `~`, ou toca num ficheiro de segredos | O comando e o motivo da recusa; propõe o script ou o comando do catálogo que serve, ou passa-o para "Para correres na tua sessão SSH" |
| `sudo: a password is required` | O teu utilizador não tem sudo sem password para esse comando | O comando, na secção "Para correres na tua sessão SSH" |
| `Permission denied` num log | O ficheiro é só do root ou de outro grupo | O caminho; sugere o journal ou o comando com sudo para correres tu |
| `command not found` ou "não instalado" | A ferramenta não existe neste servidor (por exemplo `sar`, `iostat`, `pstree`) | Que falta, e segue com a alternativa disponível; não instales nada |
