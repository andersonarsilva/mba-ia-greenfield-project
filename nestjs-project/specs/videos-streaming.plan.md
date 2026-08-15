---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.10
target_file: test/videos-streaming.e2e-spec.ts
---

# GET /videos/:publicId/stream + GET /videos/:publicId/download Test Plan

## Application Overview

A reprodução e o download são servidos por URLs pré-assinadas emitidas pela API: o cliente é redirecionado ao object storage, que atende requisições com header `Range` respondendo `206 Partial Content` nativamente. Nenhum byte de vídeo passa pela API. Ambos exigem que o vídeo esteja em `ready` e pertençam ao canal do usuário autenticado; o download difere apenas por forçar `Content-Disposition: attachment`.

## Test Scenarios

### 1. Streaming

**Setup:** `beforeEach` trunca `videos`, `channels`, `users`; bootstrap do módulo de teste reproduzindo os globals de `main.ts`; usuário com canal e access token; um vídeo processado até `status` igual a `ready`, com `storage_key` apontando para um arquivo-fixture presente no storage.

#### 1.1. dono-obtem-url-de-streaming

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-08-04T21:48:41Z

**Steps:**
  1. GET /videos/:publicId/stream com Authorization Bearer do dono, sem seguir redirecionamento
    - expect: status 302
    - expect: header `Location` aponta para o endpoint do object storage, contendo os parâmetros de assinatura
    - expect: a resposta da API não contém bytes do vídeo — apenas o redirecionamento

#### 1.2. url-assinada-atende-range-com-206

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-08-04T21:48:41Z

**Steps:**
  1. GET /videos/:publicId/stream e capturar a URL do header `Location`
    - expect: status 302
  2. Requisitar a URL capturada com header `Range: bytes=0-1023`
    - expect: status 206
    - expect: header `Content-Range` descreve o intervalo servido e o tamanho total do objeto
    - expect: o corpo tem exatamente 1024 bytes e coincide com os primeiros 1024 bytes do arquivo-fixture
  3. Requisitar a mesma URL com um segundo intervalo, não inicial
    - expect: status 206 e o corpo coincide com o intervalo pedido — reprodução por seek não exige o arquivo completo

#### 1.3. rejeita-streaming-de-video-nao-pronto

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-08-04T21:48:41Z

**Steps:**
  1. GET /videos/:publicId/stream de um vídeo em `status` igual a `draft`
    - expect: status 409
    - expect: body contém `errorCode` igual a `VIDEO_NOT_READY`
  2. GET /videos/:publicId/stream de um vídeo em `status` igual a `error`
    - expect: status 409
    - expect: body contém `errorCode` igual a `VIDEO_NOT_READY`

#### 1.4. nao-dono-nao-faz-streaming

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-08-04T21:48:41Z

**Steps:**
  1. GET /videos/:publicId/stream com Authorization Bearer de um segundo usuário, dono de outro canal
    - expect: status 404
    - expect: body contém `errorCode` igual a `VIDEO_NOT_FOUND`
  2. GET /videos/:publicId/stream sem header Authorization
    - expect: status 401

#### 1.5. url-expirada-perde-acesso

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-08-04T21:48:41Z

**Steps:**
  1. Obter a URL de streaming e aguardar o vencimento da janela de expiração configurada (janela curta no ambiente de teste)
    - expect: a requisição à URL vencida é recusada pelo storage
    - expect: nenhum byte do objeto é servido após a expiração

### 2. Download

**Setup:** mesmo bootstrap da seção 1; vídeo em `ready` com título contendo espaços e acentos, para exercitar a derivação do nome do arquivo.

#### 2.1. dono-obtem-url-de-download-com-attachment

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-08-04T21:48:41Z

**Steps:**
  1. GET /videos/:publicId/download com Authorization Bearer do dono, sem seguir redirecionamento
    - expect: status 302
    - expect: header `Location` contém o parâmetro que força `Content-Disposition` como `attachment`
    - expect: o nome de arquivo embutido deriva do título do vídeo e é seguro para header HTTP
  2. Requisitar a URL capturada
    - expect: a resposta traz `Content-Disposition: attachment` com o nome derivado
    - expect: o conteúdo baixado é idêntico ao arquivo-fixture original

#### 2.2. rejeita-download-de-video-nao-pronto

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-08-04T21:48:41Z

**Steps:**
  1. GET /videos/:publicId/download de um vídeo em `status` igual a `processing`
    - expect: status 409
    - expect: body contém `errorCode` igual a `VIDEO_NOT_READY`

#### 2.3. nao-dono-nao-baixa

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-08-04T21:48:41Z

**Steps:**
  1. GET /videos/:publicId/download com Authorization Bearer de um segundo usuário, dono de outro canal
    - expect: status 404
    - expect: body contém `errorCode` igual a `VIDEO_NOT_FOUND`
  2. GET /videos/:publicId/download sem header Authorization
    - expect: status 401
