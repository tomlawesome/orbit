export function testWorkers(options?: {
  env?: Record<string, string | undefined>;
  cpus?: number;
  cpuMax?: string | undefined;
}): { maxWorkers: number };
