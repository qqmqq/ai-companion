/**
 * 按 key 串行化的最小互斥锁（Phase 4.5-E 加固）。
 *
 * 为什么需要它：
 * 转写与合成都是"查缓存 → 调 provider → 写缓存"的读-改-写流程。进程内两个并发请求
 * （例如前端连点两次、或"自动生成 + 用户显式重试"同时到达）会同时错过缓存，
 * 从而**重复调用 provider（重复付费）并产生两份媒体对象**。
 *
 * 为什么不用分布式锁/队列：本应用是单进程 + SQLite（见 4.5-B 的架构选择）。
 * 一个进程内的 keyed 队列就足以消除这个竞态，而且不会引入新的失效模式；
 * 跨进程场景不在当前架构范围内（报告里如实标注）。
 *
 * 语义：同一个 key 上的任务**串行**执行；不同 key 之间互不阻塞；
 * 前一个任务抛错不会影响后续任务（错误语义由调用方自己的 try/catch 决定）。
 */

export interface KeyedLock {
  /** 在 key 上独占执行；返回 fn 的结果（异常原样抛出，锁一定会释放） */
  runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /** 当前正在排队/执行的 key 数量（诊断用，测试也用它验证锁生效） */
  pendingCount(): number;
}

export function createKeyedLock(): KeyedLock {
  const chains = new Map<string, Promise<unknown>>();

  return {
    async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const previous = chains.get(key) ?? Promise.resolve();
      // 无论前一个任务成功还是失败，后一个都要继续（用 catch 吃掉前一个的错误状态）
      const current = previous.catch(() => undefined).then(fn);
      // 链上只保留"完成信号"，不保留结果，避免无界持有对象
      const signal = current.then(
        () => undefined,
        () => undefined,
      );
      chains.set(key, signal);
      try {
        return await current;
      } finally {
        // 只有当自己还是链尾时才清理，避免把后来者的链删掉
        if (chains.get(key) === signal) chains.delete(key);
      }
    },

    pendingCount(): number {
      return chains.size;
    },
  };
}
