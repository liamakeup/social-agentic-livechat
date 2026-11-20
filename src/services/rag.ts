/**
 * Shared retrieval-augmented generation pipeline used by /api/chat, the admin test chat and the
 * social livechat agent: embed → vector search → (rerank) → diversify → generate.
 */
import type { AppConfig, ChatMessage, Env, RetrievedChunk, Source } from '../types';
import { buildRagMessages, embedQuery, generateHybridAnswer, rerankChunks, toSources } from './ai';
import type { AppSettings } from './settings';
import { MAX_TOP_K, diversify, searchChunks } from './vectorize';

export const NO_CONTEXT_ANSWER =
  "I couldn't find anything about that in this documentation. Try rephrasing your question or using different keywords.";
/** Without the reranker, over-fetch this many times TOP_K so the per-page cap still has candidates. */
const OVERFETCH_FACTOR = 3;

/** Retrieval: vector candidates → (cross-encoder rerank) → at most MAX_CHUNKS_PER_PAGE per page. */
export async function retrieve(
  env: Env,
  config: AppConfig,
  siteId: string,
  question: string,
): Promise<{ chunks: RetrievedChunk[]; sources: Source[] }> {
  const queryVector = await embedQuery(env.AI, question);
  const candidateCount = config.rerank ? MAX_TOP_K : Math.min(config.topK * OVERFETCH_FACTOR, MAX_TOP_K);
  const candidates = await searchChunks(env.VECTOR_INDEX, siteId, queryVector, candidateCount);
  const ranked = config.rerank ? await rerankChunks(env.AI, question, candidates) : candidates;
  const chunks = diversify(ranked, config.topK);
  return { chunks, sources: toSources(chunks) };
}

/**
 * Full non-streaming answer. The LLM is skipped (NO_CONTEXT_ANSWER) when nothing relevant was
 * retrieved, which saves quota; callers can check `chunks.length` to detect that case.
 */
export async function answerQuestion(
  env: Env,
  config: AppConfig,
  settings: AppSettings,
  site: { id: string; domain: string },
  question: string,
  history: ChatMessage[] = [],
): Promise<{ answer: string; sources: Source[]; chunks: RetrievedChunk[] }> {
  const { chunks, sources } = await retrieve(env, config, site.id, question);
  if (chunks.length === 0) return { answer: NO_CONTEXT_ANSWER, sources, chunks };
  const messages = buildRagMessages(question, chunks, history, site.domain, settings.prompt.systemPrompt);
  const answer = await generateHybridAnswer(env.AI, messages, settings.fallback);
  return { answer, sources, chunks };
}
