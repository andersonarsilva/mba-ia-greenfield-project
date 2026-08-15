---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: test/videos-upload-complete.e2e-spec.ts
---

# POST /videos/:publicId/uploads/complete + DELETE /videos/:publicId/uploads Test Plan

## Application Overview

O fechamento do upload completa o multipart no object storage, transiciona o vídeo de `draft` para `uploaded` e publica o job de processamento na fila — nessa ordem, com a publicação ocorrendo somente após a transação confirmar. O cancelamento cooperativo aborta o multipart e remove o rascunho. Ambos os endpoints são restritos ao dono do canal e protegidos por guarda de status.

## Test Scenarios

### 1. Completar upload

**Setup:** `beforeEach` trunca `videos`, `channels`, `users` e purga a fila de trabalho e a DLQ do broker; bootstrap do módulo de teste reproduzindo os globals de `main.ts`; usuário com canal e access token; vídeo iniciado via POST /videos/uploads com um arquivo-fixture pequeno cujas partes já foram enviadas às URLs pré-assinadas (ETags coletados).

#### 1.1. completa-upload-e-publica-job

**Covers AC:** #1, #3
**Source:** auto
**Last sync:** 2026-08-04T21:48:41Z

**Steps:**
  1. POST /videos/:publicId/uploads/complete com a lista de `parts` (`part_number` + `etag`) devolvida pelos PUTs
    - expect: status 200
    - expect: body contém `status` igual a `uploaded`
    - expect: a linha em `videos` tem `storage_key` preenchida e `upload_id` nulo
  2. Inspecionar a fila de trabalho no broker
    - expect: exatamente uma mensagem `video.process` foi publicada
    - expect: o payload da mensagem contém o `videoId` do vídeo completado e a `storageKey` correspondente
  3. Baixar o objeto final do storage pela `storage_key` registrada
    - expect: o conteúdo é idêntico ao arquivo-fixture original (mesmo tamanho e bytes)

#### 1.2. rejeita-completar-fora-de-draft

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-08-04T21:48:41Z

**Steps:**
  1. POST /videos/:publicId/uploads/complete no mesmo vídeo já completado no cenário anterior
    - expect: status 409
    - expect: body contém `errorCode` igual a `INVALID_VIDEO_STATUS`
    - expect: nenhuma nova mensagem é publicada na fila de trabalho

#### 1.3. rejeita-partes-malformadas

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-08-04T21:48:41Z

**Steps:**
  1. POST /videos/:publicId/uploads/complete com `parts` ausente
    - expect: status 400
    - expect: body reporta erro de validação nomeando `parts`
  2. POST /videos/:publicId/uploads/complete com `parts` contendo item sem `etag`
    - expect: status 400
    - expect: o vídeo permanece em `status` igual a `draft`

#### 1.4. nao-dono-nao-completa

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-08-04T21:48:41Z

**Steps:**
  1. POST /videos/:publicId/uploads/complete com Authorization Bearer de um segundo usuário, dono de outro canal
    - expect: status 404
    - expect: body contém `errorCode` igual a `VIDEO_NOT_FOUND`
    - expect: o vídeo permanece em `status` igual a `draft` e nenhuma mensagem é publicada

### 2. Abortar upload

**Setup:** mesmo bootstrap da seção 1; vídeo iniciado via POST /videos/uploads com ao menos uma parte já enviada, deixando o multipart aberto.

#### 2.1. dono-aborta-upload-em-andamento

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-08-04T21:48:41Z

**Steps:**
  1. DELETE /videos/:publicId/uploads com Authorization Bearer do dono
    - expect: status 204 sem corpo
    - expect: a linha do vídeo não existe mais na tabela `videos`
  2. Listar as partes do `UploadId` original no storage
    - expect: a operação falha — o multipart foi abortado e as partes não estão mais retidas

#### 2.2. rejeita-abortar-fora-de-draft

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-08-04T21:48:41Z

**Steps:**
  1. Completar o upload de um segundo vídeo e então DELETE /videos/:publicId/uploads sobre ele
    - expect: status 409
    - expect: body contém `errorCode` igual a `INVALID_VIDEO_STATUS`
    - expect: o vídeo permanece em `status` igual a `uploaded` e sua `storage_key` continua acessível

#### 2.3. nao-dono-nao-aborta

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-08-04T21:48:41Z

**Steps:**
  1. DELETE /videos/:publicId/uploads com Authorization Bearer de um segundo usuário, dono de outro canal
    - expect: status 404
    - expect: body contém `errorCode` igual a `VIDEO_NOT_FOUND`
    - expect: a linha do vídeo do primeiro usuário continua existindo em `draft`

#### 2.4. abortar-exige-autenticacao

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-08-04T21:48:41Z

**Steps:**
  1. DELETE /videos/:publicId/uploads sem header Authorization
    - expect: status 401
    - expect: a linha do vídeo permanece intacta
