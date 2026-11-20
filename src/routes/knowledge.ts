/**
 * Direct knowledge docs (price lists, FAQ, policies) and the admin test chat, mounted under the
 * admin-only /api/sites router:
 *   GET    /:siteId/knowledge
 *   GET    /:siteId/knowledge/:docId
 *   POST   /:siteId/knowledge                 create (201) or update (200) + index
 *   DELETE /:siteId/knowledge/:docId
 *   POST   /:siteId/knowledge/:docId/reindex
 *   POST   /:siteId/test-chat                 RAG answer without origin check, daily limit or logging
 */
import type { Hono } from 'hono';
import { loadConfig } from '../config';
import { Db, newId, type KnowledgeCategory, type KnowledgeDocRow, type KnowledgeDocSummary } from '../db/schema';
import { readJson, requireQuestion, requireSite, requireSiteId, sanitizeHistory } from '../http';
import { countKnowledgeChunks, deleteKnowledgeDocVectors, indexKnowledgeDoc } from '../services/indexer';
import { answerQuestion } from '../services/rag';
import { loadSettings } from '../services/settings';
import { HttpError, type AppBindings, type ChatResponse, type Env } from '../types';

export const MAX_KNOWLEDGE_CONTENT_CHARS = 50_000;
export const MAX_KNOWLEDGE_TITLE_CHARS = 200;
const CATEGORIES: readonly KnowledgeCategory[] = ['pricing', 'faq', 'policy', 'general'];
const DOC_ID_PATTERN = /^[a-f0-9]{32}$/;

function requireDocId(value: unknown): string {
  if (typeof value !== 'string' || !DOC_ID_PATTERN.test(value)) {
    throw new HttpError(400, 'docId must be 32 hexadecimal characters', 'invalid_doc_id');
  }
  return value;
}

function docView(doc: KnowledgeDocSummary | KnowledgeDocRow) {
  return {
    id: doc.id,
    title: doc.title,
    category: doc.category,
    chunkCount: doc.chunk_count,
    contentLength: 'content' in doc ? doc.content.length : doc.content_length,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

async function requireDoc(db: Db, siteId: string, docId: string): Promise<KnowledgeDocRow> {
  const doc = await db.getKnowledgeDoc(siteId, docId);
  if (!doc) throw new HttpError(404, 'Knowledge doc not found', 'knowledge_not_found');
  return doc;
}

/**
 * A save's closing D1 write found the doc gone or being deleted (`written` false): the vectors this save
 * wrote may have landed after the delete removed the doc's vectors, so remove ids 0..slots-1 again.
 */
async function discardIfDeleted(env: Env, written: boolean, docId: string, slots: number): Promise<void> {
  if (written) return;
  await deleteKnowledgeDocVectors(env, docId, slots);
  throw new HttpError(404, 'Knowledge doc was deleted while it was being saved', 'knowledge_not_found');
}

function parseDocBody(body: Record<string, unknown>): { title: string; content: string; category: KnowledgeCategory } {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title || title.length > MAX_KNOWLEDGE_TITLE_CHARS) {
    throw new HttpError(400, `title is required (at most ${MAX_KNOWLEDGE_TITLE_CHARS} characters)`, 'invalid_knowledge');
  }
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content || content.length > MAX_KNOWLEDGE_CONTENT_CHARS) {
    throw new HttpError(400, `content is required (at most ${MAX_KNOWLEDGE_CONTENT_CHARS} characters)`, 'invalid_knowledge');
  }
  const category =
    body.category === undefined || body.category === null || body.category === '' ? 'general' : body.category;
  if (!CATEGORIES.includes(category as KnowledgeCategory)) {
    throw new HttpError(400, `category must be one of ${CATEGORIES.join(', ')}`, 'invalid_knowledge');
  }
  return { title, content, category: category as KnowledgeCategory };
}

export function registerKnowledgeRoutes(sites: Hono<AppBindings>): void {
  sites.get('/:siteId/knowledge', async (c) => {
    const siteId = requireSiteId(c.req.param('siteId'));
    const db = new Db(c.env.DB);
    await requireSite(db, siteId);
    return c.json({ docs: (await db.listKnowledgeDocs(siteId)).map(docView) });
  });

  sites.get('/:siteId/knowledge/:docId', async (c) => {
    const siteId = requireSiteId(c.req.param('siteId'));
    const docId = requireDocId(c.req.param('docId'));
    const doc = await requireDoc(new Db(c.env.DB), siteId, docId);
    return c.json({ doc: { ...docView(doc), content: doc.content } });
  });

  /**
   * Create (no id) or update (id) a doc. The D1 row always tracks at least every vector that may exist
   * (its chunk_count is raised before vectors are written), so a failure midway never leaves vectors
   * that deleting the doc or the site would miss. A failed create removes its vectors and row again.
   * A delete flags the doc first (deleting = 1), and every save ends with a D1 write that only succeeds
   * on an unflagged doc; when it does not, the save removes its own vectors and answers 404. So no
   * vector outlives its doc, whatever the order of a save and a delete.
   */
  sites.post('/:siteId/knowledge', async (c) => {
    const siteId = requireSiteId(c.req.param('siteId'));
    const db = new Db(c.env.DB);
    await requireSite(db, siteId);
    const body = (await readJson<Record<string, unknown> | null>(c)) ?? {};
    const fields = parseDocBody(body);
    const planned = countKnowledgeChunks(fields.content);

    if (body.id !== undefined && body.id !== null && body.id !== '') {
      const existing = await requireDoc(db, siteId, requireDocId(body.id));
      const slots = Math.max(existing.chunk_count, planned);
      await discardIfDeleted(c.env, await db.setKnowledgeChunkCount(siteId, existing.id, slots), existing.id, 0);
      const chunks = await indexKnowledgeDoc(c.env, { id: existing.id, site_id: siteId, ...fields }, existing.chunk_count);
      const written = await db.updateKnowledgeDoc({ id: existing.id, site_id: siteId, ...fields, chunk_count: chunks });
      await discardIfDeleted(c.env, written, existing.id, Math.max(slots, chunks));
      const doc = await requireDoc(db, siteId, existing.id);
      return c.json({ doc: docView(doc), chunksIndexed: chunks });
    }

    const id = newId();
    await db.insertKnowledgeDoc({ id, site_id: siteId, ...fields, chunk_count: planned });
    let chunks: number;
    try {
      chunks = await indexKnowledgeDoc(c.env, { id, site_id: siteId, ...fields }, 0);
    } catch (err) {
      try {
        await deleteKnowledgeDocVectors(c.env, id, planned);
        await db.deleteKnowledgeDoc(siteId, id);
      } catch (cleanupErr) {
        // The row still tracks the vectors, so deleting the doc later cleans up.
        console.error(
          JSON.stringify({ event: 'knowledge.cleanup_failed', id, message: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) }),
        );
      }
      throw err;
    }
    await discardIfDeleted(c.env, await db.setKnowledgeChunkCount(siteId, id, chunks), id, Math.max(planned, chunks));
    const doc = await requireDoc(db, siteId, id);
    return c.json({ doc: docView(doc), chunksIndexed: chunks }, 201);
  });

  sites.delete('/:siteId/knowledge/:docId', async (c) => {
    const siteId = requireSiteId(c.req.param('siteId'));
    const docId = requireDocId(c.req.param('docId'));
    const db = new Db(c.env.DB);
    // Flag first (a doc whose earlier delete was interrupted is flagged already and can be deleted again).
    const chunkCount = await db.markKnowledgeDocDeleting(siteId, docId);
    if (chunkCount === null) throw new HttpError(404, 'Knowledge doc not found', 'knowledge_not_found');
    const vectorsDeleted = await deleteKnowledgeDocVectors(c.env, docId, chunkCount);
    await db.deleteKnowledgeDoc(siteId, docId);
    return c.json({ deleted: true, vectorsDeleted });
  });

  sites.post('/:siteId/knowledge/:docId/reindex', async (c) => {
    const siteId = requireSiteId(c.req.param('siteId'));
    const docId = requireDocId(c.req.param('docId'));
    const db = new Db(c.env.DB);
    const existing = await requireDoc(db, siteId, docId);
    const slots = Math.max(existing.chunk_count, countKnowledgeChunks(existing.content));
    await discardIfDeleted(c.env, await db.setKnowledgeChunkCount(siteId, docId, slots), docId, 0);
    const chunks = await indexKnowledgeDoc(c.env, existing, existing.chunk_count);
    await discardIfDeleted(c.env, await db.setKnowledgeChunkCount(siteId, docId, chunks), docId, Math.max(slots, chunks));
    return c.json({ doc: docView(await requireDoc(db, siteId, docId)), chunksIndexed: chunks });
  });

  sites.post('/:siteId/test-chat', async (c) => {
    const siteId = requireSiteId(c.req.param('siteId'));
    const db = new Db(c.env.DB);
    const site = await requireSite(db, siteId);
    const body = (await readJson<Record<string, unknown> | null>(c)) ?? {};
    const question = requireQuestion(body.question);
    const history = sanitizeHistory(body.history);
    const settings = await loadSettings(c.env);
    const { answer, sources } = await answerQuestion(c.env, loadConfig(c.env), settings, site, question, history);
    const response: ChatResponse = { id: crypto.randomUUID(), answer, sources };
    return c.json(response);
  });
}
