---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: test/videos-upload-initiate.e2e-spec.ts
---

# POST /videos/uploads + GET /videos/:publicId Test Plan

## Application Overview

O início do upload pré-cadastra o vídeo como rascunho pertencente ao canal do usuário autenticado, gera o identificador público de URL única e abre um multipart no object storage, devolvendo URLs pré-assinadas por parte. O corpo do arquivo nunca trafega pela API — o cliente envia os bytes direto ao storage. O endpoint de consulta expõe o estado do processamento e é restrito ao dono do canal.

## Test Scenarios

### 1. Iniciar upload

**Setup:** `beforeEach` trunca as tabelas `videos`, `channels`, `users`; bootstrap do módulo de teste com `Test.createTestingModule` reproduzindo os globals de `main.ts` (ValidationPipe, filtros de exceção); usuário registrado + canal criado, access token obtido via login.

#### 1.1. inicia-upload-com-payload-valido

**Covers AC:** #1, #6
**Source:** auto
**Last sync:** 2026-08-04T21:48:41Z

**Steps:**
  1. POST /videos/uploads com `title`, `filename`, `size_bytes` e `content_type` válidos e Authorization Bearer do dono
    - expect: status 201
    - expect: body contém `public_id` com exatamente 11 caracteres URL-safe
    - expect: body contém `status` igual a `draft`
    - expect: body contém `upload_id` não vazio e `part_size_bytes` inteiro positivo
    - expect: body contém `parts` como array não vazio, cada item com `part_number` e `url`
  2. Consultar a tabela `videos` pelo `public_id` retornado
    - expect: existe exatamente uma linha, com `status` igual a `draft` e `channel_id` do canal do usuário autenticado
    - expect: a linha existe mesmo sem nenhum byte ter sido enviado ao storage

#### 1.2. rejeita-arquivo-acima-do-limite

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-08-04T21:48:41Z

**Steps:**
  1. POST /videos/uploads com `size_bytes` acima de 10737418240
    - expect: status 413
    - expect: body contém `errorCode` igual a `FILE_TOO_LARGE`
    - expect: nenhuma linha é criada na tabela `videos`

#### 1.3. rejeita-content-type-nao-suportado

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-08-04T21:48:41Z

**Steps:**
  1. POST /videos/uploads com `content_type` que não é um formato de vídeo suportado
    - expect: status 415
    - expect: body contém `errorCode` igual a `UNSUPPORTED_MEDIA_TYPE`
    - expect: nenhuma linha é criada na tabela `videos`

#### 1.4. rejeita-payload-invalido

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-08-04T21:48:41Z

**Steps:**
  1. POST /videos/uploads com `title` vazio e `size_bytes` ausente
    - expect: status 400
    - expect: body reporta erro de validação nomeando os campos inválidos

#### 1.5. exige-autenticacao

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-08-04T21:48:41Z

**Steps:**
  1. POST /videos/uploads com payload válido e sem header Authorization
    - expect: status 401
    - expect: nenhuma linha é criada na tabela `videos`

### 2. Consultar vídeo

**Setup:** mesmo bootstrap da seção 1; dois usuários com canais distintos, cada um com um vídeo em `draft` criado via POST /videos/uploads.

#### 2.1. dono-consulta-proprio-video

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-08-04T21:48:41Z

**Steps:**
  1. GET /videos/:publicId do próprio vídeo com Authorization Bearer do dono
    - expect: status 200
    - expect: body contém `public_id`, `title`, `status` e `created_at`
    - expect: campos de metadados (`duration_seconds`, `width`, `height`, `codec`, `container`, `size_bytes`) vêm nulos enquanto o vídeo está em `draft`

#### 2.2. nao-dono-recebe-404-indistinguivel

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-08-04T21:48:41Z

**Steps:**
  1. GET /videos/:publicId do vídeo do outro canal com Authorization Bearer do segundo usuário
    - expect: status 404
    - expect: body contém `errorCode` igual a `VIDEO_NOT_FOUND`
  2. GET /videos/:publicId com um `publicId` que não existe em nenhum canal
    - expect: status 404
    - expect: body contém `errorCode` igual a `VIDEO_NOT_FOUND`
    - expect: a resposta é idêntica à do passo 1 — nada revela que o primeiro `publicId` existe

#### 2.3. consulta-exige-autenticacao

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-08-04T21:48:41Z

**Steps:**
  1. GET /videos/:publicId sem header Authorization
    - expect: status 401
