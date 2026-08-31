export function rpcErrorText(error: unknown) {
  const parts: string[] = [];
  let current = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
    const record = current as Record<string, unknown>;
    for (const key of ["shortMessage", "message", "details"] as const) {
      if (typeof record[key] === "string") parts.push(record[key]);
    }
    if (typeof record.code === "number" || typeof record.code === "string") parts.push(String(record.code));
    current = record.cause;
  }
  return parts.join("\n");
}

export function isRpcCapacityError(error: unknown) {
  return /Request exceeds defined limit|Limit exceeded|temporarily out of capacity|\b-32005\b/i.test(rpcErrorText(error));
}

export function isRetryableRpcError(error: unknown) {
  return isRpcCapacityError(error)
    || /RPC Request failed|HTTP request failed|fetch failed|Too Many Requests|rate limit|timeout|timed out|network error|socket|could not complete this request|No answer was obtained|\b429\b|\b50[234]\b/i.test(rpcErrorText(error));
}

export function isUnauthorizedBlockdaemonRpc(error: unknown) {
  const details = rpcErrorText(error);
  return /(?:\b401\b|Authorization Required)/i.test(details)
    && /(?:blockdaemon|HTTP request failed)/i.test(details);
}
