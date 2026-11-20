/**
 * Direct knowledge docs through the HTTP routes: indexing, shrinking updates, deletion, site removal,
 * validation and the admin test chat.
 */
import { describe, expect, test } from 'bun:test';
import worker from '../src/index';
import type { Env } from '../src/types';
import { EMBEDDING_DIMENSIONS } from '../src/services/ai';
import { createCtx, createEnv } from './helpers';

const REMOTE = 'https://docflare-ai.example.workers.dev';

async function call(env: Env, path: string, method = 'GET', body?: unknown) {
  const res = await worker.fetch(
    new Request(`${REMOTE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    createCtx().ctx,
  );
  return { res, body: (await res.json()) as Record<string, any> };
}

/** Text long enough for several ~350-token chunks. */
function longText(paragraphs: number): string {
  return Array.from(
    { length: paragraphs },
    (_, i) => `## Section ${i}\n` + `Gói trang điểm cô dâu số ${i} có giá ${i + 1}.000.000 đồng, bao gồm thử makeup và làm tóc. `.repeat(12),
  ).join('\n\n');
}

function setup() {
  const ctx = createEnv();
  ctx.sqlite.run(`INSERT INTO sites (id, domain, sitemap_url) VALUES ('shop', 'shop.example.com', 'https://shop.example.com/s.xml')`);
  return ctx;
}

const kbIds = (vectors: Map<string, VectorizeVector>, docId: string) =>
  [...vectors.keys()].filter((id) => id.startsWith(`kb-${docId}-`));

describe('knowledge docs', () => {
  test('create indexes one vector per chunk with kb metadata', async () => {
    const { env, vectorize } = setup();
    const { res, body } = await call(env, '/api/sites/shop/knowledge', 'POST', {
      title: 'Bảng giá',
      content: longText(6),
      category: 'pricing',
    });

    expect(res.status).toBe(201);
    const id = body.doc.id as string;
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    expect(body.chunksIndexed).toBeGreaterThan(1);
    expect(body.doc.chunkCount).toBe(body.chunksIndexed);
    expect(kbIds(vectorize.vectors, id)).toHaveLength(body.chunksIndexed);

    const vector = vectorize.vectors.get(`kb-${id}-0`);
    expect(vector?.namespace).toBe('shop');
    expect(vector?.metadata).toMatchObject({ siteId: 'shop', pageId: `kb-${id}`, url: `kb:${id}`, title: 'Bảng giá', chunk: 0 });

    const list = await call(env, '/api/sites/shop/knowledge');
    expect(list.body.docs).toHaveLength(1);
    expect(list.body.docs[0]).toMatchObject({ id, title: 'Bảng giá', category: 'pricing', chunkCount: body.chunksIndexed });
    expect(list.body.docs[0].content).toBeUndefined();

    const one = await call(env, `/api/sites/shop/knowledge/${id}`);
    expect(one.body.doc.content).toBe(longText(6).trim());
  });

  test('update re-chunks and deletes stale trailing vectors', async () => {
    const { env, vectorize } = setup();
    const created = await call(env, '/api/sites/shop/knowledge', 'POST', { title: 'FAQ', content: longText(6) });
    const id = created.body.doc.id as string;
    const before = created.body.chunksIndexed as number;

    const updated = await call(env, '/api/sites/shop/knowledge', 'POST', { id, title: 'FAQ', content: 'Short answer: we open at 9am every day.', category: 'faq' });

    expect(updated.res.status).toBe(200);
    expect(updated.body.chunksIndexed).toBe(1);
    expect(updated.body.doc.category).toBe('faq');
    expect(kbIds(vectorize.vectors, id)).toEqual([`kb-${id}-0`]);
    expect(vectorize.deleted).toHaveLength(before - 1);
  });

  test('delete removes every vector and the row', async () => {
    const { env, vectorize, sqlite } = setup();
    const created = await call(env, '/api/sites/shop/knowledge', 'POST', { title: 'Policy', content: longText(4), category: 'policy' });
    const id = created.body.doc.id as string;

    const { body } = await call(env, `/api/sites/shop/knowledge/${id}`, 'DELETE');

    expect(body).toEqual({ deleted: true, vectorsDeleted: created.body.chunksIndexed });
    expect(kbIds(vectorize.vectors, id)).toHaveLength(0);
    expect(sqlite.query('SELECT COUNT(*) AS n FROM knowledge_docs').get()).toEqual({ n: 0 });
    expect((await call(env, `/api/sites/shop/knowledge/${id}`)).res.status).toBe(404);
  });

  test('reindex rewrites the vectors of an existing doc', async () => {
    const { env, vectorize } = setup();
    const created = await call(env, '/api/sites/shop/knowledge', 'POST', { title: 'T', content: 'Opening hours are 9am to 6pm daily.' });
    const id = created.body.doc.id as string;
    vectorize.vectors.clear();

    const { body } = await call(env, `/api/sites/shop/knowledge/${id}/reindex`, 'POST');
    expect(body.chunksIndexed).toBe(1);
    expect(vectorize.vectors.has(`kb-${id}-0`)).toBe(true);
  });

  test('deleting the site removes its knowledge docs and their vectors', async () => {
    const { env, vectorize, sqlite } = setup();
    const created = await call(env, '/api/sites/shop/knowledge', 'POST', { title: 'Giá', content: longText(3) });
    const id = created.body.doc.id as string;

    const { body } = await call(env, '/api/sites/shop', 'DELETE');

    expect(body.vectorsDeleted).toBe(created.body.chunksIndexed);
    expect(kbIds(vectorize.vectors, id)).toHaveLength(0);
    expect(sqlite.query('SELECT COUNT(*) AS n FROM knowledge_docs').get()).toEqual({ n: 0 });
  });

  test('validates title, content, category, ids and the site', async () => {
    const { env } = setup();
    const post = (body: unknown, site = 'shop') => call(env, `/api/sites/${site}/knowledge`, 'POST', body);

    expect((await post({ title: '', content: 'x' })).body.code).toBe('invalid_knowledge');
    expect((await post({ title: 'a'.repeat(201), content: 'x' })).body.code).toBe('invalid_knowledge');
    expect((await post({ title: 'a', content: 'x'.repeat(50_001) })).body.code).toBe('invalid_knowledge');
    expect((await post({ title: 'a', content: 'x', category: 'menu' })).body.code).toBe('invalid_knowledge');
    expect((await post({ id: 'nope', title: 'a', content: 'x' })).body.code).toBe('invalid_doc_id');
    expect((await post({ id: 'a'.repeat(32), title: 'a', content: 'x' })).res.status).toBe(404);
    expect((await post({ title: 'a', content: 'x' }, 'missing')).body.code).toBe('site_not_found');
  });

  test('requires the admin token', async () => {
    const { env } = setup();
    const res = await worker.fetch(new Request(`${REMOTE}/api/sites/shop/knowledge`), env, createCtx().ctx);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/sites/:siteId/test-chat', () => {
  test('answers without an origin check and without logging the query', async () => {
    const { env, sqlite, vectorize } = setup();
    (vectorize.index as unknown as { query: () => Promise<unknown> }).query = async () => ({
      matches: [{ id: 'kb-x-0', score: 0.8, metadata: { siteId: 'shop', pageId: 'kb-x', url: 'kb:x', title: 'Bảng giá', chunk: 0, text: 'Giá 1.000.000' } }],
      count: 1,
    });

    const { res, body } = await call(env, '/api/sites/shop/test-chat', 'POST', { question: 'Giá bao nhiêu?' });

    expect(res.status).toBe(200);
    expect(body.answer).toBe('test answer');
    expect(body.sources).toEqual([{ index: 1, url: 'kb:x', title: 'Bảng giá', score: 0.8 }]);
    expect(sqlite.query('SELECT COUNT(*) AS n FROM queries').get()).toEqual({ n: 0 });
  });
});

describe('knowledge saves that fail midway leave no untracked vectors', () => {
  test('a create whose D1 insert fails writes no vectors', async () => {
    const { env, vectorize, sqlite } = setup();
    sqlite.exec(`CREATE TRIGGER no_insert BEFORE INSERT ON knowledge_docs BEGIN SELECT RAISE(ABORT, 'D1 down'); END`);

    const { res } = await call(env, '/api/sites/shop/knowledge', 'POST', { title: 'Giá', content: longText(3) });

    expect(res.status).toBe(500);
    expect(vectorize.vectors.size).toBe(0);
    expect(sqlite.query('SELECT COUNT(*) AS n FROM knowledge_docs').get()).toEqual({ n: 0 });
  });

  test('a create whose vector write fails removes its row and any vectors written', async () => {
    const { env, vectorize, sqlite } = setup();
    const index = vectorize.index as unknown as { upsert: (batch: VectorizeVector[]) => Promise<unknown> };
    const upsert = index.upsert.bind(index);
    index.upsert = async (batch) => {
      await upsert(batch.slice(0, 1)); // part of the batch lands, then the call fails
      throw new Error('Vectorize unavailable');
    };

    const { res } = await call(env, '/api/sites/shop/knowledge', 'POST', { title: 'Giá', content: longText(6) });

    expect(res.status).toBe(500);
    expect(vectorize.vectors.size).toBe(0);
    expect(sqlite.query('SELECT COUNT(*) AS n FROM knowledge_docs').get()).toEqual({ n: 0 });
  });

  test('an update whose D1 write fails still tracks every vector, so deleting the doc removes them all', async () => {
    const { env, vectorize, sqlite } = setup();
    const created = await call(env, '/api/sites/shop/knowledge', 'POST', { title: 'FAQ', content: 'Short answer: we open at 9am.' });
    const id = created.body.doc.id as string;
    expect(created.body.chunksIndexed).toBe(1);
    sqlite.exec(`CREATE TRIGGER no_content_update BEFORE UPDATE OF content ON knowledge_docs BEGIN SELECT RAISE(ABORT, 'D1 down'); END`);

    const failed = await call(env, '/api/sites/shop/knowledge', 'POST', { id, title: 'FAQ', content: longText(6) });

    expect(failed.res.status).toBe(500);
    const written = kbIds(vectorize.vectors, id).length;
    expect(written).toBeGreaterThan(1);
    const row = sqlite.query('SELECT chunk_count, content FROM knowledge_docs WHERE id = ?1').get(id) as { chunk_count: number; content: string };
    expect(row.content).toBe('Short answer: we open at 9am.'); // old content kept
    expect(row.chunk_count).toBeGreaterThanOrEqual(written);

    sqlite.exec('DROP TRIGGER no_content_update');
    await call(env, `/api/sites/shop/knowledge/${id}`, 'DELETE');
    expect(kbIds(vectorize.vectors, id)).toHaveLength(0);
  });
});


/** Hold every embedding call until `release()`; `reached` resolves when the first one starts. */
function holdEmbeddings(ai: ReturnType<typeof createEnv>['ai']) {
  let release!: () => void;
  let reachedResolve!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const reached = new Promise<void>((r) => (reachedResolve = r));
  ai.state.handler = async (_model, inputs) => {
    reachedResolve();
    await gate;
    return { data: (inputs.text as string[]).map(() => new Array(EMBEDDING_DIMENSIONS).fill(0.01)) };
  };
  return { release, reached };
}

describe('knowledge saves racing a delete leave no vector without a row', () => {
  test('a doc deleted while its create is still embedding: the create cleans up its vectors', async () => {
    const { env, vectorize, sqlite, ai } = setup();
    const hold = holdEmbeddings(ai);
    const creating = call(env, '/api/sites/shop/knowledge', 'POST', { title: 'Giá', content: longText(6) });
    await hold.reached;

    const listed = await call(env, '/api/sites/shop/knowledge');
    const id = listed.body.docs[0].id as string;
    const deleted = await call(env, `/api/sites/shop/knowledge/${id}`, 'DELETE');
    expect(deleted.res.status).toBe(200);
    hold.release();
    const created = await creating;

    expect(created.res.status).toBe(404);
    expect(sqlite.query('SELECT COUNT(*) AS n FROM knowledge_docs').get()).toEqual({ n: 0 });
    expect(vectorize.vectors.size).toBe(0);
  });

  test('a delete that removed the vectors but not yet the row when the create wrote its vectors', async () => {
    const { env, vectorize, sqlite, ai } = setup();
    const hold = holdEmbeddings(ai);
    const creating = call(env, '/api/sites/shop/knowledge', 'POST', { title: 'Giá', content: longText(6) });
    await hold.reached;
    const id = (await call(env, '/api/sites/shop/knowledge')).body.docs[0].id as string;

    // The delete stops right after its vector deletion, before it removes the row.
    const index = vectorize.index as unknown as { deleteByIds: (ids: string[]) => Promise<unknown> };
    const deleteByIds = index.deleteByIds.bind(index);
    let resumeDelete!: () => void;
    const deleteHeld = new Promise<void>((r) => (resumeDelete = r));
    let vectorsDeleted!: () => void;
    const deleteReached = new Promise<void>((r) => (vectorsDeleted = r));
    let first = true;
    index.deleteByIds = async (ids) => {
      const result = await deleteByIds(ids);
      if (first) {
        first = false;
        vectorsDeleted();
        await deleteHeld;
      }
      return result;
    };
    const deleting = call(env, `/api/sites/shop/knowledge/${id}`, 'DELETE');
    await deleteReached;

    hold.release();
    const created = await creating; // its vectors land after the delete's vector deletion
    resumeDelete();
    expect((await deleting).res.status).toBe(200);

    expect(created.res.status).toBe(404);
    expect(sqlite.query('SELECT COUNT(*) AS n FROM knowledge_docs').get()).toEqual({ n: 0 });
    expect(vectorize.vectors.size).toBe(0);
  });

  test('a doc deleted while its update or reindex is embedding: no vectors stay behind', async () => {
    for (const reindex of [false, true]) {
      const { env, vectorize, sqlite, ai } = setup();
      const created = await call(env, '/api/sites/shop/knowledge', 'POST', { title: 'FAQ', content: longText(2) });
      const id = created.body.doc.id as string;
      const hold = holdEmbeddings(ai);
      const saving = reindex
        ? call(env, `/api/sites/shop/knowledge/${id}/reindex`, 'POST')
        : call(env, '/api/sites/shop/knowledge', 'POST', { id, title: 'FAQ', content: longText(8) });
      await hold.reached;
      expect((await call(env, `/api/sites/shop/knowledge/${id}`, 'DELETE')).res.status).toBe(200);
      hold.release();

      expect((await saving).res.status).toBe(404);
      expect(sqlite.query('SELECT COUNT(*) AS n FROM knowledge_docs').get()).toEqual({ n: 0 });
      expect(vectorize.vectors.size).toBe(0);
    }
  });
});
