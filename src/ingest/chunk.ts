/**
 * Chunking for embedding.
 *
 * Splits on structural boundaries first (markdown headings, then paragraphs)
 * and only falls back to hard slicing when a single block is oversized. Chunks
 * that respect structure retrieve noticeably better than fixed-width windows,
 * and personal notes are heavily heading-structured.
 */

export interface Chunk {
  index: number;
  content: string;
  tokenEstimate: number;
}

const TARGET = 1200; // characters, roughly 300 tokens
const OVERLAP = 150;
const MAX = 2400;

function hardSplit(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    out.push(text.slice(i, i + MAX));
    i += MAX - OVERLAP;
  }
  return out;
}

export function chunkText(raw: string): Chunk[] {
  const text = raw.replace(/\r\n/g, '\n').trim();
  if (!text) return [];
  if (text.length <= TARGET) {
    return [{ index: 0, content: text, tokenEstimate: Math.ceil(text.length / 4) }];
  }

  // Prefer markdown section boundaries, then blank lines.
  let blocks = text.split(/\n(?=#{1,6}\s)/g);
  if (blocks.length === 1) blocks = text.split(/\n{2,}/g);

  const chunks: string[] = [];
  let buffer = '';

  const flush = () => {
    const t = buffer.trim();
    if (t) chunks.push(t);
    buffer = '';
  };

  for (const block of blocks) {
    if (block.length > MAX) {
      flush();
      chunks.push(...hardSplit(block));
      continue;
    }
    if (buffer.length + block.length > TARGET) {
      flush();
      // Carry a tail of the previous chunk so a fact split across a boundary
      // is still retrievable from either side.
      const prev = chunks[chunks.length - 1];
      if (prev && prev.length > OVERLAP) buffer = prev.slice(-OVERLAP) + '\n';
    }
    buffer += (buffer ? '\n\n' : '') + block;
  }
  flush();

  return chunks
    .filter((c) => c.trim().length > 20)
    .map((content, index) => ({
      index,
      content,
      tokenEstimate: Math.ceil(content.length / 4),
    }));
}
