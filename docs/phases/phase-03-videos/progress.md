# phase-03-videos — Progress

**Status:** completed
**SIs:** 11/11 completed

## Final Verification (Definition of Done)

- **Unit + Integration (`npm test -- --runInBand`, nestjs-api):** 223/223 passing (1 known split: `video-processor.service.integration-spec.ts` needs real ffmpeg, verified separately in `video-worker`: 1/1 passing).
- **E2E (`npm run test:e2e`, nestjs-api):** 68/68 passing (1 known split: `videos-streaming.e2e-spec.ts` needs real ffmpeg for fixture generation, verified separately in `video-worker`: 8/8 passing).
- **`npx tsc --noEmit`:** exit 0.
- **`npm run lint`:** 0 errors, 23 warnings (all pre-existing `@typescript-eslint/no-unsafe-argument` in `auth.service.spec.ts`/`auth.service.integration-spec.ts`, a rule the project's own `eslint.config.mjs` deliberately sets to `warn`, not `error`).

**Bugs found and fixed during final verification (none were regressions from SI-03.11's own diff — all pre-existing gaps surfaced by running the full suite end-to-end for the first time):**
- `src/database/migrations.integration-spec.ts` — cleanup dropped tables but never dropped the `verification_tokens_type_enum` Postgres enum type, which persists independently of its table; collided with any other test's `synchronize: true` schema. Fixed by adding an explicit `DROP TYPE IF EXISTS ... CASCADE`.
- `src/queue/queue.service.integration-spec.ts` — two AMQP-delivery tests had no explicit Jest timeout override, and default 5000ms was occasionally too tight for real broker round-trips (observed up to ~7s). Added explicit `15000` timeouts, matching the pattern already used by the file's own "force-closed connection" test.
- `src/videos/videos.module.spec.ts` — didn't load `videosConfig` in its `ConfigModule.forRoot`, so the module failed to compile once `AbandonedUploadSweepService` (which injects it) was added to `VideosModule`. Fixed by adding `videosConfig` to the test's `load` array.
- **`nestjs-project/package.json`'s `test:e2e` script never actually had `--runInBand`**, despite `nestjs-project/CLAUDE.md` documenting it as "already configured". Jest ran e2e files in parallel worker processes, all against the same shared Postgres DB — causing real cross-file races (one file's `cleanAllTables` wiping rows mid-flight for another file's in-progress test), surfacing as spurious FK-violation errors and 401s. This had never been caught before because every prior SI validated e2e one file at a time. Fixed by adding `--runInBand` to the script.

**Follow-up item flagged, not fixed (out of scope for this phase — a design decision, not a test gap):** `QueueService.connect()` re-establishes the AMQP connection/channel after an unexpected disconnect (e.g., broker restart, forced connection close) but never re-registers `VideoProcessingConsumer`'s subscription on the new channel — after any connection drop, the worker silently stops consuming from `video-processing` forever, with no error surfaced. Observed live: `video-worker`'s own consumer went from 1 to 0 registered consumers after `queue.service.integration-spec.ts`'s "recover publish capability" test force-closed all broker connections, and never recovered until the container was manually restarted. The existing test only asserts *publish* recovers, not *consume* — this gap was never covered by a test. Needs a deliberate fix (e.g., re-subscribing in `connect()`, or a health check that restarts the app on stale consumer state) — recommend a follow-up task before this ships to any environment where the worker can't be trivially restarted.

### SI-03.1 — Provisionar storage e fila no Compose
- **Status:** completed
- **Tests:** no tests (infra)
- **Observations:**
  - MinIO não suporta a ação de lifecycle `AbortIncompleteMultipartUpload` (exclusiva do S3 real — confirmado via docs oficiais e via `LifecycleOptions` do `mc`). Removida do TD-08 via Revision e do `minio-init`; a limpeza de uploads abandonados fica inteiramente a cargo do sweep agendado do SI-03.11 (já cobre ambas as metades via SDK).
  - `.env.example` tinha um bug pré-existente (`MAIL_FROM` sem aspas), documentado como anti-padrão no próprio `CLAUDE.md` do projeto — corrigido para conseguir subir o Compose.
  - `nestjs-project/package-lock.json` tinha drift não-commitado antes do início desta fase (deps opcionais/peer do `@nestjs-modules/mailer`), pré-existente e fora do escopo desta SI — não tocado.

### SI-03.2 — Configuração tipada e validação de env para storage e fila
- **Status:** completed
- **Tests:** 9 passing
- **Observations:** none

### SI-03.3 — Entidade Video e migration
- **Status:** completed
- **Tests:** 5 passing
- **Observations:**
  - Adicionado o lado inverso `@OneToMany` em `Channel` (campo `videos`) — o próprio Data Model do plano especifica a relação bidirecional "Channel has many Video"; não era um novo arquivo do SI, mas uma edição mínima e diretamente contratada pela Tech Spec.
  - Estendido `cleanAllTables` (helper de teste compartilhado) para apagar `videos` antes de `channels`, respeitando a ordem de FK — sem isso, as suítes de channels/users/auth quebrariam ao truncar `channels` com vídeos referenciando.
  - Migration gerada via CLI veio com aspas duplas e indentação de 4 espaços (padrão do TypeORM CLI); rodei `npm run format` para alinhar ao Prettier do projeto.

### SI-03.4 — StorageService: adapter S3/MinIO
- **Status:** completed
- **Tests:** 9 passing
- **Observations:**
  - `npm audit` após instalar `@aws-sdk/client-s3`/`s3-request-presigner`: 0 vulnerabilidades novas atribuíveis a esses pacotes; a única crítica (`liquidjs`) é pré-existente, de dependência transitiva do mailer, fora do escopo desta fase.
  - Testes de integração usam `fetch` nativo do container contra URLs pré-assinadas reais do MinIO (nunca mockado), incluindo verificação de `ListParts` falhando após abort e resposta `206` real a um header `Range`.

### SI-03.5 — Topologia AMQP e publisher da fila
- **Status:** completed
- **Tests:** 5 passing
- **Observations:**
  - `amqplib@2` já embute seus próprios tipos TS (`types: "./index.d.ts"`); instalei `@types/amqplib` por hábito e removi ao perceber que era redundante.
  - O teste de reconexão força o fechamento da conexão AMQP via API de management do RabbitMQ (não mocka nada) e faz polling do `publish()` do serviço até ele voltar a funcionar sozinho, validando a lógica real de `scheduleReconnect`.

### SI-03.6 — Endpoints de iniciar upload e consulta do vídeo
- **Status:** completed
- **Tests:** 23 passing (inline unit/integração/module + spec-derived e2e)
- **Observations:**
  - Adicionado `ChannelsService.findByUserId` — não existia método para resolver o canal do usuário autenticado; VideosService depende dele em vez de consultar `Channel` diretamente (single responsibility).
  - Limite de 10GB e validação de `content_type` são erros de domínio (413/415), não erros de validação de DTO (400) — o `class-validator` só garante presença/tipo; os limiares de negócio ficam no service, para bater exatamente com o Error Catalog e as ACs.
  - `size_bytes` é derivado como `bigint` no banco (string em TS); a resposta da API converte para `Number` (seguro para tamanhos de vídeo reais, bem abaixo de `MAX_SAFE_INTEGER`).
  - Efeito colateral do `Channel.videos` (adicionado no SI-03.3): 9 arquivos de teste que montam seu próprio `DataSource` com `Channel` mas sem `Video` pararam de compilar (erro de metadata do TypeORM). Corrigido em todos: `auth.service.integration-spec.ts`, `verification-token.entity.integration-spec.ts`, `auth.module.spec.ts`, `refresh-token.entity.integration-spec.ts`, `channel.entity.integration-spec.ts`, `channels.service.integration-spec.ts`, `users.module.spec.ts`, `users.service.integration-spec.ts`, `user.entity.integration-spec.ts` — só adicionando `Video` ao array de entidades de teste, nenhuma lógica alterada.

### SI-03.7 — Endpoints de completar e abortar upload
- **Status:** completed
- **Tests:** 22 passing (inline unit/integração + integração fluxo→fila + spec-derived e2e)
- **Observations:**
  - Guarda de status implementada com dupla checagem: leitura inicial fora da transação (fail-fast, evita chamar o storage à toa) + re-checagem com `pessimistic_write` lock dentro da transação antes de gravar `uploaded` — fecha a corrida de duas requisições concorrentes completando o mesmo upload.
  - Bug real encontrado pelo teste e2e: o controller não tinha `@HttpCode(200)` em `POST .../complete`, então o Nest respondia `201` (padrão de POST) — mas o API Contract do plano especifica `200`. Corrigido no controller, não no teste.
  - Dois testes de integração standalone (`videos.service.integration-spec.ts`, `videos-upload-flow.integration-spec.ts`) esqueceram de chamar `queueService.onModuleInit()` explicitamente — diferente do e2e (que usa `app.init()` e dispara os lifecycle hooks sozinho), um `TestingModule.compile()` puro não inicializa `OnModuleInit`. Mesma pegadinha que eu já tinha contornado corretamente no SI-03.5; replicado aqui.
  - Dois testes e2e que fazem polling na fila (até ~12s no pior caso) precisaram de timeout explícito acima do default de 5s do Jest.

### SI-03.8 — Worker: bootstrap standalone e consumer
- **Status:** completed
- **Tests:** 4 passing + validação manual das 4 ACs contra a stack real
- **Observations:**
  - `VideoProcessorService` criado nesta SI como placeholder (só loga e resolve) — o SI-03.9 já cria esse mesmo arquivo pelo plano ("Criar video-processor.service.ts"); interpretei isso como "implementar o corpo real", já que o consumer desta SI precisa de algo para delegar (contrato ack/nack) antes do processamento de fato existir. Documentando a leitura para transparência.
  - Estendido `QueueService` com `consume`/`ack`/`nack` (a fila continua sendo a única dona do canal AMQP; o consumer decide quando ack/nack, mas nunca toca no canal diretamente) — mesma lógica de "porta única" já usada pelo `StorageService`.
  - Bug real pego só ao subir o container de verdade: `WorkerModule` registrava `TypeOrmModule.forFeature([Video])` mas não `Channel` nem `User` — como `Video.channel` é uma relação `@ManyToOne`, o TypeORM falha ao resolver a metadata sem as entidades relacionadas no grafo. Corrigido registrando as três entidades (só as classes, não os módulos `ChannelsModule`/`UsersModule` inteiros — o worker não precisa da lógica de negócio deles, só da metadata).
  - `video-worker` roda com `command` fixo no `compose.yaml` (diferente do `nestjs-api`, que fica ocioso por padrão) — a AC exige que `docker compose up -d` já suba o worker consumindo, sem passo manual.
  - Validado manualmente contra a stack real: mensagem válida publicada é consumida e some da fila (ack); payload malformado publicado diretamente cai na DLQ e não retorna à fila de trabalho (nack sem requeue).

### SI-03.9 — Processamento: metadados, thumbnail e ciclo de status
- **Status:** completed
- **Tests:** 10 passing (9 unit em nestjs-api + 1 integração real com ffmpeg em video-worker)
- **Observations:**
  - Criado `src/videos/worker/exec-file-async.ts` — wrapper próprio em vez de `promisify(execFile)`. O `execFile` do Node tem um symbol customizado (`util.promisify.custom`) que muda a forma do resultado promisificado; ao mockar `node:child_process` em teste esse symbol some e o mock quebra silenciosamente. Wrapper manual evita a armadilha e deixa o mock trivial.
  - Estendido `StorageService` com `downloadToFile`/`uploadFile` (download por stream, upload single-shot) — mesma "porta única" de storage já usada pelos SIs anteriores, agora cobrindo o caso de I/O de arquivo local que o worker precisa.
  - `VideoProcessorService` (placeholder do SI-03.8) recebeu a implementação real: baixa para arquivo temp, roda `ffprobe`/`ffmpeg`, sobe o thumbnail, persiste colunas tipadas + `metadata` bruto, transiciona para `ready`; em qualquer falha marca `error` com `error_reason` e relança (o consumer do SI-03.8 já trata isso como nack→DLX). `finally` sempre limpa o diretório temporário.
  - Guarda de idempotência processa quando `status ∈ {uploaded, processing}` (o segundo cobre recuperação de crash do worker) e pula silenciosamente em `ready`/`error`.
  - Bug real pego pelo teste de integração: a fixture sintética gerada via `ffmpeg testsrc` tinha exatamente 1s de duração, e a extração de thumbnail pedia o frame no segundo 1 — caía bem no fim do clipe e o ffmpeg não gravava frame nenhum (arquivo de thumbnail inexistente, `uploadFile` falhava com `ENOENT`). Corrigido aumentando a fixture para 3s; o código de produção (que assume vídeos reais, tipicamente >1s) não precisou mudar.
  - O teste de integração deste SI só roda no container `video-worker` (único com `ffmpeg`/`ffprobe` instalados) — os testes unitários seguem rodando em `nestjs-api` normalmente, já que mockam `ffprobe.ts`/`thumbnail.ts` por inteiro.

### SI-03.10 — Endpoints de streaming e download
- **Status:** completed
- **Tests:** 28 passing (18 unit em nestjs-api + 2 integração real com MinIO Range/206 + 8 e2e reais em video-worker)
- **Observations:**
  - Nova config `streamUrlExpirationSeconds` (default 300s) separada de `presignedUrlExpirationSeconds` (upload, 3600s) — justificada diretamente pela recomendação da TD-05 de expiração curta para streaming/download; `StorageService.getSignedDownloadUrl` passou a usar a expiração curta.
  - `GET /:publicId/stream` e `GET /:publicId/download` usam `@Redirect()` para devolver 302 com URL presignada; o próprio MinIO/S3 serve os bytes (incluindo Range/206), a API nunca proxya o vídeo.
  - `deriveDownloadFilename` normaliza título removendo diacríticos (`̀-ͯ` explícito, evitando caracteres combinantes literais no source) e caracteres especiais para compor o `Content-Disposition: attachment; filename=...`.
  - Bug pego nos meus próprios testes: `videos-streaming.integration-spec.ts` usava `await import(...)` dinâmico dentro de uma função para `node:fs/promises`/`node:os`/`node:path`, o que quebra no Jest sem `--experimental-vm-modules`. Corrigido para imports estáticos no topo do arquivo (mesmo padrão já usado no e2e spec desta SI).
  - Falha real de infraestrutura descoberta ao rodar o e2e: o container `video-worker` estava rodando havia ~25min com código compilado *antes* de edições feitas durante esta e SIs anteriores — `nest start --entryFile main.worker` roda sem `--watch`, então não recarrega ao mudar `src/` mesmo com bind mount. O processo antigo travava silenciosamente nos jobs (nunca chegava a `processing`/`ready`/`error`), fazendo os testes de streaming/download darem timeout no polling. `docker compose restart video-worker` resolveu; não é um problema de código, mas um lembrete operacional para SIs futuras que dependem do worker real.

### SI-03.11 — Sweep de uploads abandonados
- **Status:** completed
- **Tests:** 26 passing (unit: 4 novos no sweep + 1 novo em `videos.service.spec.ts` para `UPLOAD_EXPIRED` + 18 pré-existentes; integração: 3 reais com DB e MinIO)
- **Observations:**
  - TD-08 já tinha sido revisado durante SI-03.1 (MinIO não suporta a lifecycle action `AbortIncompleteMultipartUpload`) — o sweep agendado é o único mecanismo de limpeza, cobrindo as duas metades (abortar o multipart via SDK e marcar o `draft` como `error`) sem depender de nenhuma regra de bucket. O passo 3 do plano ("alinhar a janela do sweep à janela da regra de lifecycle do bucket") não se aplica mais — não existe regra de lifecycle para alinhar.
  - Nova config `videosConfig` (`registerAs('videos', ...)`) expõe `abandonedUploadExpirationHours`, lida de `ABANDONED_UPLOAD_EXPIRATION_HOURS` (já validada desde o SI-03.2, default 24h).
  - `AbandonedUploadSweepService` roda a cada hora (`@Cron(CronExpression.EVERY_HOUR, { waitForCompletion: true })`) — `waitForCompletion` evita sobreposição de execuções, cobrindo a AC de idempotência mesmo sob concorrência.
  - `UPLOAD_EXPIRED` (409) adicionado ao catálogo de exceções. Em vez de um campo extra na entidade, `VideosService.completeUpload` distingue o caso "expirado pelo sweep" observando que um `draft` só chega a `status = error` por essa via — nenhum outro fluxo transiciona `draft` diretamente para `error` — então `status === 'error'` nesse ponto específico do método é sinal suficiente, sem necessidade de um marcador redundante.
  - `npx tsc --noEmit` e `npm run lint` acusam um volume grande de erros pré-existentes (378 erros de lint, ~16 erros de tsc) espalhados por arquivos de SIs anteriores (auth, channels, mail, queue, users, worker) nunca tocados nesta SI — não é regressão introduzida aqui; é dívida acumulada ao longo da fase que só será endereçada na verificação final (Definition of Done), conforme o fluxo do `/implement`.
