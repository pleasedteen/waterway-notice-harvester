/**
 * 逐页归并检查点的确定性键与存储后端选择。
 *
 * 设计要点：
 * - 每个详情页对应一个不可变归并分片（MergeChunkDoc），分片 id 由
 *   作业/条目/页码确定性生成，提交前中断后重试只会覆盖同一个分片；
 * - 原始快照 id 同样确定性生成，使"快照已落盘但检查点未提交"窗口中的
 *   未归并原页可在恢复时按同一 id 只读复用，不必重新联网抓取；
 * - 已归并页的原页快照在恢复时不再读取：归并状态由分片折叠重建。
 */
import type { MergeChunkDoc, MergeChunkStore, Snapshot, Store } from './types.js';

/** 回退通道：没有原生 MergeChunkStore 时，分片以快照信封承载，contentType 使用该标记 */
export const MERGE_CHUNK_CONTENT_TYPE = 'application/x-collector-merge-chunk+json';

export function entryKeyOf(entryIndex: number): string {
  return `e${entryIndex}`;
}

export function chunkIdOf(jobId: string, entryKey: string, page: number): string {
  return `mc_${jobId}_${entryKey}_p${page}`;
}

export function rawSnapshotIdOf(jobId: string, entryKey: string, page: number): string {
  return `snap_${jobId}_${entryKey}_p${page}`;
}

/** 结构探测 Store 是否提供原生归并分片能力（Proxy/子类均可被探测到） */
export function asMergeChunkStore(store: Store): MergeChunkStore | null {
  const candidate = store as unknown as Partial<MergeChunkStore>;
  if (
    candidate &&
    typeof candidate.saveMergeChunk === 'function' &&
    typeof candidate.getMergeChunk === 'function'
  ) {
    return candidate as MergeChunkStore;
  }
  return null;
}

/**
 * 分片读写后端：优先原生分片文档；否则回退到现有快照接口
 * （saveSnapshot/getSnapshot），保证只认识旧 Store 接口的包装器/替身也能工作。
 * 两条路径的每次写入都只包含当前页分片，写入量与累计页数无关（等长页下为常数）。
 */
export class ChunkBackend {
  private readonly native: MergeChunkStore | null;

  constructor(
    private readonly store: Store,
    private readonly sourceId: string,
  ) {
    this.native = asMergeChunkStore(store);
  }

  get isNative(): boolean {
    return this.native !== null;
  }

  async saveChunk(chunk: MergeChunkDoc): Promise<void> {
    if (this.native) {
      await this.native.saveMergeChunk(chunk);
      return;
    }
    const envelope: Snapshot = {
      snapshotId: chunk.chunkId,
      sourceId: this.sourceId,
      revision: 'merge-chunk',
      url: `checkpoint://merge-chunk/${chunk.chunkId}`,
      fetchedAt: new Date(0).toISOString(),
      statusCode: 0,
      contentType: MERGE_CHUNK_CONTENT_TYPE,
      html: JSON.stringify(chunk),
      snapshotKind: 'merge_chunk',
    };
    await this.store.saveSnapshot(envelope);
  }

  async getChunk(chunkId: string): Promise<MergeChunkDoc | null> {
    if (this.native) return this.native.getMergeChunk(chunkId);
    const snap = await this.store.getSnapshot(chunkId);
    if (!snap || snap.contentType !== MERGE_CHUNK_CONTENT_TYPE) return null;
    try {
      return JSON.parse(snap.html) as MergeChunkDoc;
    } catch {
      return null;
    }
  }
}
