# Intervenção base

Intervenção num servidor com tudo o que o despiste lê e com as alterações que a equipa já faz pelo Jarvis: reiniciar, recarregar, parar ou arrancar a aplicação, cópias de segurança, correção de permissões e a atualização da plataforma passo a passo. Cada alteração pede a tua aprovação antes de correr. Fora do Jarvis, não altera nada.

## Âmbito

- Serve qualquer servidor guardado no Argos, e entras como o teu utilizador SSH.
- As leituras são as do despiste: o mesmo catálogo de comandos e de scripts, os mesmos segredos fora de alcance (`.env`, `wmcp.env`, `database.yml`, `application*.yml`, `secrets*.yml` e a pasta `secrets/`, `credentials*`, `master.key`, chaves privadas, `.pgpass`, `/proc/<pid>/environ`).
- As alterações são só os comandos do catálogo do Jarvis, sempre pelo caminho completo `/usr/local/sbin/jarvis run script <comando>`, exatamente como o catálogo os escreve (com `sudo` só nos que o catálogo põe com `sudo`).
- Ficam de fora: `systemctl`, `monit` e `nginx -s` para reiniciar ou parar (usa `app/restart`, `app/reload`, `app/stop`, `app/start` e `app/monitor_service`), `kill`, `rails runner`, `rails console`, `rake`, editar ficheiros, instalar pacotes fora do Jarvis e `curl` para fora do servidor.
- Os comandos interativos do Jarvis nunca correm por aqui, porque esperam por um teclado: `accounts/migrate`, `system/install_wmcp_server`, `system/renew_postgresql_certificates` e `update_app/production`. Passa-os ao operador com `ask_operator`.
- Se o pedido precisar de algo que esta intervenção não cobre, diz isso e para. Um runbook próprio pode acrescentar o que falta.

## Como trabalhar

1. Começa como no despiste: `snapshot.sh` e as leituras que o problema pedir, com as notas (`note`) de hipóteses, achados e acontecimentos.
2. Antes da primeira alteração, propõe o plano com `propose_plan`: cada comando do Jarvis que vais correr, por ordem, o que muda no servidor e a verificação só de leitura que fazes a seguir. Nada altera o servidor antes de o plano ser aprovado, e uma mudança ao plano precisa de nova aprovação.
3. Um comando de cada vez. Depois de cada alteração, corre a verificação do plano e julga o resultado antes do seguinte.
4. Um comando do Jarvis acabou bem com código de saída 0 e sem nenhuma linha `ERROR` sobre o seu trabalho. Um `WARNING` que o próprio output explica como esperado segue em frente e fica no resumo; qualquer outro para e pergunta. Um JSON como `["User not found"]` com código 2 é o Jarvis a recusar: nada correu, diz o que significa e pergunta.
5. Se o `sudo` pedir password, para e diz isso. Nunca peças, escrevas nem contornes uma password.
6. No fim, uma nota `kind` summary com o que foi feito e o estado em que o servidor ficou, e uma nota `kind` action por cada coisa que fica por fazer.

## Atualização da plataforma

O Jarvis diz os passos; não os tires da memória nem de uma atualização anterior.

1. `/usr/local/sbin/jarvis version`. Sem comando, ou numa versão mais antiga do que a 3, a atualização não corre por aqui: passa ao operador, com `ask_operator`, a instalação do `wmcp-server` (`system/install_wmcp_server`) e espera que ele diga que acabou.
2. `/usr/local/sbin/jarvis run script diagnostics/update_steps --user=<utilizador>` dá os comandos de cada fase, por ordem. O `<utilizador>` é a parte antes de `@wiremaze.com` do email de quem faz a atualização; se não o souberes, pergunta.
3. Corre o diagnóstico e as versões publicadas que esses comandos indicam. Pergunta ao operador a versão e a lane, e depois corre o resumo da atualização com elas. Mostra o resumo e os avisos, e pergunta se avança e, quando há migrações, se há cópia de segurança recente das bases de dados.
4. O plano (`propose_plan`) é a lista de passos do resumo, por ordem. Cada passo corre como o Jarvis o dá, com `--timing=true` no fim; a verificação de um passo, quando existe, corre logo a seguir.
5. Se um passo falhar, o output mostra as opções (`What now:`), cada uma com o seu comando. Pergunta ao operador qual quer e corre só essa, como está escrita. Nunca repitas com outras opções nem reponhas a cópia de segurança quando o output diz que as bases de dados já mudaram.
6. No fim, a verificação da atualização (`diagnostics/update_checkup`) e um resumo: versão e lane antes e depois, os avisos e o que ficou por fazer.

## Para correres na tua sessão SSH

Tudo o que não podes correr (um comando interativo, um `sudo` que pede password, uma correção fora do Jarvis) vai para o operador com `ask_operator` e fica no resumo final numa secção com este título, a dizer sempre que é ele quem o corre, na sua sessão SSH, e o que espera ver.

## Quando algo falha

| Sintoma | Causa provável | O que reportar |
| --- | --- | --- |
| A chamada é recusada pela policy | O comando não está no catálogo do despiste nem no do Jarvis, ou é interativo | O comando e o motivo; o comando do catálogo que serve, ou passa-o ao operador |
| `sudo: a password is required` | O teu utilizador não tem sudo sem password para esse comando | O comando, para o operador correr |
| `jarvis: command not found` ou versão antiga | O `wmcp-server` não está instalado ou está desatualizado | Passa a instalação ao operador e para |
| Código 2 com um JSON `["…"]` | O Jarvis recusou o pedido (utilizador, versão ou lane errados) | O que o Jarvis respondeu, e pergunta o valor certo |
| Um passo com `ERROR` | O passo falhou no servidor | O output e as opções que ele mostra; pergunta antes de qualquer outra coisa |
