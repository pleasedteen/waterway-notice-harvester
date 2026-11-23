/**
 * 跨实例协同相关错误。
 */

/** 租约已被其他实例接管，当前实例的迟到写入/心跳被拒绝 */
export class LeaseLostError extends Error {
  constructor(
    public readonly sourceId: string,
    public readonly expectedToken: number,
    detail: string,
  ) {
    super(detail);
    this.name = 'LeaseLostError';
  }
}

/** 来源正被其他实例持有且未超过接管时限，本次获取被拒（同源并发限制） */
export class LeaseBusyError extends Error {
  constructor(
    public readonly sourceId: string,
    public readonly busyOwnerId: string,
  ) {
    super(`来源 ${sourceId} 正由实例 ${busyOwnerId} 采集中（未到接管时限）`);
    this.name = 'LeaseBusyError';
  }
}
