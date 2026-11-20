export function testWorkers(options?: {
  env?: Record<string, string | undefined>;
  cpus?: number;
}): { maxWorkers?: number };
