---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-08-04 18:35:59.091079534 -0300"
  docs/phases/phase-03-videos/library-refs.md: "2026-08-04 18:35:59.090526821 -0300"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-04 18:34:18.153376823 -0300"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-08-04 18:17:20.947451299 -0300"
  docs/decisions/technical-decisions-next-frontend-config-base.md: "2026-08-04 18:17:20.947451299 -0300"
  docs/decisions/technical-decisions-next-frontend-msw-foundation.md: "2026-08-04 18:17:20.947451299 -0300"
  docs/decisions/technical-decisions-next-frontend-openapi-typing.md: "2026-08-04 18:17:20.947451299 -0300"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar armazenamento de arquivos e processamento em segundo plano para vídeos: upload de até 10GB sem impacto na performance com pré-cadastro automático do vídeo como rascunho, processamento automático após o upload (extração de duração e metadados) com geração de thumbnail a partir de um frame, URL única por vídeo sem conflito, reprodução via streaming sem download completo e download do vídeo pelo usuário.

---

## Step Implementations

### SI-03.1 — Provisionar storage e fila no Compose

**Description:** Subir MinIO e RabbitMQ junto da stack existente e provisionar o bucket com a regra de lifecycle, de forma idempotente e declarativa.

**Technical actions:**

1. Adicionar serviço `minio` ao `compose.yaml` — imagem `minio/minio`, portas API/console, volume nomeado e healthcheck (per `phase-03-videos/TD-07`)
2. Adicionar serviço `rabbitmq` ao `compose.yaml` — imagem `rabbitmq` com plugin de management, volume nomeado e healthcheck (per `phase-03-videos/TD-01`)
3. Adicionar serviço one-shot `minio-init` (imagem `minio/mc`) que roda `mc mb --ignore-existing` no bucket e `mc ilm` com `AbortIncompleteMultipartUpload`, dependendo do healthcheck do `minio` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-08`)
4. Declarar as chaves novas no `.env` / `.env.example` — endpoint, credenciais e bucket do storage, e URL do broker — usando nomes de serviço do Compose como host, nunca `localhost`

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose ps` mostra `minio`, `rabbitmq` e `db` com status `running` e healthchecks saudáveis
- O bucket de vídeos existe após `docker compose up -d`, sem erro em execuções repetidas (idempotência do `minio-init`)
- A regra de lifecycle `AbortIncompleteMultipartUpload` está presente no bucket e é consultável via `mc ilm ls`
- A UI de management do RabbitMQ responde na porta publicada

---

### SI-03.2 — Configuração tipada e validação de env para storage e fila

**Description:** Expor endpoint/credenciais do storage e URL do broker como configs namespaced e tipadas, validadas no boot — seguindo o padrão fixado na Fase 01.

**Technical actions:**

1. Criar `src/config/storage.config.ts` com `registerAs('storage', () => ({ ... }))` — endpoint, credenciais, bucket, `forcePathStyle` e expiração das URLs pré-assinadas (per `## Inherited Conventions`, phase 01)
2. Criar `src/config/queue.config.ts` com `registerAs('queue', () => ({ ... }))` — URL do broker, nomes de exchange/fila/DLQ e limite de retries (per `phase-03-videos/TD-01`)
3. Estender `src/config/env.validation.ts` com as chaves novas no schema Joi, marcando-as `required()` (per `## Inherited Conventions`, phase 01)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `env.validation.ts` | Unit: schema rejeita chaves ausentes/malformadas e aceita o conjunto completo | `src/config/env.validation.spec.ts` |

**Dependencies:** SI-03.1 — os serviços precisam existir para que as chaves apontem para hosts reais

**Acceptance criteria:**

- A aplicação falha no boot com mensagem explícita nomeando a chave quando uma variável obrigatória de storage ou fila está ausente
- As configs são injetáveis via `ConfigType<typeof storageConfig>` / `ConfigType<typeof queueConfig>` sem `any`
- Nenhum host de serviço aparece como `localhost` na configuração efetiva dentro do container

---

### SI-03.3 — Entidade Video e migration

**Description:** Criar a tabela de vídeos ligada ao canal, com o ciclo de status, as chaves de storage e o contrato de metadados definidos no Data Model.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — colunas e constraints exatamente como em `## Technical Specifications` → `### Data Model` → `#### Video`, com `@ManyToOne` para `Channel` via `@JoinColumn({ name: 'channel_id' })` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-06`)
2. Criar `src/videos/videos.constants.ts` com o enum de status (`draft`, `uploaded`, `processing`, `ready`, `error`) `as const` e o alfabeto/tamanho do `public_id` (per `phase-03-videos/TD-06`, `phase-03-videos/TD-04`)
3. Gerar a migration `<timestamp>-CreateVideos.ts` em `src/database/migrations/` — tabela, FK para `channels`, índice único em `public_id`, índice em `channel_id` e índice composto `(status, created_at)`
4. Criar `src/videos/videos.module.ts` registrando `TypeOrmModule.forFeature([Video])` e importar `VideosModule` em `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: unique em `public_id`, default `draft` em `status`, FK para `channels`, nullability das colunas de metadados | `src/videos/entities/video.entity.integration-spec.ts` |
| `VideosModule` | Unit: teste de compilação do módulo (DI wiring) | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.2 — o módulo depende das configs registradas

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` e `npm run migration:revert` a remove sem deixar resíduo
- Inserir dois vídeos com o mesmo `public_id` viola a constraint única
- Um vídeo inserido sem `status` explícito nasce com `draft`
- Inserir vídeo com `channel_id` inexistente viola a FK

---

### SI-03.4 — StorageService: adapter S3/MinIO

**Description:** Encapsular o storage S3-compatível num serviço único que abre/assina/completa/aborta multipart e assina URLs de leitura — a única porta do sistema para o object storage.

**Technical actions:**

1. Instalar `@aws-sdk/client-s3` e `@aws-sdk/s3-request-presigner` nas versões fixadas em `library-refs.md`
2. Criar `src/storage/storage.service.ts` — cliente com `endpoint`, `forcePathStyle: true` e credenciais vindos de `storageConfig`; métodos `createMultipartUpload`, `signUploadParts`, `completeMultipartUpload`, `abortMultipartUpload` e `getSignedDownloadUrl` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-05`)
3. Criar `src/storage/storage.keys.ts` — derivação determinística de `videos/{videoId}/original.{ext}` e `videos/{videoId}/thumbnail.jpg` (per `phase-03-videos/TD-07`)
4. Criar `src/storage/storage.module.ts` exportando `StorageService` e importá-lo em `VideosModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `storage.keys.ts` | Unit: derivação de chave por extensão e caracteres inesperados no filename | `src/storage/storage.keys.spec.ts` |
| `StorageService` | Integration contra o MinIO do Compose: ciclo multipart completo (create → signed PUT de parte → complete), abort, e URL assinada de leitura servindo `Range`/`206` | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: teste de compilação do módulo | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.2 — consome `storageConfig`

**Acceptance criteria:**

- Um objeto enviado em partes via as URLs assinadas fica íntegro no bucket após o complete (mesmo tamanho e conteúdo do original)
- `abortMultipartUpload` remove as partes: `ListParts` do mesmo `UploadId` passa a falhar
- Uma requisição com header `Range` à URL assinada de leitura responde `206` com apenas o intervalo pedido
- Nenhum método do serviço recebe ou devolve o conteúdo do arquivo — apenas chaves, URLs e identificadores

---

### SI-03.5 — Topologia AMQP e publisher da fila

**Description:** Declarar exchange, fila de trabalho e dead-letter queue e expor um publisher tipado para o job de processamento.

**Technical actions:**

1. Instalar `amqplib` na versão fixada em `library-refs.md`
2. Criar `src/queue/queue.service.ts` — conexão e canal com listeners de `error` e `handler-error` em ambos, `assertExchange('dlx')` + fila DLQ + `assertQueue` da fila de trabalho com `deadLetterExchange`/`deadLetterRoutingKey`, e `publish` com `persistent: true` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-06`)
3. Criar `src/queue/queue.types.ts` com o payload de `video.process` exatamente como em `## Technical Specifications` → `### Events/Messages`
4. Criar `src/queue/queue.module.ts` exportando `QueueService`, com desligamento gracioso do canal/conexão via `OnModuleDestroy`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueService` | Integration contra o RabbitMQ do Compose: topologia declarada (fila, DLX, DLQ), publish persistente entregue ao consumidor, e mensagem com `nack` sem requeue roteada para a DLQ com header `x-death` | `src/queue/queue.service.integration-spec.ts` |
| `QueueModule` | Unit: teste de compilação do módulo | `src/queue/queue.module.spec.ts` |

**Dependencies:** SI-03.2 — consome `queueConfig`

**Acceptance criteria:**

- Após o boot, a fila de trabalho e a DLQ existem no broker com a política de dead-lettering configurada
- Uma mensagem publicada é recebida por um consumidor conectado à fila de trabalho
- Uma mensagem rejeitada com `nack` sem requeue aparece na DLQ carregando o histórico em `x-death`
- Derrubar e subir o broker não deixa a aplicação em estado inválido: a publicação volta a funcionar após a reconexão

---

### SI-03.6 — Endpoints de iniciar upload e consulta do vídeo

**Description:** Pré-cadastrar o vídeo como rascunho com URL única e devolver as URLs pré-assinadas de parte, além de expor a consulta do estado do processamento.

**Route:** POST /videos/uploads, GET /videos/:publicId
**Test Specs:** see `nestjs-project/specs/videos-upload-initiate.plan.md`

**Technical actions:**

1. Instalar `nanoid` na versão fixada em `library-refs.md` (linha CJS — a partir da v4 o pacote é ESM-only e quebra o build CommonJS) e criar `src/videos/public-id.generator.ts` com `customAlphabet` URL-safe de 11 caracteres (per `phase-03-videos/TD-04`)
2. Criar `src/videos/dto/initiate-upload.dto.ts` com as regras de `### API Contracts` → `#### Validation Rules — videos`, e o DTO de resposta correspondente
3. Implementar `VideosService.initiateUpload` — cria a linha `draft` com `public_id`, resolve o canal do usuário autenticado, abre o multipart via `StorageService`, calcula o tamanho de parte e assina as partes; retry na violação de unicidade do `public_id` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-04`)
4. Implementar `VideosService.findByPublicIdForOwner` — busca por `public_id` restrita ao canal do usuário, lançando `VideoNotFoundException` quando não encontrado ou de outro dono (per `### Authorization Matrix`)
5. Criar `src/videos/videos.controller.ts` com `POST /videos/uploads` e `GET /videos/:publicId` e as exceções de domínio novas em `src/common/exceptions/domain.exception.ts` (`VIDEO_NOT_FOUND`, `FILE_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`), seguindo `### Error Catalog`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `public-id.generator.ts` | Unit: tamanho, alfabeto URL-safe e ausência de colisão em lote | `src/videos/public-id.generator.spec.ts` |
| `VideosService` | Unit: ramos de `initiateUpload` (limite de tamanho, content-type não suportado, retry de colisão) com repositório e storage mockados | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration: persistência da linha `draft` com `public_id` único e vínculo ao canal do usuário | `src/videos/videos.service.integration-spec.ts` |

Cenários E2E dos endpoints são externos a esta tabela — vivem no spec referenciado em `**Test Specs:**`.

**Dependencies:** SI-03.3 (entidade), SI-03.4 (storage)

**Acceptance criteria:**

- `POST /videos/uploads` com payload válido retorna `201` com `public_id` de 11 caracteres, `status: "draft"`, `upload_id` e a lista de partes assinadas
- `POST /videos/uploads` com `size_bytes` acima de 10GB retorna `413` com `errorCode: "FILE_TOO_LARGE"`
- `POST /videos/uploads` com `content_type` não suportado retorna `415` com `errorCode: "UNSUPPORTED_MEDIA_TYPE"`
- `POST /videos/uploads` sem access token retorna `401` e nenhuma linha é criada
- `GET /videos/:publicId` de vídeo de outro canal retorna `404` com `errorCode: "VIDEO_NOT_FOUND"` — indistinguível da resposta para um `publicId` inexistente
- Ao iniciar o upload, a linha do vídeo já existe no banco com `status = draft` antes de qualquer byte ser enviado

---

### SI-03.7 — Endpoints de completar e abortar upload

**Description:** Fechar o multipart, transicionar o vídeo para `uploaded` e publicar o job de processamento; e oferecer o cancelamento cooperativo do upload.

**Route:** POST /videos/:publicId/uploads/complete, DELETE /videos/:publicId/uploads
**Test Specs:** see `nestjs-project/specs/videos-upload-complete.plan.md`

**Technical actions:**

1. Criar `src/videos/dto/complete-upload.dto.ts` validando `parts[].part_number` e `parts[].etag` conforme `#### Validation Rules — videos`
2. Implementar `VideosService.completeUpload` — guarda de status (`draft`), `CompleteMultipartUpload` via `StorageService`, transição para `uploaded` com `storage_key` preenchida e `upload_id` limpo, tudo numa transação (per `phase-03-videos/TD-02`, `phase-03-videos/TD-06`)
3. Publicar `video.process` via `QueueService` após a transação confirmar, com o payload de `### Events/Messages` (per `phase-03-videos/TD-01`)
4. Implementar `VideosService.abortUpload` — `AbortMultipartUpload` no storage e remoção da linha `draft` (per `phase-03-videos/TD-08`)
5. Expor `POST /videos/:publicId/uploads/complete` e `DELETE /videos/:publicId/uploads` no controller, com a exceção `INVALID_VIDEO_STATUS` no catálogo de erros

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Unit: guarda de status em `completeUpload`/`abortUpload` e ordem publicar-depois-de-commitar, com storage e fila mockados | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration: transição `draft → uploaded` persistida com `storage_key` preenchida e `upload_id` nulo; abort remove a linha e as partes | `src/videos/videos.service.integration-spec.ts` |
| Fluxo upload → fila | Integration contra MinIO e RabbitMQ do Compose: completar o upload publica exatamente uma mensagem `video.process` com o `videoId` correto | `src/videos/videos-upload-flow.integration-spec.ts` |

Cenários E2E dos endpoints são externos a esta tabela — vivem no spec referenciado em `**Test Specs:**`.

**Dependencies:** SI-03.5 (fila), SI-03.6 (iniciar upload)

**Acceptance criteria:**

- `POST /videos/:publicId/uploads/complete` com as partes corretas retorna `200` com `status: "uploaded"` e o objeto final íntegro no bucket
- Completar um upload de vídeo que não está em `draft` retorna `409` com `errorCode: "INVALID_VIDEO_STATUS"`
- Completar o upload enfileira exatamente uma mensagem `video.process`; se a transação falhar, nenhuma mensagem é publicada
- `DELETE /videos/:publicId/uploads` retorna `204`, remove a linha `draft` e aborta o multipart no storage
- Completar ou abortar upload de vídeo de outro canal retorna `404` com `errorCode: "VIDEO_NOT_FOUND"`

---

### SI-03.8 — Worker: bootstrap standalone e consumer

**Description:** Subir o worker como container próprio a partir do mesmo codebase, consumindo a fila com ack manual e sem expor servidor HTTP.

**Technical actions:**

1. Criar `src/main.worker.ts` — `NestFactory.createApplicationContext` (sem servidor HTTP) carregando um `WorkerModule` enxuto: config, TypeORM, storage e fila (per `phase-03-videos/TD-03`)
2. Criar `src/videos/worker/video-processing.consumer.ts` — assina a fila de trabalho, faz parse do payload, delega ao processador e responde `ack` no sucesso ou `nack(msg, false, false)` na falha, roteando para a DLX (per `phase-03-videos/TD-01`, `phase-03-videos/TD-06`)
3. Adicionar script `start:worker` no `package.json` e serviço `video-worker` no `compose.yaml` — imagem própria com o binário do FFmpeg instalado, dependendo dos healthchecks de `db`, `minio` e `rabbitmq` (per `phase-03-videos/TD-03`)
4. Garantir desligamento gracioso (`enableShutdownHooks`) para que mensagens em voo sejam devolvidas à fila em vez de perdidas

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingConsumer` | Unit: ack em sucesso, `nack` sem requeue em falha, e ignorar payload malformado sem derrubar o consumidor | `src/videos/worker/video-processing.consumer.spec.ts` |
| `WorkerModule` | Unit: teste de compilação do contexto do worker (DI wiring sem módulos HTTP) | `src/videos/worker/worker.module.spec.ts` |

**Dependencies:** SI-03.5 (topologia da fila)

**Acceptance criteria:**

- `docker compose up -d` sobe `video-worker` com status `running` e o container não expõe porta HTTP
- `ffprobe -version` e `ffmpeg -version` respondem dentro do container do worker
- Uma mensagem publicada na fila é consumida pelo worker e removida da fila após o `ack`
- Uma mensagem cujo processamento falha aparece na DLQ e não retorna à fila de trabalho indefinidamente

---

### SI-03.9 — Processamento: metadados, thumbnail e ciclo de status

**Description:** Extrair duração e metadados com `ffprobe`, gerar o thumbnail com `ffmpeg` e conduzir o vídeo de `uploaded` até `ready` ou `error`.

**Technical actions:**

1. Criar `src/videos/worker/ffprobe.ts` — `execFile` de `ffprobe` com `-print_format json -show_format -show_streams`, com timeout e parse tipado da saída (per `phase-03-videos/TD-03`)
2. Criar `src/videos/worker/thumbnail.ts` — `execFile` de `ffmpeg` extraindo um frame único para JPEG, com timeout (per `phase-03-videos/TD-03`)
3. Criar `src/videos/worker/video-processor.service.ts` — baixa o objeto para arquivo temporário, roda `ffprobe` e `ffmpeg`, envia o thumbnail para `thumbnail_key`, persiste as colunas tipadas mais o `metadata` bruto e transiciona para `ready`; sempre limpa os temporários (per `phase-03-videos/TD-03` Revisions)
4. Implementar a guarda de idempotência: só processa quando `status ∈ {uploaded, processing}`; marca `processing` ao iniciar e, no esgotamento do retry, `error` com `error_reason` preenchido (per `phase-03-videos/TD-06`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `ffprobe.ts` | Unit: parse da saída JSON, mapeamento para as colunas tipadas e erro em saída inválida | `src/videos/worker/ffprobe.spec.ts` |
| `VideoProcessorService` | Unit: guarda de idempotência (redelivery não reprocessa vídeo `ready`) e transição para `error` com motivo | `src/videos/worker/video-processor.service.spec.ts` |
| `VideoProcessorService` | Integration com MinIO real e um vídeo-fixture pequeno: metadados persistidos, thumbnail existente no bucket e `status = ready` | `src/videos/worker/video-processor.service.integration-spec.ts` |

**Dependencies:** SI-03.8 (worker), SI-03.7 (job publicado)

**Acceptance criteria:**

- Após o upload de um vídeo válido, o registro chega a `status = ready` com `duration_seconds`, `width`, `height`, `codec`, `container` e `size_bytes` preenchidos e `metadata` contendo a saída bruta do `ffprobe`
- O objeto de thumbnail existe no bucket sob a chave registrada em `thumbnail_key`
- Um arquivo corrompido leva o vídeo a `status = error` com `error_reason` preenchido, e a mensagem repousa na DLQ
- Reentregar a mesma mensagem de um vídeo já `ready` não altera o registro nem regrava o thumbnail
- Nenhum arquivo temporário permanece no worker após o processamento, com ou sem falha

---

### SI-03.10 — Endpoints de streaming e download

**Description:** Entregar reprodução por streaming e download emitindo URLs pré-assinadas, mantendo a API fora do caminho dos bytes.

**Route:** GET /videos/:publicId/stream, GET /videos/:publicId/download
**Test Specs:** see `nestjs-project/specs/videos-streaming.plan.md`

**Technical actions:**

1. Implementar `VideosService.getStreamUrl` — valida propriedade e `status = ready`, e assina um `GetObject` de expiração curta sobre `storage_key` (per `phase-03-videos/TD-05`)
2. Implementar `VideosService.getDownloadUrl` — mesma assinatura com `ResponseContentDisposition: attachment` derivado do título do vídeo (per `phase-03-videos/TD-05`)
3. Expor `GET /videos/:publicId/stream` e `GET /videos/:publicId/download` no controller respondendo `302` com `Location`, e adicionar `VIDEO_NOT_READY` ao catálogo de exceções de domínio
4. Documentar ambos no Swagger com o envelope de erro herdado (per `## Inherited Decisions Detail` → `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Unit: `VIDEO_NOT_READY` para status diferente de `ready`, e `attachment` presente só no download | `src/videos/videos.service.spec.ts` |
| Streaming real | Integration contra MinIO: a URL emitida responde `206` a uma requisição com `Range` e o corpo bate com o intervalo pedido | `src/videos/videos-streaming.integration-spec.ts` |

Cenários E2E dos endpoints são externos a esta tabela — vivem no spec referenciado em `**Test Specs:**`.

**Dependencies:** SI-03.9 (vídeo precisa alcançar `ready`)

**Acceptance criteria:**

- `GET /videos/:publicId/stream` de um vídeo `ready` retorna `302` com `Location` para o storage, e nenhum byte de vídeo passa pela API
- A URL emitida atende requisição com `Range` respondendo `206` com apenas o intervalo solicitado
- `GET /videos/:publicId/download` retorna URL que força download com nome de arquivo derivado do título
- Streaming ou download de vídeo que ainda não está `ready` retorna `409` com `errorCode: "VIDEO_NOT_READY"`
- Streaming ou download de vídeo de outro canal retorna `404` com `errorCode: "VIDEO_NOT_FOUND"`
- Uma URL expirada deixa de dar acesso ao objeto

---

### SI-03.11 — Sweep de uploads abandonados

**Description:** Expirar as linhas `draft` cujo upload nunca foi concluído, fechando o par com a regra de lifecycle que já limpa as partes no storage.

**Technical actions:**

1. Instalar `@nestjs/schedule` na versão fixada em `library-refs.md` e registrar `ScheduleModule.forRoot()` em `AppModule`
2. Criar `src/videos/abandoned-upload-sweep.service.ts` com `@Cron` nomeado e `waitForCompletion: true` — seleciona `draft` com `upload_id` não nulo e `created_at` além da janela configurada, aborta o multipart e marca `status = error` com `error_reason` (per `phase-03-videos/TD-08`)
3. Alinhar a janela do sweep à janela da regra `AbortIncompleteMultipartUpload` do bucket, lendo ambas da mesma chave de configuração (per `phase-03-videos/TD-07`, `phase-03-videos/TD-08`)
4. Adicionar `UPLOAD_EXPIRED` ao catálogo de exceções, retornado quando o cliente tenta completar um upload já expirado

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `AbandonedUploadSweepService` | Unit: seleção por janela (não expira draft recente, expira draft antigo) com repositório e storage mockados | `src/videos/abandoned-upload-sweep.service.spec.ts` |
| `AbandonedUploadSweepService` | Integration com banco e MinIO reais: draft antigo vira `error` e o multipart correspondente é abortado | `src/videos/abandoned-upload-sweep.service.integration-spec.ts` |

**Dependencies:** SI-03.7 (upload em aberto para expirar)

**Acceptance criteria:**

- Um vídeo `draft` com upload aberto além da janela configurada passa a `status = error` com `error_reason` explicando a expiração
- Um vídeo `draft` dentro da janela permanece intocado após a execução do sweep
- Completar um upload já expirado retorna `409` com `errorCode: "UPLOAD_EXPIRED"`
- Duas execuções consecutivas do sweep produzem o mesmo resultado (idempotência) e não sobrepõem execuções

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| public_id | varchar(11) | unique, not null — nanoid URL-safe (per `phase-03-videos/TD-04`) |
| channel_id | uuid | FK → `channels.id`, not null |
| title | varchar(255) | not null |
| status | varchar(20) | not null, default `draft` — one of `draft`, `uploaded`, `processing`, `ready`, `error` (per `phase-03-videos/TD-06`) |
| storage_key | varchar(512) | nullable — `videos/{id}/original.{ext}` (per `phase-03-videos/TD-07`) |
| thumbnail_key | varchar(512) | nullable — `videos/{id}/thumbnail.jpg` (per `phase-03-videos/TD-07`) |
| upload_id | varchar(255) | nullable — S3 multipart `UploadId` while the upload is open (per `phase-03-videos/TD-02`) |
| duration_seconds | integer | nullable — filled by the worker (per `phase-03-videos/TD-03`) |
| width | integer | nullable |
| height | integer | nullable |
| codec | varchar(50) | nullable |
| container | varchar(50) | nullable |
| size_bytes | bigint | nullable |
| metadata | jsonb | nullable — raw `ffprobe` output (per `phase-03-videos/TD-03`) |
| error_reason | text | nullable — filled when `status = error` (per `phase-03-videos/TD-06`) |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now() |

**Relations:** `Channel` has many `Video` (one-to-many); `Video` belongs to `Channel` via `channel_id` (`@ManyToOne` + `@JoinColumn({ name: 'channel_id' })`, mirroring the `Channel`→`User` convention in `src/channels/entities/channel.entity.ts`).
**Indexes:** unique on `public_id`; index on `channel_id`; index on `(status, created_at)` — supports the abandoned-draft sweep (per `phase-03-videos/TD-08`).

**Field-derivation notes:**

- `duration_seconds`, `width`, `height`, `codec`, `container`, `size_bytes` and `metadata` are the persisted metadata contract fixed by `phase-03-videos/TD-03` **Revisions** (2026-08-04): typed columns keep listing/ordering queries indexable while the raw JSON avoids a migration per new field.
- `upload_id` is cleared on `CompleteMultipartUpload` / `AbortMultipartUpload`; a non-null `upload_id` on a `draft` row is the sweep's selector (per `phase-03-videos/TD-08`).

### API Contracts

Todos os endpoints são versionados sob o prefixo já usado pelo projeto e retornam o envelope de erro estabelecido na Fase 02 (`{ statusCode, error, message }` com `errorCode` de domínio — per `## Inherited Conventions` e `src/common/filters/domain-exception.filter.ts`). O corpo do arquivo **nunca** trafega pela API (per `phase-03-videos/TD-02`).

#### POST /videos/uploads (SI-03.6)

Inicia o upload: pré-cadastra o vídeo como rascunho e abre o multipart no storage.

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- title: string, required — min 1, max 255 characters
- filename: string, required — usado apenas para derivar a extensão da `storage_key`
- size_bytes: integer, required — min 1, max 10737418240 (10GB)
- content_type: string, required — MIME type do arquivo (ex.: `video/mp4`)

**Response 201:**
- id: string (uuid)
- public_id: string — identificador público de 11 caracteres (per `phase-03-videos/TD-04`)
- status: string — sempre `draft` nesta resposta (per `phase-03-videos/TD-06`)
- upload_id: string — `UploadId` do multipart
- part_size_bytes: integer — tamanho de parte que o cliente deve usar
- parts: array of `{ part_number: integer, url: string }` — URLs pré-assinadas de `UploadPart` (per `phase-03-videos/TD-02`)

**Error responses:**
- 400 validation error: quando o corpo falha na validação do schema
- 413 FILE_TOO_LARGE: quando `size_bytes` excede 10GB
- 415 UNSUPPORTED_MEDIA_TYPE: quando `content_type` não é um formato de vídeo suportado
- 401: quando não há access token válido

---

#### POST /videos/:publicId/uploads/complete (SI-03.7)

Finaliza o multipart e publica o job de processamento.

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- parts: array of `{ part_number: integer, etag: string }`, required — ETags devolvidos por cada `PUT` de parte

**Response 200:**
- id: string (uuid)
- public_id: string
- status: string — `uploaded` (per `phase-03-videos/TD-06`)

**Error responses:**
- 404 VIDEO_NOT_FOUND: quando o `publicId` não existe ou não pertence ao canal do usuário
- 409 INVALID_VIDEO_STATUS: quando o vídeo não está em `draft`
- 400 validation error: quando `parts` está ausente ou malformado
- 401: quando não há access token válido

---

#### DELETE /videos/:publicId/uploads (SI-03.7)

Cancela um upload em andamento (caminho cooperativo — per `phase-03-videos/TD-08`).

**Request headers:**
- Authorization: Bearer {access_token}

**Response 204:** No content. O multipart é abortado no storage e a linha `draft` é removida.

**Error responses:**
- 404 VIDEO_NOT_FOUND: quando o `publicId` não existe ou não pertence ao canal do usuário
- 409 INVALID_VIDEO_STATUS: quando o vídeo não está em `draft`
- 401: quando não há access token válido

---

#### GET /videos/:publicId (SI-03.6)

Consulta o vídeo e o estado do processamento.

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:**
- id: string (uuid)
- public_id: string
- title: string
- status: string — `draft` | `uploaded` | `processing` | `ready` | `error`
- duration_seconds: integer | null
- width: integer | null
- height: integer | null
- codec: string | null
- container: string | null
- size_bytes: integer | null
- error_reason: string | null — preenchido quando `status = error`
- created_at: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: quando o `publicId` não existe ou não pertence ao canal do usuário
- 401: quando não há access token válido

---

#### GET /videos/:publicId/stream (SI-03.10)

Emite uma URL pré-assinada de leitura; o player consome o storage diretamente, que serve `Range`/`206` nativamente (per `phase-03-videos/TD-05`).

**Request headers:**
- Authorization: Bearer {access_token}

**Response 302:** `Location` com a URL pré-assinada de `GetObject` (expiração curta). Nenhum byte de vídeo trafega pela API.

**Error responses:**
- 404 VIDEO_NOT_FOUND: quando o `publicId` não existe ou não pertence ao canal do usuário
- 409 VIDEO_NOT_READY: quando `status != ready`
- 401: quando não há access token válido

---

#### GET /videos/:publicId/download (SI-03.10)

Mesma emissão de URL pré-assinada, com `response-content-disposition: attachment` (per `phase-03-videos/TD-05`).

**Request headers:**
- Authorization: Bearer {access_token}

**Response 302:** `Location` com a URL pré-assinada de `GetObject` carregando `ResponseContentDisposition`.

**Error responses:**
- 404 VIDEO_NOT_FOUND: quando o `publicId` não existe ou não pertence ao canal do usuário
- 409 VIDEO_NOT_READY: quando `status != ready`
- 401: quando não há access token válido

---

#### Validation Rules — videos

- `title`: required, min 1, max 255 characters
- `filename`: required, non-empty string
- `size_bytes`: required, integer, min 1, max 10737418240 (10GB)
- `content_type`: required, MIME type de vídeo suportado
- `parts[].part_number`: required, integer, min 1, max 10000 (limite de partes do S3)
- `parts[].etag`: required, non-empty string

### Authorization Matrix

Nesta fase todo vídeo é um rascunho não publicado do canal, portanto o acesso é **owner-only** — visibilidade/publicação chega na Fase 04 e acesso anônimo na Fase 05 (per `phase-03-videos/TD-05` **Revisions**, 2026-08-04). O guard JWT é global (Fase 02); nenhum endpoint desta fase usa `@Public()`.

| Endpoint | Anonymous | Authenticated (outro canal) | Owner |
|----------|-----------|-----------------------------|-------|
| POST /videos/uploads | ✗ | ✓ (cria no próprio canal) | ✓ |
| POST /videos/:publicId/uploads/complete | ✗ | ✗ | ✓ |
| DELETE /videos/:publicId/uploads | ✗ | ✗ | ✓ |
| GET /videos/:publicId | ✗ | ✗ | ✓ |
| GET /videos/:publicId/stream | ✗ | ✗ | ✓ |
| GET /videos/:publicId/download | ✗ | ✗ | ✓ |

Acesso de não-dono a um `publicId` existente responde `404 VIDEO_NOT_FOUND` (não `403`) para não revelar a existência do recurso.

### Error Catalog

O formato do envelope de erro foi estabelecido na Fase 02 (`phase-02-auth/TD-07`) e é herdado aqui; esta fase apenas adiciona códigos de domínio novos, seguindo o padrão de `src/common/exceptions/domain.exception.ts`.

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | `publicId` inexistente, ou vídeo pertencente a outro canal |
| INVALID_VIDEO_STATUS | 409 | Transição de status inválida (ex.: completar upload de vídeo que não está em `draft`) |
| VIDEO_NOT_READY | 409 | Streaming/download solicitado antes de `status = ready` |
| FILE_TOO_LARGE | 413 | `size_bytes` acima de 10GB |
| UNSUPPORTED_MEDIA_TYPE | 415 | `content_type` fora da lista de formatos de vídeo suportados |
| UPLOAD_EXPIRED | 409 | Upload abandonado já expirado pelo sweep/lifecycle (per `phase-03-videos/TD-08`) |

### Events/Messages

Topologia AMQP com dead-lettering nativo do broker (per `phase-03-videos/TD-01` e `phase-03-videos/TD-06`). Exchange `video` (direct) → fila `video-processing`, com `deadLetterExchange: 'dlx'` e `deadLetterRoutingKey: 'dead'` → fila `video-processing.dlq`.

#### video.process

**Payload:**

```json
{ "videoId": "uuid", "storageKey": "videos/{videoId}/original.mp4" }
```

**Producer:** `VideosService` — publica em `CompleteMultipartUpload`, imediatamente após a transição para `uploaded` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-06`)
**Consumer:** `VideoProcessingConsumer` no container do worker (per `phase-03-videos/TD-03`)
**Trigger:** upload multipart concluído com sucesso
**Delivery semantics:** at-least-once — publicação com `persistent: true`, consumo com ack manual; o consumidor é idempotente via guarda de status (só processa quando `status ∈ {uploaded, processing}`), de modo que uma redelivery não duplica efeito (per `phase-03-videos/TD-06`)

**Failure contract:** falha no processamento responde `ch.nack(msg, false, false)` — sem requeue, roteando para a DLX. O header `x-death` carrega o histórico de redeliveries e é o que limita o retry sem contador na aplicação. Esgotado o retry, a mensagem repousa em `video-processing.dlq` e o vídeo é marcado `status = error` com `error_reason` preenchido (per `phase-03-videos/TD-06`).

---

## Dependency Map

```
SI-03.1 (root — infra Compose: MinIO, RabbitMQ, provisionamento do bucket)
└── SI-03.2 — depends on SI-03.1 (config aponta para os serviços provisionados)
    ├── SI-03.3 — depends on SI-03.2 (entidade e migration consomem a config de banco)
    │   └── SI-03.6 — depends on SI-03.3 + SI-03.4 (iniciar upload precisa da entidade e do storage)
    │       └── SI-03.7 — depends on SI-03.6 + SI-03.5 (completar upload publica na fila)
    │           ├── SI-03.9 — depends on SI-03.7 + SI-03.8 (processa o job publicado)
    │           │   └── SI-03.10 — depends on SI-03.9 (streaming exige vídeo em ready)
    │           └── SI-03.11 — depends on SI-03.7 (expira uploads deixados em aberto)
    ├── SI-03.4 — depends on SI-03.2 (StorageService consome storageConfig)
    └── SI-03.5 — depends on SI-03.2 (QueueService consome queueConfig)
        └── SI-03.8 — depends on SI-03.5 (worker consome a topologia declarada)
```

Caminho crítico: SI-03.1 → SI-03.2 → SI-03.3 → SI-03.6 → SI-03.7 → SI-03.9 → SI-03.10. SI-03.4 e SI-03.5 são paralelizáveis entre si após SI-03.2; SI-03.11 pende apenas de SI-03.7 e pode ser feito em paralelo ao processamento.

---

## Deliverables

- [ ] SI-03.1 — Provisionar storage e fila no Compose
- [ ] SI-03.2 — Configuração tipada e validação de env para storage e fila
- [ ] SI-03.3 — Entidade Video e migration
- [ ] SI-03.4 — StorageService: adapter S3/MinIO
- [ ] SI-03.5 — Topologia AMQP e publisher da fila
- [ ] SI-03.6 — Endpoints de iniciar upload e consulta do vídeo
- [ ] SI-03.7 — Endpoints de completar e abortar upload
- [ ] SI-03.8 — Worker: bootstrap standalone e consumer
- [ ] SI-03.9 — Processamento: metadados, thumbnail e ciclo de status
- [ ] SI-03.10 — Endpoints de streaming e download
- [ ] SI-03.11 — Sweep de uploads abandonados

**Capacidades da fase (project-plan.md):**

- [ ] Upload de até 10GB funcional, sem que o arquivo trafegue pela API
- [ ] Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- [ ] Processamento automático após o upload: duração e metadados extraídos
- [ ] Thumbnail gerado automaticamente a partir de um frame do vídeo
- [ ] URL única por vídeo, sem conflito com outros vídeos
- [ ] Streaming funcionando sem exigir download completo (`Range` / `206`)
- [ ] Download do vídeo disponível ao dono
- [ ] Ciclo de status refletido no banco: `draft → uploaded → processing → ready | error`
- [ ] Object storage, fila e worker subindo via `docker compose` junto do backend

**Full test suites** _(todos os comandos rodam dentro do container, per `nestjs-project/CLAUDE.md`)_:

- [ ] Testes unitários e de integração passam (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] Testes e2e passam (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type-check passa (`docker compose exec nestjs-api npx tsc --noEmit` — código de saída 0)
- [ ] Lint passa (`docker compose exec nestjs-api npm run lint`)
